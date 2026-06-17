import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { Job, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import {
  CloudKeyRequestModel,
  DirectoryCreateStartRequestModel,
  DirectoryCreateStartResponseModel,
  DirectoryCreateStatusRequestModel,
  DirectoryCreateStatusResponseModel,
} from './cloud.model';
import { CloudDirectoryService } from './cloud.directory.service';
import { CloudListService } from './cloud.list.service';
import { BuildBullRedisConnectionOptions } from './cloud.utils';
import { GetStorageOwnerId } from './cloud.context';
import { NotificationService } from '@modules/notification/notification.service';
import { ArchiveJobState, NotificationType } from '@common/enums';

// ─── Job Types ──────────────────────────────────────────────────────────────

type DirectoryCreateJobData = {
  userId: string;
  ownerId: string;
  path: string;
};

type DirectoryCreateJobResult = {
  path: string;
};

// ─── Service ────────────────────────────────────────────────────────────────

/**
 * Async PLAIN folder creation as a BullMQ job (queue `cloud-directory-create`),
 * mirroring the archive create/extract pipeline so the frontend can render a
 * refresh-durable inline "creating folder…" row. The interactive conflict flow
 * (409/SKIP/KEEP_BOTH/REPLACE) runs synchronously in {@link DirectoryCreateStart}
 * (via CloudDirectoryService.ResolvePlainDirectoryTarget) before a job is
 * enqueued — only the S3 placeholder write is deferred. ENCRYPTED folders never
 * reach here (no passphrase in a Redis payload); they stay on the sync
 * `POST Cloud/Directory`.
 */
@Injectable()
export class CloudDirectoryJobService
  implements OnModuleInit, OnModuleDestroy
{
  private readonly Logger = new Logger(CloudDirectoryJobService.name);
  private readonly IsRedisEnabled =
    (process.env.REDIS_ENABLED ?? 'true').toLowerCase() !== 'false';

  private readonly CreateQueueName = 'cloud-directory-create';

  private readonly CreateJobConcurrency = Math.max(
    1,
    parseInt(process.env.DIRECTORY_CREATE_JOB_CONCURRENCY ?? '4', 10),
  );

  private CreateQueue?: Queue<DirectoryCreateJobData, DirectoryCreateJobResult>;
  private CreateWorker?: Worker<
    DirectoryCreateJobData,
    DirectoryCreateJobResult
  >;
  private CreateQueueConnection?: IORedis;
  private CreateWorkerConnection?: IORedis;

  constructor(
    private readonly CloudDirectoryService: CloudDirectoryService,
    private readonly CloudListService: CloudListService,
    private readonly NotificationService: NotificationService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ══════════════════════════════════════════════════════════════════════════

  async onModuleInit(): Promise<void> {
    if (!this.IsRedisEnabled) {
      this.Logger.warn(
        'Redis is disabled; directory-create queue will not be available.',
      );
      return;
    }

    const options = BuildBullRedisConnectionOptions();
    if (!options) {
      this.Logger.warn(
        'Redis connection options are missing; directory-create queue will not be available.',
      );
      return;
    }

    this.CreateQueueConnection = new IORedis(options);
    this.CreateWorkerConnection = new IORedis(options);

    this.CreateQueue = new Queue(this.CreateQueueName, {
      connection: this.CreateQueueConnection,
      defaultJobOptions: {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    });

    this.CreateWorker = new Worker(
      this.CreateQueueName,
      async (job) => this.ProcessCreateJob(job),
      {
        connection: this.CreateWorkerConnection,
        concurrency: this.CreateJobConcurrency,
      },
    );

    this.CreateWorker.on('error', (error) => {
      this.Logger.error('Directory creation worker error', error);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.CreateWorker) {
      await this.CreateWorker.close();
    }
    if (this.CreateQueue) {
      await this.CreateQueue.close();
    }
    if (this.CreateWorkerConnection) {
      await this.CreateWorkerConnection.quit();
    }
    if (this.CreateQueueConnection) {
      await this.CreateQueueConnection.quit();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Public API – Start
  // ══════════════════════════════════════════════════════════════════════════

  async DirectoryCreateStart(
    { Path, ConflictStrategy }: DirectoryCreateStartRequestModel,
    User: UserContext,
  ): Promise<DirectoryCreateStartResponseModel> {
    // Conflict detection + path resolution run SYNCHRONOUSLY so the interactive
    // 409 (FAIL) still reaches the client and KEEP_BOTH resolves a concrete path
    // before we enqueue. Only the S3 placeholder write is deferred to the worker.
    const resolved =
      await this.CloudDirectoryService.ResolvePlainDirectoryTarget(
        Path,
        ConflictStrategy,
        User,
      );

    // SKIP onto an existing folder = nothing to create → no job enqueued.
    if (resolved.skip) {
      return plainToInstance(DirectoryCreateStartResponseModel, {
        JobId: '',
        Path: resolved.path,
      });
    }

    this.EnsureCreateQueue();

    const jobData: DirectoryCreateJobData = {
      userId: User.Id,
      ownerId: GetStorageOwnerId(User),
      path: resolved.path,
    };

    const job = await this.CreateQueue!.add('create', jobData);

    return plainToInstance(DirectoryCreateStartResponseModel, {
      JobId: job.id?.toString() ?? '',
      Path: resolved.path,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Public API – Status (polling fallback for missed socket progress events)
  // ══════════════════════════════════════════════════════════════════════════

  async DirectoryCreateStatus(
    { JobId }: DirectoryCreateStatusRequestModel,
    User: UserContext,
  ): Promise<DirectoryCreateStatusResponseModel> {
    if (!this.CreateQueue) {
      throw new HttpException(
        'Directory creation queue is not available.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const job = await this.CreateQueue.getJob(JobId);
    if (!job) {
      throw new HttpException('Job not found.', HttpStatus.NOT_FOUND);
    }
    if (job.data.userId !== User.Id) {
      throw new HttpException('Access denied.', HttpStatus.FORBIDDEN);
    }

    const state = await job.getState();
    const percentage =
      state === ArchiveJobState.COMPLETED
        ? 100
        : state === ArchiveJobState.ACTIVE
          ? 50
          : undefined;

    return plainToInstance(DirectoryCreateStatusResponseModel, {
      JobId,
      Status: state,
      Percentage: percentage,
      Path: job.data.path,
      Error: state === ArchiveJobState.FAILED ? job.failedReason : undefined,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private – Create job processor
  // ══════════════════════════════════════════════════════════════════════════

  private async ProcessCreateJob(
    job: Job<DirectoryCreateJobData, DirectoryCreateJobResult>,
  ): Promise<DirectoryCreateJobResult> {
    const jobId = job.id?.toString() ?? '';
    const { userId, ownerId, path } = job.data;
    // ownerId is the pre-resolved storage owner; a `{ Id: ownerId }` user
    // round-trips through GetStorageOwnerId (inside CreateDirectory) back to the
    // same owner (no TeamId), so the S3 key prefix is correct for personal and
    // team owners alike. Mirrors the archive create worker.
    const user = { Id: ownerId } as UserContext;
    const folderName = path.split('/').pop() || path;

    try {
      this.NotificationService.EmitTransientToUser(
        userId,
        NotificationType.FOLDER_CREATE_PROGRESS,
        'Creating Folder',
        `Creating "${folderName}"…`,
        { JobId: jobId, Path: path },
      );

      await this.CloudDirectoryService.CreateDirectory(
        { Key: path } as CloudKeyRequestModel,
        user,
      );

      // Replicate the cache invalidation CloudService.DirectoryCreate does after
      // a successful sync create (directory thumbnail cache + list cache).
      await this.CloudListService.InvalidateDirectoryThumbnailCache(
        ownerId,
        path,
      );
      await this.CloudListService.InvalidateListCache(ownerId);

      this.NotificationService.EmitToUser(
        userId,
        NotificationType.FOLDER_CREATE_COMPLETE,
        'Folder Created',
        `"${folderName}" has been created.`,
        { JobId: jobId, Path: path },
      );

      return { path };
    } catch (error) {
      this.Logger.error(`Failed to create directory "${path}"`, error);

      this.NotificationService.EmitToUser(
        userId,
        NotificationType.FOLDER_CREATE_FAILED,
        'Folder Creation Failed',
        `Failed to create "${folderName}".`,
        { JobId: jobId, Path: path },
      );

      throw error;
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private – Helpers
  // ══════════════════════════════════════════════════════════════════════════

  private EnsureCreateQueue(): void {
    if (!this.CreateQueue) {
      throw new HttpException(
        'Directory creation queue is not available.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }
}
