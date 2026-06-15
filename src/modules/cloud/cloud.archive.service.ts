import {
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Upload } from '@aws-sdk/lib-storage';
import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { PassThrough, Readable } from 'stream';
import { Job, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import { randomUUID } from 'crypto';
import {
  CloudArchiveExtractStartRequestModel,
  CloudArchiveExtractStartResponseModel,
  CloudArchiveExtractCancelRequestModel,
  CloudArchiveExtractCancelResponseModel,
  CloudArchivePreviewRequestModel,
  CloudArchivePreviewResponseModel,
  CloudArchiveCreateStartRequestModel,
  CloudArchiveCreateStartResponseModel,
  CloudArchiveCreateCancelRequestModel,
  CloudArchiveCreateCancelResponseModel,
  CloudArchiveStatusRequestModel,
  CloudArchiveStatusResponseModel,
} from './cloud.model';
import { CloudS3Service } from './cloud.s3.service';
import { CloudMetadataService } from './cloud.metadata.service';
import { CloudDirectoryService } from './cloud.directory.service';
import { KeyBuilder, MimeTypeFromExtension } from '@common/helpers/cast.helper';
import { GetStorageOwnerId } from './cloud.context';
import {
  BuildArchiveExtractPrefix,
  BuildBullRedisConnectionOptions,
  GetArchiveFormat,
  IsInsideFolder,
  JoinKey,
  NormalizeArchiveEntryPath,
  ArchiveFormatExtension,
} from './cloud.utils';
import { RedisService } from '@modules/redis/redis.service';
import { CloudKeys } from '@modules/redis/redis.keys';
import { CloudUsageService } from './cloud.usage.service';
import { CloudListService } from './cloud.list.service';
import { ArchiveHandlerRegistry } from './archive/archive-handler.registry';
import { NotificationService } from '@modules/notification/notification.service';
import {
  ArchiveJobState,
  ArchivePhase,
  ArchiveEntryType,
  ArchiveFormat,
  NotificationType,
} from '@common/enums';
import type {
  ArchiveExtractProgress,
  ArchiveCreateProgress,
  ArchiveSafetyLimits,
  ArchiveCreateEntry,
} from './archive/archive-handler.interface';

// ─── Job Types ──────────────────────────────────────────────────────────────

type ArchiveExtractJobData = {
  userId: string;
  ownerId: string;
  key: string;
  format: ArchiveFormat;
  selectedEntries?: string[];
};

type ArchiveExtractJobResult = {
  extractedPath: string;
};

type ArchiveCreateJobData = {
  userId: string;
  ownerId: string;
  keys: string[];
  outputFormat: ArchiveFormat;
  outputKey: string;
  commonParent: string;
};

type ArchiveCreateJobResult = {
  archiveKey: string;
  archiveSize: number;
};

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class CloudArchiveService implements OnModuleInit, OnModuleDestroy {
  private readonly Logger = new Logger(CloudArchiveService.name);
  private readonly EmptyFolderPlaceholder = '.emptyFolderPlaceholder';
  private readonly IsRedisEnabled =
    (process.env.REDIS_ENABLED ?? 'true').toLowerCase() !== 'false';

  // ── Queue names ───────────────────────────────────────────────────────────
  private readonly ExtractQueueName = 'cloud-archive-extract';
  private readonly CreateQueueName = 'cloud-archive-create';

  // ── Cancel TTL ────────────────────────────────────────────────────────────
  private readonly CancelTtlSeconds = 6 * 60 * 60; // 6 hours

  // ── Extract configuration (with backward-compat fallback to ZIP_EXTRACT_*) ─
  private readonly ExtractJobConcurrency = Math.max(
    1,
    parseInt(
      process.env.ARCHIVE_EXTRACT_JOB_CONCURRENCY ??
        process.env.ZIP_EXTRACT_JOB_CONCURRENCY ??
        '1',
      10,
    ),
  );
  private readonly ExtractEntryConcurrency = Math.max(
    1,
    parseInt(
      process.env.ARCHIVE_EXTRACT_ENTRY_CONCURRENCY ??
        process.env.ZIP_EXTRACT_ENTRY_CONCURRENCY ??
        '3',
      10,
    ),
  );
  private readonly ExtractProgressEntriesStep = Math.max(
    1,
    parseInt(
      process.env.ARCHIVE_EXTRACT_PROGRESS_ENTRIES ??
        process.env.ZIP_EXTRACT_PROGRESS_ENTRIES ??
        '5',
      10,
    ),
  );
  private readonly ExtractProgressBytesStep = Math.max(
    1,
    parseInt(
      process.env.ARCHIVE_EXTRACT_PROGRESS_BYTES ??
        process.env.ZIP_EXTRACT_PROGRESS_BYTES ??
        `${5 * 1024 * 1024}`,
      10,
    ),
  );
  private readonly ExtractMaxEntries = Math.max(
    1,
    parseInt(
      process.env.ARCHIVE_EXTRACT_MAX_ENTRIES ??
        process.env.ZIP_EXTRACT_MAX_ENTRIES ??
        '2000',
      10,
    ),
  );
  private readonly ExtractMaxEntryBytes = Math.max(
    1,
    parseInt(
      process.env.ARCHIVE_EXTRACT_MAX_ENTRY_BYTES ??
        process.env.ZIP_EXTRACT_MAX_ENTRY_BYTES ??
        `${512 * 1024 * 1024}`,
      10,
    ),
  );
  private readonly ExtractMaxTotalBytes = Math.max(
    1,
    parseInt(
      process.env.ARCHIVE_EXTRACT_MAX_TOTAL_BYTES ??
        process.env.ZIP_EXTRACT_MAX_TOTAL_BYTES ??
        `${2 * 1024 * 1024 * 1024}`,
      10,
    ),
  );
  private readonly ExtractMaxCompressionRatio = Math.max(
    1,
    parseInt(
      process.env.ARCHIVE_EXTRACT_MAX_RATIO ??
        process.env.ZIP_EXTRACT_MAX_RATIO ??
        '100',
      10,
    ),
  );

  // ── Create configuration ──────────────────────────────────────────────────
  private readonly CreateJobConcurrency = Math.max(
    1,
    parseInt(process.env.ARCHIVE_CREATE_JOB_CONCURRENCY ?? '1', 10),
  );
  private readonly CreateMaxFiles = Math.max(
    1,
    parseInt(process.env.ARCHIVE_CREATE_MAX_FILES ?? '5000', 10),
  );
  private readonly CreateMaxTotalBytes = Math.max(
    1,
    parseInt(
      process.env.ARCHIVE_CREATE_MAX_TOTAL_BYTES ?? `${5 * 1024 * 1024 * 1024}`,
      10,
    ),
  );
  // ── Preview configuration ─────────────────────────────────────────────────
  private readonly PreviewMaxBytes = Math.max(
    1,
    parseInt(
      process.env.ARCHIVE_PREVIEW_MAX_BYTES ?? `${512 * 1024 * 1024}`,
      10,
    ),
  );

  // ── Queue / Worker instances ──────────────────────────────────────────────
  private ExtractQueue?: Queue<ArchiveExtractJobData, ArchiveExtractJobResult>;
  private ExtractWorker?: Worker<
    ArchiveExtractJobData,
    ArchiveExtractJobResult
  >;
  private ExtractQueueConnection?: IORedis;
  private ExtractWorkerConnection?: IORedis;

  private CreateQueue?: Queue<ArchiveCreateJobData, ArchiveCreateJobResult>;
  private CreateWorker?: Worker<ArchiveCreateJobData, ArchiveCreateJobResult>;
  private CreateQueueConnection?: IORedis;
  private CreateWorkerConnection?: IORedis;

  constructor(
    private readonly RedisService: RedisService,
    private readonly CloudS3Service: CloudS3Service,
    private readonly CloudMetadataService: CloudMetadataService,
    private readonly CloudUsageService: CloudUsageService,
    private readonly CloudListService: CloudListService,
    private readonly ArchiveHandlerRegistry: ArchiveHandlerRegistry,
    private readonly NotificationService: NotificationService,
    private readonly CloudDirectoryService: CloudDirectoryService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ══════════════════════════════════════════════════════════════════════════

  async onModuleInit(): Promise<void> {
    if (!this.IsRedisEnabled) {
      this.Logger.warn(
        'Redis is disabled; archive queues will not be available.',
      );
      return;
    }

    const options = BuildBullRedisConnectionOptions();
    if (!options) {
      this.Logger.warn(
        'Redis connection options are missing; archive queues will not be available.',
      );
      return;
    }

    // Extract queue
    this.ExtractQueueConnection = new IORedis(options);
    this.ExtractWorkerConnection = new IORedis(options);

    this.ExtractQueue = new Queue(this.ExtractQueueName, {
      connection: this.ExtractQueueConnection,
      defaultJobOptions: {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    });

    this.ExtractWorker = new Worker(
      this.ExtractQueueName,
      async (job) => this.ProcessExtractJob(job),
      {
        connection: this.ExtractWorkerConnection,
        concurrency: this.ExtractJobConcurrency,
      },
    );

    this.ExtractWorker.on('error', (error) => {
      this.Logger.error('Archive extraction worker error', error);
    });

    // Create queue
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
      this.Logger.error('Archive creation worker error', error);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ExtractWorker) {
      await this.ExtractWorker.close();
    }
    if (this.ExtractQueue) {
      await this.ExtractQueue.close();
    }
    if (this.ExtractWorkerConnection) {
      await this.ExtractWorkerConnection.quit();
    }
    if (this.ExtractQueueConnection) {
      await this.ExtractQueueConnection.quit();
    }

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
  // Public API – Extract
  // ══════════════════════════════════════════════════════════════════════════

  async ArchiveExtractStart(
    { Key, SelectedEntries }: CloudArchiveExtractStartRequestModel,
    User: UserContext,
  ): Promise<CloudArchiveExtractStartResponseModel> {
    const format = GetArchiveFormat(Key);
    if (!format) {
      throw new HttpException(
        'Unsupported archive format. Supported: .zip, .tar, .tar.gz, .tgz, .rar',
        HttpStatus.BAD_REQUEST,
      );
    }

    const handler = this.ArchiveHandlerRegistry.GetHandlerByFormat(format);
    if (!handler) {
      throw new HttpException(
        `No handler registered for format "${format}".`,
        HttpStatus.BAD_REQUEST,
      );
    }

    this.EnsureExtractQueue();

    const jobData: ArchiveExtractJobData = {
      key: Key,
      userId: User.Id,
      ownerId: GetStorageOwnerId(User),
      format,
      selectedEntries: SelectedEntries,
    };

    const job = await this.ExtractQueue!.add('extract', jobData);

    return plainToInstance(CloudArchiveExtractStartResponseModel, {
      JobId: job.id?.toString() ?? '',
      Format: format,
    });
  }

  async ArchiveExtractCancel(
    { JobId }: CloudArchiveExtractCancelRequestModel,
    User: UserContext,
  ): Promise<CloudArchiveExtractCancelResponseModel> {
    this.EnsureExtractQueue();

    const job = await this.ExtractQueue!.getJob(JobId);
    if (!job) {
      throw new HttpException('Job not found.', HttpStatus.NOT_FOUND);
    }
    if (job.data.userId !== User.Id) {
      throw new HttpException('Access denied.', HttpStatus.FORBIDDEN);
    }

    const state = await job.getState();
    if (
      state === ArchiveJobState.COMPLETED ||
      state === ArchiveJobState.FAILED
    ) {
      return plainToInstance(CloudArchiveExtractCancelResponseModel, {
        Cancelled: false,
      });
    }

    if (
      state === ArchiveJobState.WAITING ||
      state === ArchiveJobState.DELAYED
    ) {
      await job.remove();
      return plainToInstance(CloudArchiveExtractCancelResponseModel, {
        Cancelled: true,
      });
    }

    await this.RedisService.Set(
      CloudKeys.ArchiveExtractCancel(JobId),
      true,
      this.CancelTtlSeconds,
    );

    return plainToInstance(CloudArchiveExtractCancelResponseModel, {
      Cancelled: true,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Public API – Preview
  // ══════════════════════════════════════════════════════════════════════════

  async ArchivePreview(
    { Key }: CloudArchivePreviewRequestModel,
    User: UserContext,
  ): Promise<CloudArchivePreviewResponseModel> {
    const format = GetArchiveFormat(Key);
    if (!format) {
      throw new HttpException(
        'Unsupported archive format.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const handler = this.ArchiveHandlerRegistry.GetHandlerByFormat(format);
    if (!handler) {
      throw new HttpException(
        `No handler registered for format "${format}".`,
        HttpStatus.BAD_REQUEST,
      );
    }

    const sourceKey = KeyBuilder([GetStorageOwnerId(User), Key]);

    // Size guard
    const head = await this.CloudS3Service.Send(
      new HeadObjectCommand({
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        Key: sourceKey,
      }),
    );
    const totalBytes = Number(head.ContentLength ?? 0);
    if (totalBytes > this.PreviewMaxBytes) {
      throw new HttpException(
        'Archive is too large to preview.',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Download stream
    const object = await this.CloudS3Service.Send(
      new GetObjectCommand({
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        Key: sourceKey,
      }),
    );

    const body = object.Body as Readable;
    if (!body) {
      throw new HttpException(
        'Archive file is empty or unreadable.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const limits = this.BuildSafetyLimits();
    const entries = await handler.ListEntries(body, totalBytes, limits);

    return plainToInstance(CloudArchivePreviewResponseModel, {
      Key,
      Format: format,
      TotalEntries: entries.length,
      Entries: entries.map((e) => ({
        Path: e.Path,
        Type: e.Type,
        Size: e.Size,
        CompressedSize: e.CompressedSize,
        LastModified: e.LastModified?.toISOString(),
      })),
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Public API – Create
  // ══════════════════════════════════════════════════════════════════════════

  async ArchiveCreateStart(
    { Keys, Format, OutputName }: CloudArchiveCreateStartRequestModel,
    User: UserContext,
  ): Promise<CloudArchiveCreateStartResponseModel> {
    const outputFormat = (Format ?? ArchiveFormat.ZIP) as ArchiveFormat;
    const handler =
      this.ArchiveHandlerRegistry.GetHandlerByFormat(outputFormat);
    if (!handler) {
      throw new HttpException(
        `No handler registered for format "${outputFormat}".`,
        HttpStatus.BAD_REQUEST,
      );
    }
    if (!handler.SupportsCreation) {
      throw new HttpException(
        `Format "${outputFormat}" does not support archive creation.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    this.EnsureCreateQueue();

    const extension = ArchiveFormatExtension(outputFormat);
    const baseName = OutputName?.trim() || 'archive';
    const commonParent = this.GetCommonParentDirectory(Keys);
    const outputKey = JoinKey(
      commonParent,
      `${baseName}-${randomUUID()}${extension}`,
    );

    const jobData: ArchiveCreateJobData = {
      userId: User.Id,
      ownerId: GetStorageOwnerId(User),
      keys: Keys,
      outputFormat,
      outputKey,
      commonParent,
    };

    const job = await this.CreateQueue!.add('create', jobData);

    return plainToInstance(CloudArchiveCreateStartResponseModel, {
      JobId: job.id?.toString() ?? '',
      Format: outputFormat,
      OutputKey: outputKey,
    });
  }

  async ArchiveCreateCancel(
    { JobId }: CloudArchiveCreateCancelRequestModel,
    User: UserContext,
  ): Promise<CloudArchiveCreateCancelResponseModel> {
    this.EnsureCreateQueue();

    const job = await this.CreateQueue!.getJob(JobId);
    if (!job) {
      throw new HttpException('Job not found.', HttpStatus.NOT_FOUND);
    }
    if (job.data.userId !== User.Id) {
      throw new HttpException('Access denied.', HttpStatus.FORBIDDEN);
    }

    const state = await job.getState();
    if (
      state === ArchiveJobState.COMPLETED ||
      state === ArchiveJobState.FAILED
    ) {
      return plainToInstance(CloudArchiveCreateCancelResponseModel, {
        Cancelled: false,
      });
    }

    if (
      state === ArchiveJobState.WAITING ||
      state === ArchiveJobState.DELAYED
    ) {
      await job.remove();
      return plainToInstance(CloudArchiveCreateCancelResponseModel, {
        Cancelled: true,
      });
    }

    await this.RedisService.Set(
      CloudKeys.ArchiveCreateCancel(JobId),
      true,
      this.CancelTtlSeconds,
    );

    return plainToInstance(CloudArchiveCreateCancelResponseModel, {
      Cancelled: true,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Public API – Status (polling fallback for missed socket progress events)
  // ══════════════════════════════════════════════════════════════════════════

  async ArchiveStatus(
    { JobId, Kind }: CloudArchiveStatusRequestModel,
    User: UserContext,
  ): Promise<CloudArchiveStatusResponseModel> {
    const isCreate = Kind === ArchivePhase.CREATE;
    const queue = isCreate ? this.CreateQueue : this.ExtractQueue;
    if (!queue) {
      throw new HttpException(
        'Archive queue is not available.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }

    const job = await queue.getJob(JobId);
    if (!job) {
      throw new HttpException('Job not found.', HttpStatus.NOT_FOUND);
    }
    if (job.data.userId !== User.Id) {
      throw new HttpException('Access denied.', HttpStatus.FORBIDDEN);
    }

    const state = await job.getState();
    const rawProgress = job.progress;
    const progress = (
      typeof rawProgress === 'object' && rawProgress ? rawProgress : {}
    ) as {
      EntriesProcessed?: number;
      TotalEntries?: number | null;
    };

    const entriesProcessed =
      typeof progress.EntriesProcessed === 'number'
        ? progress.EntriesProcessed
        : undefined;
    const totalEntries =
      progress.TotalEntries != null ? Number(progress.TotalEntries) : undefined;
    const percentage =
      state === ArchiveJobState.COMPLETED
        ? 100
        : totalEntries && totalEntries > 0 && entriesProcessed != null
          ? Math.min(100, Math.round((entriesProcessed / totalEntries) * 100))
          : undefined;

    return plainToInstance(CloudArchiveStatusResponseModel, {
      JobId,
      Kind,
      Status: state,
      EntriesProcessed: entriesProcessed,
      TotalEntries: totalEntries,
      Percentage: percentage,
      OutputKey: isCreate
        ? (job.data as ArchiveCreateJobData).outputKey
        : undefined,
      Error: state === ArchiveJobState.FAILED ? job.failedReason : undefined,
    });
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private – Extract job processor
  // ══════════════════════════════════════════════════════════════════════════

  private async ProcessExtractJob(
    job: Job<ArchiveExtractJobData, ArchiveExtractJobResult>,
  ): Promise<ArchiveExtractJobResult> {
    const jobId = job.id?.toString() ?? '';
    const cancelKey = CloudKeys.ArchiveExtractCancel(jobId);
    const { key, format, selectedEntries } = job.data;
    // ownerId is the pre-resolved storage-owner from enqueue (GetStorageOwnerId already applied).
    // Use user.Id directly with KeyBuilder here; do NOT call GetStorageOwnerId again.
    const user = { Id: job.data.ownerId } as UserContext;

    const handler = this.ArchiveHandlerRegistry.GetHandlerByFormat(format);
    if (!handler) {
      throw new Error(`No handler registered for format "${format}".`);
    }

    const sourceKey = KeyBuilder([user.Id, key]);
    const extractPrefix = BuildArchiveExtractPrefix(key, format);
    const normalizedKey = (key || '').replace(/^\/+|\/+$/g, '');
    const keyParts = normalizedKey.split('/').filter((part) => !!part);
    const filename = keyParts.pop() || '';

    let baseName: string;
    if (format === ArchiveFormat.TAR_GZ) {
      baseName = filename.replace(/\.(tar\.gz|tgz)$/i, '').trim();
    } else {
      const ext = ArchiveFormatExtension(format);
      const extPattern = new RegExp(ext.replace('.', '\\.') + '$', 'i');
      baseName = filename.replace(extPattern, '').trim();
    }
    const archiveBase = baseName || filename || 'extracted';

    try {
      const object = await this.CloudS3Service.Send(
        new GetObjectCommand({
          Bucket: this.CloudS3Service.GetBuckets().Storage,
          Key: sourceKey,
        }),
      );

      const body = object.Body as Readable;
      if (!body) {
        throw new Error('Archive file is empty or unreadable.');
      }

      const totalBytes = Number(object.ContentLength ?? 0);
      const limits = this.BuildSafetyLimits();
      const selectedSet = selectedEntries?.length
        ? new Set(selectedEntries)
        : undefined;

      let lastProgressEntries = 0;
      let lastProgressBytes = 0;

      const inFlight = new Set<Promise<void>>();
      const enqueue = async (task: Promise<void>) => {
        inFlight.add(task);
        const cleanup = () => inFlight.delete(task);
        task.then(cleanup).catch(cleanup);
        if (inFlight.size >= this.ExtractEntryConcurrency) {
          await Promise.race(inFlight);
        }
      };

      let progressInterval: NodeJS.Timeout | null = null;

      try {
        progressInterval = setInterval(() => {
          // Periodic heartbeat (progress reported from onEntry callback)
        }, 1000);

        const extractResult = await handler.Extract(
          body,
          totalBytes,
          limits,
          async (entry) => {
            const normalizedPath = NormalizeArchiveEntryPath(entry.Path);
            if (!normalizedPath) {
              return;
            }

            // Strip archive root folder if it matches the archive base name
            const effectivePath = normalizedPath.startsWith(`${archiveBase}/`)
              ? normalizedPath.slice(archiveBase.length + 1)
              : normalizedPath;
            if (!effectivePath) {
              return;
            }

            const task = this.UploadExtractedEntry(
              user,
              extractPrefix,
              effectivePath,
              entry.Type,
              entry.Stream,
              entry.Size,
            );
            await enqueue(task);
          },
          {
            OnProgress: async (progress: ArchiveExtractProgress) => {
              const entriesDelta =
                progress.EntriesProcessed - lastProgressEntries;
              const bytesDelta = progress.BytesRead - lastProgressBytes;
              if (
                entriesDelta >= this.ExtractProgressEntriesStep ||
                bytesDelta >= this.ExtractProgressBytesStep
              ) {
                lastProgressEntries = progress.EntriesProcessed;
                lastProgressBytes = progress.BytesRead;
                await job.updateProgress(progress);
                this.NotificationService.EmitTransientToUser(
                  job.data.userId,
                  NotificationType.ARCHIVE_EXTRACT_PROGRESS,
                  'Extraction Progress',
                  `Extracting… ${progress.EntriesProcessed} entries`,
                  { JobId: jobId, ...progress },
                );
              }
            },
            ShouldCancel: async () => {
              const cancelled = await this.RedisService.Get<boolean>(cancelKey);
              return cancelled === true;
            },
            SelectedEntries: selectedSet,
          },
        );

        await Promise.all(inFlight);

        // Final progress update
        await job.updateProgress({
          Phase: ArchivePhase.EXTRACT,
          EntriesProcessed: extractResult.EntriesProcessed,
          TotalEntries: extractResult.EntriesProcessed,
          BytesRead: totalBytes,
          TotalBytes: totalBytes,
        } as ArchiveExtractProgress);

        // Update usage
        if (extractResult.TotalUncompressedBytes > 0) {
          await this.CloudUsageService.IncrementUsage(
            user.Id,
            extractResult.TotalUncompressedBytes,
          );
        }
      } finally {
        if (progressInterval) {
          clearInterval(progressInterval);
        }
      }

      // Invalidate caches
      await this.CloudListService.InvalidateDirectoryThumbnailCache(
        user.Id,
        extractPrefix,
      );
      await this.CloudListService.InvalidateListCache(user.Id);

      // Notify user
      const archiveName = key.split('/').pop() || key;
      this.NotificationService.EmitToUser(
        job.data.userId,
        NotificationType.ARCHIVE_EXTRACT_COMPLETE,
        'Archive Extracted',
        `"${archiveName}" has been extracted successfully.`,
        {
          JobId: jobId,
          Key: key,
          ExtractedPath: extractPrefix,
          Format: format,
        },
      );

      return { extractedPath: extractPrefix };
    } catch (error) {
      this.Logger.error(
        `Failed to extract archive for key ${key} (format=${format})`,
        error,
      );

      const archiveName = key.split('/').pop() || key;
      this.NotificationService.EmitToUser(
        job.data.userId,
        NotificationType.ARCHIVE_EXTRACT_FAILED,
        'Archive Extraction Failed',
        `Failed to extract "${archiveName}".`,
        { JobId: jobId, Key: key, Format: format },
      );

      throw error;
    } finally {
      await this.RedisService.Delete(cancelKey);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private – Create job processor
  // ══════════════════════════════════════════════════════════════════════════

  private async ProcessCreateJob(
    job: Job<ArchiveCreateJobData, ArchiveCreateJobResult>,
  ): Promise<ArchiveCreateJobResult> {
    const jobId = job.id?.toString() ?? '';
    const cancelKey = CloudKeys.ArchiveCreateCancel(jobId);
    const { userId, ownerId, keys, outputFormat, outputKey, commonParent } =
      job.data;

    const handler =
      this.ArchiveHandlerRegistry.GetHandlerByFormat(outputFormat);
    if (!handler || !handler.Create) {
      throw new Error(
        `No creation handler registered for format "${outputFormat}".`,
      );
    }

    try {
      // A background create job carries no unlock/reveal session, so encrypted
      // (locked) and hidden (concealed) folder contents must NEVER be swept into
      // the archive (privacy — mirrors the normal listing's exclusion, and the
      // duplicate-scan fix). ownerId is the pre-resolved storage owner; a
      // `{ Id: ownerId }` user round-trips through GetStorageOwnerId to the same
      // owner for the manifest lookup.
      const owner = { Id: ownerId } as UserContext;
      const [encryptedFolders, hiddenFolders] = await Promise.all([
        this.CloudDirectoryService.GetEncryptedFolderSet(owner),
        this.CloudDirectoryService.GetHiddenFolderSet(owner),
      ]);

      // Resolve all entries (expand directories)
      const entries = await this.ResolveCreateEntries(
        ownerId,
        keys,
        commonParent,
        encryptedFolders,
        hiddenFolders,
      );

      if (entries.length === 0) {
        throw new Error('No files found to include in the archive.');
      }
      if (entries.length > this.CreateMaxFiles) {
        throw new Error(
          `Too many files (${entries.length}). Maximum allowed: ${this.CreateMaxFiles}.`,
        );
      }

      const totalSize = entries.reduce((sum, e) => sum + e.Size, 0);
      if (totalSize > this.CreateMaxTotalBytes) {
        throw new Error(
          `Total source size exceeds maximum allowed (${this.CreateMaxTotalBytes} bytes).`,
        );
      }

      // Create archive via handler
      const output = new PassThrough();
      const s3Key = KeyBuilder([ownerId, outputKey]);

      // Start streaming upload to S3
      const uploadPromise = this.StreamToS3(s3Key, output, outputFormat);

      // Start archive creation (pipes data into `output`)
      let lastProgressEmit = 0;
      const createPromise = handler.Create(
        entries,
        async (entryKey: string) => {
          const obj = await this.CloudS3Service.Send(
            new GetObjectCommand({
              Bucket: this.CloudS3Service.GetBuckets().Storage,
              Key: entryKey,
            }),
          );
          return obj.Body as Readable;
        },
        output,
        {
          OnProgress: async (progress: ArchiveCreateProgress) => {
            await job.updateProgress(progress);
            const now = Date.now();
            if (now - lastProgressEmit >= 500) {
              lastProgressEmit = now;
              this.NotificationService.EmitTransientToUser(
                userId,
                NotificationType.ARCHIVE_CREATE_PROGRESS,
                'Archive Progress',
                `Creating archive… ${progress.EntriesProcessed}/${progress.TotalEntries}`,
                { JobId: jobId, ...progress },
              );
            }
          },
          ShouldCancel: async () => {
            const cancelled = await this.RedisService.Get<boolean>(cancelKey);
            return cancelled === true;
          },
        },
      );

      await createPromise;
      const uploadResult = await uploadPromise;

      const archiveSize = Number(
        (uploadResult as { ContentLength?: number }).ContentLength ?? 0,
      );

      const result: ArchiveCreateJobResult = {
        archiveKey: outputKey,
        archiveSize,
      };

      // Invalidate listing caches
      await this.CloudListService.InvalidateListCache(ownerId);

      // Notify user
      const archiveName = outputKey.split('/').pop() || outputKey;
      this.NotificationService.EmitToUser(
        userId,
        NotificationType.ARCHIVE_CREATE_COMPLETE,
        'Archive Created',
        `"${archiveName}" has been created successfully.`,
        {
          JobId: jobId,
          Key: outputKey,
          Size: archiveSize,
          Format: outputFormat,
        },
      );

      return result;
    } catch (error) {
      this.Logger.error(
        `Failed to create archive (format=${outputFormat}, outputKey=${outputKey})`,
        error,
      );

      const archiveName = outputKey.split('/').pop() || outputKey;
      this.NotificationService.EmitToUser(
        userId,
        NotificationType.ARCHIVE_CREATE_FAILED,
        'Archive Creation Failed',
        `Failed to create "${archiveName}".`,
        { JobId: jobId, Format: outputFormat },
      );

      throw error;
    } finally {
      await this.RedisService.Delete(cancelKey);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private – Upload extracted entry
  // ══════════════════════════════════════════════════════════════════════════

  private async UploadExtractedEntry(
    user: UserContext,
    extractPrefix: string,
    effectivePath: string,
    type: ArchiveEntryType,
    stream: Readable,
    size: number,
  ): Promise<void> {
    if (type === ArchiveEntryType.DIRECTORY) {
      const directoryKey = JoinKey(
        extractPrefix,
        effectivePath,
        this.EmptyFolderPlaceholder,
      );
      await this.CloudS3Service.Send(
        new PutObjectCommand({
          Bucket: this.CloudS3Service.GetBuckets().Storage,
          Key: KeyBuilder([user.Id, directoryKey]),
          Body: '',
        }),
      );
      return;
    }

    const targetKey = JoinKey(extractPrefix, effectivePath);
    const entryFilename = effectivePath.split('/').pop() || '';
    const extension = entryFilename.includes('.')
      ? entryFilename.split('.').pop() || ''
      : '';
    const contentType = extension
      ? MimeTypeFromExtension(extension) || undefined
      : undefined;
    const contentLength = Number.isFinite(size) ? size : undefined;

    const fullKey = KeyBuilder([user.Id, targetKey]);

    await this.CloudS3Service.Send(
      new PutObjectCommand({
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        Key: fullKey,
        Body: stream,
        ContentType: contentType,
        ContentLength: contentLength,
      }),
    );

    await this.CloudMetadataService.MetadataProcessor(fullKey);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private – Resolve entries for archive creation
  // ══════════════════════════════════════════════════════════════════════════

  private async ResolveCreateEntries(
    ownerId: string,
    keys: string[],
    commonParent: string,
    encryptedFolders: Set<string>,
    hiddenFolders: Set<string>,
  ): Promise<ArchiveCreateEntry[]> {
    const entries: ArchiveCreateEntry[] = [];

    for (const key of keys) {
      const isDirectory = key.endsWith('/');
      const s3Prefix = KeyBuilder([ownerId, key]);

      if (isDirectory) {
        // Expand directory by listing all objects
        const prefix = s3Prefix.endsWith('/') ? s3Prefix : s3Prefix + '/';
        let continuationToken: string | undefined;

        do {
          const response = await this.CloudS3Service.Send(
            new ListObjectsV2Command({
              Bucket: this.CloudS3Service.GetBuckets().Storage,
              Prefix: prefix,
              ContinuationToken: continuationToken,
            }),
          );

          for (const obj of response.Contents ?? []) {
            if (!obj.Key || obj.Key.endsWith(this.EmptyFolderPlaceholder)) {
              continue;
            }

            // Never sweep secure-folder system manifests or the contents of
            // encrypted (locked) / hidden (concealed) folders into the archive —
            // even when reached by expanding an explicitly selected parent
            // directory (privacy; mirrors the normal listing's exclusion).
            if (
              this.IsSecurePath(
                obj.Key,
                ownerId,
                encryptedFolders,
                hiddenFolders,
              )
            ) {
              continue;
            }

            // Name relative to the common parent directory
            const relativeName = obj.Key.startsWith(`${ownerId}/`)
              ? obj.Key.slice(ownerId.length + 1)
              : obj.Key;
            const entryName = relativeName.startsWith(commonParent)
              ? relativeName.slice(commonParent.length)
              : relativeName;

            entries.push({
              Key: obj.Key,
              Name: entryName,
              Size: Number(obj.Size ?? 0),
            });
          }

          continuationToken = response.IsTruncated
            ? response.NextContinuationToken
            : undefined;
        } while (continuationToken);
      } else {
        // Single file — also honour the secure-folder exclusion so a directly
        // selected file inside a locked/hidden folder is never archived.
        if (
          this.IsSecurePath(s3Prefix, ownerId, encryptedFolders, hiddenFolders)
        ) {
          continue;
        }
        try {
          const head = await this.CloudS3Service.Send(
            new HeadObjectCommand({
              Bucket: this.CloudS3Service.GetBuckets().Storage,
              Key: s3Prefix,
            }),
          );
          const entryName = key.startsWith(commonParent)
            ? key.slice(commonParent.length)
            : key;
          entries.push({
            Key: s3Prefix,
            Name: entryName,
            Size: Number(head.ContentLength ?? 0),
          });
        } catch (error) {
          if (this.CloudS3Service.IsNotFoundError(error as { name?: string })) {
            continue;
          }
          throw error;
        }
      }
    }

    return entries;
  }

  /**
   * True when a full S3 key belongs to a secure folder that a background job
   * must never read: a `.secure/` system manifest, or any object inside an
   * encrypted (locked) or hidden (concealed) folder. Mirrors the duplicate-scan
   * exclusion in `CloudDuplicateService.ListAllObjects`.
   */
  private IsSecurePath(
    fullKey: string,
    ownerId: string,
    encryptedFolders: Set<string>,
    hiddenFolders: Set<string>,
  ): boolean {
    if (fullKey.includes('.secure/')) {
      return true;
    }
    const relativePath = this.CloudS3Service.GetKey(fullKey, ownerId).replace(
      /^\/+|\/+$/g,
      '',
    );
    return (
      IsInsideFolder(relativePath, encryptedFolders) ||
      IsInsideFolder(relativePath, hiddenFolders)
    );
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private – Stream upload to S3
  // ══════════════════════════════════════════════════════════════════════════

  private async StreamToS3(
    s3Key: string,
    stream: PassThrough,
    format: ArchiveFormat,
  ): Promise<unknown> {
    let contentType: string;
    switch (format) {
      case ArchiveFormat.ZIP:
        contentType = 'application/zip';
        break;
      case ArchiveFormat.TAR:
        contentType = 'application/x-tar';
        break;
      case ArchiveFormat.TAR_GZ:
        contentType = 'application/gzip';
        break;
      case ArchiveFormat.RAR:
        contentType = 'application/vnd.rar';
        break;
      default:
        contentType = 'application/octet-stream';
    }

    const upload = new Upload({
      client: this.CloudS3Service.GetClient(),
      params: {
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        Key: s3Key,
        Body: stream,
        ContentType: contentType,
      },
    });

    return upload.done();
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private – Helpers
  // ══════════════════════════════════════════════════════════════════════════

  private BuildSafetyLimits(): ArchiveSafetyLimits {
    return {
      MaxEntries: this.ExtractMaxEntries,
      MaxEntryBytes: this.ExtractMaxEntryBytes,
      MaxTotalBytes: this.ExtractMaxTotalBytes,
      MaxCompressionRatio: this.ExtractMaxCompressionRatio,
    };
  }

  private EnsureExtractQueue(): void {
    if (!this.ExtractQueue) {
      throw new HttpException(
        'Archive extraction queue is not available.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private EnsureCreateQueue(): void {
    if (!this.CreateQueue) {
      throw new HttpException(
        'Archive creation queue is not available.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private GetCommonParentDirectory(keys: string[]): string {
    if (keys.length === 0) return '';

    const parents = keys.map((key) => {
      const normalized = key.endsWith('/') ? key.slice(0, -1) : key;
      const lastSlash = normalized.lastIndexOf('/');
      return lastSlash >= 0 ? normalized.slice(0, lastSlash + 1) : '';
    });

    let common = parents[0];
    for (let i = 1; i < parents.length; i++) {
      while (common && !parents[i].startsWith(common)) {
        const trimmed = common.slice(0, -1);
        const lastSlash = trimmed.lastIndexOf('/');
        common = lastSlash >= 0 ? trimmed.slice(0, lastSlash + 1) : '';
      }
    }

    return common;
  }
}
