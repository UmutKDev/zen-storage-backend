import {
  _Object,
  GetObjectCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import { Job, Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';
import sharp from 'sharp';
import { CloudS3Service } from './cloud.s3.service';
import { CloudDirectoryService } from './cloud.directory.service';
import { RedisService } from '@modules/redis/redis.service';
import { CloudKeys } from '@modules/redis/redis.keys';
import {
  DUPLICATE_SCAN_STATUS_TTL,
  DUPLICATE_SCAN_RESULT_TTL,
  DUPLICATE_SCAN_CANCEL_TTL,
  DUPLICATE_SCAN_ACTIVE_TTL,
} from '@modules/redis/redis.ttl';
import { NotificationService } from '@modules/notification/notification.service';
import {
  DuplicateScanStatus,
  DuplicateScanPhase,
  NotificationType,
} from '@common/enums';
import { IsImageFile, KeyBuilder } from '@common/helpers/cast.helper';
import { GetStorageOwnerId, GetCacheOwnerId } from './cloud.context';
import { BuildBullRedisConnectionOptions, IsInsideFolder } from './cloud.utils';
import { uuidGenerator } from '@common/helpers/cast.helper';
import {
  CloudDuplicateScanStartRequestModel,
  CloudDuplicateScanStartResponseModel,
  CloudDuplicateScanStatusResponseModel,
  CloudDuplicateScanResultResponseModel,
  CloudDuplicateScanCancelResponseModel,
} from './cloud.model';

// ─── Job Types ──────────────────────────────────────────────────────────────

type DuplicateScanJobData = {
  ScanId: string;
  UserId: string;
  OwnerId: string;
  Path: string;
  Recursive: boolean;
  SimilarityThreshold: number;
};

type FileRecord = {
  Key: string;
  Name: string;
  Size: number;
  LastModified?: string;
  MimeType?: string;
  IsImage: boolean;
};

type HashedFile = FileRecord & {
  ContentHash?: string;
  PerceptualHash?: string;
};

type DuplicateGroup = {
  GroupId: string;
  MatchType: string;
  Similarity: number;
  Files: FileRecord[];
  PotentialSavingsBytes: number;
};

// ─── Service ────────────────────────────────────────────────────────────────

@Injectable()
export class CloudDuplicateService implements OnModuleInit, OnModuleDestroy {
  private readonly Logger = new Logger(CloudDuplicateService.name);
  private readonly IsRedisEnabled =
    (process.env.REDIS_ENABLED ?? 'true').toLowerCase() !== 'false';
  private readonly IsDuplicateScanEnabled =
    (process.env.CLOUD_DUPLICATE_SCAN_ENABLED ?? 'true').toLowerCase() !==
    'false';

  private readonly QueueName = 'cloud-duplicate-scan';

  private readonly Concurrency = Math.max(
    1,
    parseInt(process.env.CLOUD_DUPLICATE_SCAN_CONCURRENCY ?? '1', 10),
  );
  private readonly MaxFilesPerScan = Math.max(
    1,
    parseInt(process.env.CLOUD_DUPLICATE_SCAN_MAX_FILES ?? '10000', 10),
  );
  private readonly MaxFileSizeForHash = Math.max(
    1,
    parseInt(
      process.env.CLOUD_DUPLICATE_SCAN_MAX_FILE_BYTES ?? `${500 * 1024 * 1024}`,
      10,
    ),
  );
  private readonly ProgressBatchSize = Math.max(
    1,
    parseInt(process.env.CLOUD_DUPLICATE_SCAN_PROGRESS_BATCH ?? '10', 10),
  );

  private ScanQueue?: Queue<DuplicateScanJobData, void>;
  private ScanWorker?: Worker<DuplicateScanJobData, void>;
  private QueueConnection?: IORedis;
  private WorkerConnection?: IORedis;

  constructor(
    private readonly CloudS3Service: CloudS3Service,
    private readonly RedisService: RedisService,
    private readonly NotificationService: NotificationService,
    private readonly CloudDirectoryService: CloudDirectoryService,
  ) {}

  // ══════════════════════════════════════════════════════════════════════════
  // Lifecycle
  // ══════════════════════════════════════════════════════════════════════════

  async onModuleInit(): Promise<void> {
    if (!this.IsRedisEnabled || !this.IsDuplicateScanEnabled) {
      return;
    }

    const options = BuildBullRedisConnectionOptions();
    if (!options) {
      this.Logger.warn('Redis config missing; duplicate scan queue disabled.');
      return;
    }

    this.QueueConnection = new IORedis(options);
    this.WorkerConnection = new IORedis(options);

    this.ScanQueue = new Queue(this.QueueName, {
      connection: this.QueueConnection,
      defaultJobOptions: {
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 100 },
      },
    });

    this.ScanWorker = new Worker(
      this.QueueName,
      async (job) => this.ProcessDuplicateScanJob(job),
      {
        connection: this.WorkerConnection,
        concurrency: this.Concurrency,
      },
    );

    this.ScanWorker.on('error', (error) => {
      this.Logger.error('Duplicate scan worker error', error);
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ScanWorker) {
      await this.ScanWorker.close();
    }
    if (this.ScanQueue) {
      await this.ScanQueue.close();
    }
    if (this.WorkerConnection) {
      await this.WorkerConnection.quit();
    }
    if (this.QueueConnection) {
      await this.QueueConnection.quit();
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Public API
  // ══════════════════════════════════════════════════════════════════════════

  async EnqueueDuplicateScan(
    {
      Path,
      Recursive = true,
      SimilarityThreshold = 95,
    }: CloudDuplicateScanStartRequestModel,
    User: UserContext,
  ): Promise<CloudDuplicateScanStartResponseModel> {
    this.EnsureQueue();

    const ownerId = GetStorageOwnerId(User);
    const activeKey = CloudKeys.DuplicateScanActive(GetCacheOwnerId(User));
    const activeScanId = await this.RedisService.Get<string>(activeKey);
    if (activeScanId) {
      throw new HttpException(
        'A duplicate scan is already in progress.',
        HttpStatus.CONFLICT,
      );
    }

    const scanId = uuidGenerator();

    await this.RedisService.Set(activeKey, scanId, DUPLICATE_SCAN_ACTIVE_TTL);

    const statusPayload: CloudDuplicateScanStatusResponseModel = {
      ScanId: scanId,
      Status: DuplicateScanStatus.PENDING,
      Progress: {
        TotalFiles: 0,
        ProcessedFiles: 0,
        Phase: DuplicateScanPhase.LISTING,
      },
      StartedAt: new Date().toISOString(),
    };

    await this.RedisService.Set(
      CloudKeys.DuplicateScanStatus(scanId),
      JSON.stringify(statusPayload),
      DUPLICATE_SCAN_STATUS_TTL,
    );

    await this.ScanQueue!.add('duplicate-scan', {
      ScanId: scanId,
      UserId: User.Id,
      OwnerId: ownerId,
      Path,
      Recursive,
      SimilarityThreshold,
    });

    return {
      ScanId: scanId,
      Status: DuplicateScanStatus.PENDING,
    };
  }

  async GetDuplicateScanStatus(
    ScanId: string,
  ): Promise<CloudDuplicateScanStatusResponseModel | null> {
    const raw = await this.RedisService.Get<string>(
      CloudKeys.DuplicateScanStatus(ScanId),
    );
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as CloudDuplicateScanStatusResponseModel;
    } catch {
      return null;
    }
  }

  async GetDuplicateScanResult(
    ScanId: string,
  ): Promise<CloudDuplicateScanResultResponseModel | null> {
    const status = await this.GetDuplicateScanStatus(ScanId);
    if (!status) {
      return null;
    }
    if (status.Status !== DuplicateScanStatus.COMPLETED) {
      throw new HttpException(
        'Scan not yet completed.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const raw = await this.RedisService.Get<string>(
      CloudKeys.DuplicateScanResult(ScanId),
    );
    if (!raw) {
      return null;
    }
    try {
      return JSON.parse(raw) as CloudDuplicateScanResultResponseModel;
    } catch {
      return null;
    }
  }

  async CancelDuplicateScan(
    ScanId: string,
  ): Promise<CloudDuplicateScanCancelResponseModel> {
    const status = await this.GetDuplicateScanStatus(ScanId);
    if (!status) {
      throw new HttpException('Scan not found.', HttpStatus.NOT_FOUND);
    }

    if (
      status.Status === DuplicateScanStatus.COMPLETED ||
      status.Status === DuplicateScanStatus.FAILED ||
      status.Status === DuplicateScanStatus.CANCELLED
    ) {
      return { Cancelled: false };
    }

    await this.RedisService.Set(
      CloudKeys.DuplicateScanCancel(ScanId),
      JSON.stringify(true),
      DUPLICATE_SCAN_CANCEL_TTL,
    );

    return { Cancelled: true };
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Worker
  // ══════════════════════════════════════════════════════════════════════════

  private async ProcessDuplicateScanJob(
    job: Job<DuplicateScanJobData, void>,
  ): Promise<void> {
    const { ScanId, UserId, OwnerId, Path, Recursive, SimilarityThreshold } =
      job.data;
    const cacheOwnerId = OwnerId.startsWith('team/')
      ? `team:${OwnerId.slice(5)}`
      : OwnerId;

    try {
      // ── Phase 1: LISTING ─────────────────────────────────────────────
      await this.UpdateScanStatus(
        ScanId,
        {
          Status: DuplicateScanStatus.SCANNING,
          Progress: {
            TotalFiles: 0,
            ProcessedFiles: 0,
            Phase: DuplicateScanPhase.LISTING,
          },
        },
        UserId,
      );

      const prefix = Path ? KeyBuilder([OwnerId, Path]) : `${OwnerId}/`;
      // A background scan carries no unlock/reveal session, so encrypted (locked)
      // and hidden (concealed) folder contents must NEVER surface in duplicate
      // results (privacy — mirrors the normal listing's exclusion). OwnerId is the
      // pre-resolved storage owner; a `{ Id: OwnerId }` user round-trips through
      // GetStorageOwnerId to the same owner for the manifest lookup.
      const scanUser = { Id: OwnerId } as UserContext;
      const [encryptedFolders, hiddenFolders] = await Promise.all([
        this.CloudDirectoryService.GetEncryptedFolderSet(scanUser),
        this.CloudDirectoryService.GetHiddenFolderSet(scanUser),
      ]);
      const files = await this.ListAllObjects(
        prefix,
        Recursive,
        OwnerId,
        encryptedFolders,
        hiddenFolders,
      );

      if (await this.IsCancelled(ScanId)) {
        await this.HandleCancellation(ScanId, UserId, cacheOwnerId);
        return;
      }

      if (files.length > this.MaxFilesPerScan) {
        await this.HandleFailure(
          ScanId,
          UserId,
          cacheOwnerId,
          `Folder contains ${files.length} files, exceeding the limit of ${this.MaxFilesPerScan}.`,
        );
        return;
      }

      const totalFiles = files.length;

      // ── Phase 2: SIZE_GROUPING ───────────────────────────────────────
      await this.UpdateScanStatus(
        ScanId,
        {
          Progress: {
            TotalFiles: totalFiles,
            ProcessedFiles: 0,
            Phase: DuplicateScanPhase.SIZE_GROUPING,
          },
        },
        UserId,
      );

      const sizeGroups = new Map<number, FileRecord[]>();
      const imageFiles: FileRecord[] = [];

      for (const file of files) {
        if (file.IsImage) {
          imageFiles.push(file);
        } else {
          const group = sizeGroups.get(file.Size) ?? [];
          group.push(file);
          sizeGroups.set(file.Size, group);
        }
      }

      // Non-image files that share a size → content hash candidates
      const contentHashCandidates: FileRecord[] = [];
      for (const [, group] of sizeGroups) {
        if (group.length >= 2) {
          contentHashCandidates.push(...group);
        }
      }

      if (await this.IsCancelled(ScanId)) {
        await this.HandleCancellation(ScanId, UserId, cacheOwnerId);
        return;
      }

      // ── Phase 3: CONTENT_HASHING ─────────────────────────────────────
      await this.UpdateScanStatus(
        ScanId,
        {
          Progress: {
            TotalFiles: totalFiles,
            ProcessedFiles: 0,
            Phase: DuplicateScanPhase.CONTENT_HASHING,
          },
        },
        UserId,
      );

      const contentHashedFiles: HashedFile[] = [];
      let processedCount = 0;

      for (const file of contentHashCandidates) {
        if (file.Size > this.MaxFileSizeForHash) {
          processedCount++;
          continue;
        }

        try {
          const fullKey = KeyBuilder([OwnerId, file.Key]);
          const hash = await this.ComputeContentHash(fullKey);
          contentHashedFiles.push({ ...file, ContentHash: hash });
        } catch (error) {
          this.Logger.warn(
            `Failed to hash file ${file.Key}: ${(error as Error).message}`,
          );
        }

        processedCount++;
        if (processedCount % this.ProgressBatchSize === 0) {
          await this.UpdateScanStatus(
            ScanId,
            {
              Progress: {
                TotalFiles: totalFiles,
                ProcessedFiles: processedCount,
                Phase: DuplicateScanPhase.CONTENT_HASHING,
                Percentage: Math.round((processedCount / totalFiles) * 100),
              },
            },
            UserId,
          );

          if (await this.IsCancelled(ScanId)) {
            await this.HandleCancellation(ScanId, UserId, cacheOwnerId);
            return;
          }
        }
      }

      // Group by content hash
      const contentHashGroups = new Map<string, HashedFile[]>();
      for (const file of contentHashedFiles) {
        if (!file.ContentHash) continue;
        const group = contentHashGroups.get(file.ContentHash) ?? [];
        group.push(file);
        contentHashGroups.set(file.ContentHash, group);
      }

      // ── Phase 4: PERCEPTUAL_HASHING ──────────────────────────────────
      await this.UpdateScanStatus(
        ScanId,
        {
          Progress: {
            TotalFiles: totalFiles,
            ProcessedFiles: processedCount,
            Phase: DuplicateScanPhase.PERCEPTUAL_HASHING,
          },
        },
        UserId,
      );

      const perceptualHashedFiles: HashedFile[] = [];

      for (const file of imageFiles) {
        if (file.Size > this.MaxFileSizeForHash) {
          processedCount++;
          continue;
        }

        try {
          const fullKey = KeyBuilder([OwnerId, file.Key]);
          const hash = await this.ComputePerceptualHash(fullKey);
          perceptualHashedFiles.push({ ...file, PerceptualHash: hash });
        } catch (error) {
          this.Logger.warn(
            `Failed to compute perceptual hash for ${file.Key}: ${(error as Error).message}`,
          );
        }

        processedCount++;
        if (processedCount % this.ProgressBatchSize === 0) {
          await this.UpdateScanStatus(
            ScanId,
            {
              Progress: {
                TotalFiles: totalFiles,
                ProcessedFiles: processedCount,
                Phase: DuplicateScanPhase.PERCEPTUAL_HASHING,
                Percentage: Math.round((processedCount / totalFiles) * 100),
              },
            },
            UserId,
          );

          if (await this.IsCancelled(ScanId)) {
            await this.HandleCancellation(ScanId, UserId, cacheOwnerId);
            return;
          }
        }
      }

      // Group images by perceptual similarity
      const perceptualGroups = this.GroupBySimilarity(
        perceptualHashedFiles,
        SimilarityThreshold,
      );

      // ── Phase 5: FINALIZING ──────────────────────────────────────────
      await this.UpdateScanStatus(
        ScanId,
        {
          Progress: {
            TotalFiles: totalFiles,
            ProcessedFiles: totalFiles,
            Phase: DuplicateScanPhase.FINALIZING,
            Percentage: 100,
          },
        },
        UserId,
      );

      const duplicateGroups: DuplicateGroup[] = [];

      // Exact duplicate groups (content hash)
      for (const [, group] of contentHashGroups) {
        if (group.length < 2) continue;
        const sorted = [...group].sort((a, b) => b.Size - a.Size);
        const savings = sorted.slice(1).reduce((sum, f) => sum + f.Size, 0);

        const files = await Promise.all(
          sorted.map(async (f) => {
            const fullKey = KeyBuilder([OwnerId, f.Key]);
            const SignedUrl = await this.CloudS3Service.SignedUrlBuilder(
              { Key: fullKey } as _Object,
              true,
              this.CloudS3Service,
              this.CloudS3Service.PresignedUrlExpirySeconds,
            );

            return {
              Key: f.Key,
              Name: f.Name,
              Size: f.Size,
              LastModified: f.LastModified,
              MimeType: f.MimeType,
              IsImage: f.IsImage,
              Path: {
                Host: this.CloudS3Service.GetPublicHostname(),
                Key: f.Key,
                Url: SignedUrl,
              },
            };
          }),
        );

        duplicateGroups.push({
          GroupId: uuidGenerator(),
          MatchType: 'exact',
          Similarity: 100,
          Files: files,
          PotentialSavingsBytes: savings,
        });
      }

      // Perceptual duplicate groups
      for (const group of perceptualGroups) {
        const sorted = [...group.Files].sort((a, b) => b.Size - a.Size);
        const savings = sorted.slice(1).reduce((sum, f) => sum + f.Size, 0);

        const files = await Promise.all(
          sorted.map(async (f) => {
            const fullKey = KeyBuilder([OwnerId, f.Key]);
            const SignedUrl = await this.CloudS3Service.SignedUrlBuilder(
              { Key: fullKey } as _Object,
              true,
              this.CloudS3Service,
              this.CloudS3Service.PresignedUrlExpirySeconds,
            );

            return {
              Key: f.Key,
              Name: f.Name,
              Size: f.Size,
              LastModified: f.LastModified,
              MimeType: f.MimeType,
              IsImage: f.IsImage,
              Path: {
                Host: this.CloudS3Service.GetPublicHostname(),
                Key: f.Key,
                Url: SignedUrl,
              },
            };
          }),
        );

        duplicateGroups.push({
          GroupId: uuidGenerator(),
          MatchType: 'similar',
          Similarity: group.Similarity,
          Files: files,
          PotentialSavingsBytes: savings,
        });
      }

      const totalSavings = duplicateGroups.reduce(
        (sum, g) => sum + g.PotentialSavingsBytes,
        0,
      );

      const result: CloudDuplicateScanResultResponseModel = {
        ScanId,
        Status: DuplicateScanStatus.COMPLETED,
        TotalFilesScanned: totalFiles,
        TotalDuplicateGroups: duplicateGroups.length,
        TotalPotentialSavingsBytes: totalSavings,
        Groups: duplicateGroups,
        ScannedAt: new Date().toISOString(),
      };

      await this.RedisService.Set(
        CloudKeys.DuplicateScanResult(ScanId),
        JSON.stringify(result),
        DUPLICATE_SCAN_RESULT_TTL,
      );

      await this.UpdateScanStatus(ScanId, {
        Status: DuplicateScanStatus.COMPLETED,
        CompletedAt: new Date().toISOString(),
        Progress: {
          TotalFiles: totalFiles,
          ProcessedFiles: totalFiles,
          Phase: DuplicateScanPhase.FINALIZING,
          Percentage: 100,
        },
      });

      await this.ClearActiveLock(cacheOwnerId);
      await this.RedisService.Delete(CloudKeys.DuplicateScanCancel(ScanId));

      this.NotificationService.EmitToUser(
        UserId,
        NotificationType.DUPLICATE_SCAN_COMPLETE,
        'Duplicate Scan Complete',
        `Found ${duplicateGroups.length} duplicate groups.`,
        {
          ScanId,
          TotalGroups: duplicateGroups.length,
          TotalSavings: totalSavings,
        },
      );
    } catch (error) {
      this.Logger.error(`Duplicate scan failed for ${ScanId}`, error as Error);
      await this.HandleFailure(
        ScanId,
        UserId,
        cacheOwnerId,
        (error as Error).message,
      );
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private – S3 Operations
  // ══════════════════════════════════════════════════════════════════════════

  private async ListAllObjects(
    prefix: string,
    recursive: boolean,
    ownerId: string,
    encryptedFolders: Set<string>,
    hiddenFolders: Set<string>,
  ): Promise<FileRecord[]> {
    const bucket = this.CloudS3Service.GetBuckets().Storage;
    const files: FileRecord[] = [];
    let continuationToken: string | undefined;

    do {
      const response = await this.CloudS3Service.Send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          Delimiter: recursive ? undefined : '/',
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        }),
      );

      for (const obj of response.Contents ?? []) {
        if (!obj.Key || !obj.Size) continue;

        const name = obj.Key.split('/').pop() ?? '';
        if (
          !name ||
          name === '.emptyFolderPlaceholder' ||
          obj.Key.endsWith('/')
        ) {
          continue;
        }

        // Skip secure-folder system manifests + the contents of encrypted
        // (locked) and hidden (concealed) folders — never surface them in scan
        // results (privacy; mirrors the normal listing's exclusion).
        if (obj.Key.includes('.secure/')) continue;
        const relativeKey = this.CloudS3Service.GetKey(obj.Key, ownerId);
        const relativePath = relativeKey.replace(/^\/+|\/+$/g, '');
        if (
          IsInsideFolder(relativePath, encryptedFolders) ||
          IsInsideFolder(relativePath, hiddenFolders)
        ) {
          continue;
        }

        files.push({
          Key: relativeKey,
          Name: name,
          Size: obj.Size,
          LastModified: obj.LastModified?.toISOString(),
          MimeType: this.GuessMimeType(name),
          IsImage: IsImageFile(name),
        });
      }

      continuationToken = response.NextContinuationToken;
    } while (continuationToken);

    return files;
  }

  private async ComputeContentHash(fullKey: string): Promise<string> {
    const bucket = this.CloudS3Service.GetBuckets().Storage;
    const object = await this.CloudS3Service.Send(
      new GetObjectCommand({ Bucket: bucket, Key: fullKey }),
    );

    const stream = object.Body as Readable;
    const hash = createHash('sha256');

    for await (const chunk of stream) {
      hash.update(chunk);
    }

    return hash.digest('hex');
  }

  private async ComputePerceptualHash(fullKey: string): Promise<string> {
    const bucket = this.CloudS3Service.GetBuckets().Storage;
    const object = await this.CloudS3Service.Send(
      new GetObjectCommand({ Bucket: bucket, Key: fullKey }),
    );

    const stream = object.Body as Readable;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    const buffer = Buffer.concat(chunks);

    return this.ComputeDHash(buffer);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private – dHash Algorithm
  // ══════════════════════════════════════════════════════════════════════════

  /**
   * Compute a difference hash (dHash) for an image using sharp.
   *   1. Resize to 9x8 grayscale (9 cols for 8 horizontal gradients per row)
   *   2. For each row, compare adjacent pixels: if left > right, bit = 1
   *   3. Result: 64-bit hash represented as a binary string
   */
  private async ComputeDHash(buffer: Buffer): Promise<string> {
    const pixels = await sharp(buffer)
      .greyscale()
      .resize(9, 8, { fit: 'fill' })
      .raw()
      .toBuffer();

    let hash = '';
    for (let row = 0; row < 8; row++) {
      for (let col = 0; col < 8; col++) {
        const leftPixel = pixels[row * 9 + col];
        const rightPixel = pixels[row * 9 + col + 1];
        hash += leftPixel > rightPixel ? '1' : '0';
      }
    }
    return hash;
  }

  private ComputeHashSimilarity(hash1: string, hash2: string): number {
    let distance = 0;
    for (let i = 0; i < 64; i++) {
      if (hash1[i] !== hash2[i]) {
        distance++;
      }
    }
    return ((64 - distance) / 64) * 100;
  }

  /**
   * Group images by perceptual similarity using union-find.
   * For each pair with similarity >= threshold, union them.
   */
  private GroupBySimilarity(
    files: HashedFile[],
    threshold: number,
  ): Array<{ Files: HashedFile[]; Similarity: number }> {
    if (files.length < 2) return [];

    const parent = files.map((_, i) => i);
    const rank = new Array(files.length).fill(0);

    const find = (i: number): number => {
      if (parent[i] !== i) parent[i] = find(parent[i]);
      return parent[i];
    };

    const union = (i: number, j: number): void => {
      const ri = find(i);
      const rj = find(j);
      if (ri === rj) return;
      if (rank[ri] < rank[rj]) parent[ri] = rj;
      else if (rank[ri] > rank[rj]) parent[rj] = ri;
      else {
        parent[rj] = ri;
        rank[ri]++;
      }
    };

    const pairSimilarities = new Map<string, number>();

    for (let i = 0; i < files.length; i++) {
      for (let j = i + 1; j < files.length; j++) {
        if (!files[i].PerceptualHash || !files[j].PerceptualHash) continue;
        const sim = this.ComputeHashSimilarity(
          files[i].PerceptualHash!,
          files[j].PerceptualHash!,
        );
        if (sim >= threshold) {
          union(i, j);
          pairSimilarities.set(`${i}-${j}`, sim);
        }
      }
    }

    // Collect groups
    const groupMap = new Map<
      number,
      { Files: HashedFile[]; Indices: number[] }
    >();
    for (let i = 0; i < files.length; i++) {
      const root = find(i);
      if (!groupMap.has(root)) {
        groupMap.set(root, { Files: [], Indices: [] });
      }
      const group = groupMap.get(root)!;
      group.Files.push(files[i]);
      group.Indices.push(i);
    }

    // Filter to groups with 2+ files, compute average similarity
    const result: Array<{ Files: HashedFile[]; Similarity: number }> = [];
    for (const [, group] of groupMap) {
      if (group.Files.length < 2) continue;

      let totalSim = 0;
      let pairCount = 0;
      for (let a = 0; a < group.Indices.length; a++) {
        for (let b = a + 1; b < group.Indices.length; b++) {
          const i = Math.min(group.Indices[a], group.Indices[b]);
          const j = Math.max(group.Indices[a], group.Indices[b]);
          const sim = pairSimilarities.get(`${i}-${j}`);
          if (sim !== undefined) {
            totalSim += sim;
            pairCount++;
          }
        }
      }

      result.push({
        Files: group.Files,
        Similarity:
          pairCount > 0 ? Math.round(totalSim / pairCount) : threshold,
      });
    }

    return result;
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Private – Helpers
  // ══════════════════════════════════════════════════════════════════════════

  private EnsureQueue(): void {
    if (!this.IsDuplicateScanEnabled || !this.ScanQueue) {
      throw new HttpException(
        'Duplicate scan is not available.',
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    }
  }

  private async IsCancelled(scanId: string): Promise<boolean> {
    const raw = await this.RedisService.Get<string>(
      CloudKeys.DuplicateScanCancel(scanId),
    );
    return raw !== null && raw !== undefined;
  }

  private async HandleCancellation(
    scanId: string,
    userId: string,
    cacheOwnerId: string,
  ): Promise<void> {
    await this.UpdateScanStatus(scanId, {
      Status: DuplicateScanStatus.CANCELLED,
      CompletedAt: new Date().toISOString(),
    });
    await this.ClearActiveLock(cacheOwnerId);
    await this.RedisService.Delete(CloudKeys.DuplicateScanCancel(scanId));

    this.NotificationService.EmitToUser(
      userId,
      NotificationType.DUPLICATE_SCAN_CANCELLED,
      'Duplicate Scan Cancelled',
      'Duplicate scan was cancelled.',
      { ScanId: scanId },
    );
  }

  private async HandleFailure(
    scanId: string,
    userId: string,
    cacheOwnerId: string,
    errorMessage: string,
  ): Promise<void> {
    await this.UpdateScanStatus(scanId, {
      Status: DuplicateScanStatus.FAILED,
      Error: errorMessage,
      CompletedAt: new Date().toISOString(),
    });
    await this.ClearActiveLock(cacheOwnerId);
    await this.RedisService.Delete(CloudKeys.DuplicateScanCancel(scanId));

    this.NotificationService.EmitToUser(
      userId,
      NotificationType.DUPLICATE_SCAN_FAILED,
      'Duplicate Scan Failed',
      errorMessage,
      { ScanId: scanId },
    );
  }

  private async UpdateScanStatus(
    scanId: string,
    partial: Partial<CloudDuplicateScanStatusResponseModel>,
    userId?: string,
  ): Promise<void> {
    const raw = await this.RedisService.Get<string>(
      CloudKeys.DuplicateScanStatus(scanId),
    );
    const current = raw
      ? (JSON.parse(raw) as CloudDuplicateScanStatusResponseModel)
      : ({} as CloudDuplicateScanStatusResponseModel);

    const updated = { ...current, ...partial };
    await this.RedisService.Set(
      CloudKeys.DuplicateScanStatus(scanId),
      JSON.stringify(updated),
      DUPLICATE_SCAN_STATUS_TTL,
    );

    // Emit a TRANSIENT progress event (socket-only, never persisted) so the
    // client can drive a live progress bar. Terminal statuses (complete/failed/
    // cancelled) emit their own persisted notification elsewhere, so they are
    // skipped here.
    if (
      userId &&
      updated.Progress &&
      updated.Status !== DuplicateScanStatus.COMPLETED &&
      updated.Status !== DuplicateScanStatus.FAILED &&
      updated.Status !== DuplicateScanStatus.CANCELLED
    ) {
      this.NotificationService.EmitTransientToUser(
        userId,
        NotificationType.DUPLICATE_SCAN_PROGRESS,
        'Duplicate Scan Progress',
        `Scanning… ${updated.Progress.ProcessedFiles}/${updated.Progress.TotalFiles}`,
        { ScanId: scanId, ...updated.Progress },
      );
    }
  }

  private async ClearActiveLock(cacheOwnerId: string): Promise<void> {
    await this.RedisService.Delete(CloudKeys.DuplicateScanActive(cacheOwnerId));
  }

  private GuessMimeType(name: string): string | undefined {
    const ext = name.split('.').pop()?.toLowerCase();
    if (!ext) return undefined;

    const mimeMap: Record<string, string> = {
      jpg: 'image/jpeg',
      jpeg: 'image/jpeg',
      png: 'image/png',
      gif: 'image/gif',
      bmp: 'image/bmp',
      webp: 'image/webp',
      tiff: 'image/tiff',
      svg: 'image/svg+xml',
      pdf: 'application/pdf',
      doc: 'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      xls: 'application/vnd.ms-excel',
      xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      ppt: 'application/vnd.ms-powerpoint',
      pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      zip: 'application/zip',
      mp4: 'video/mp4',
      mp3: 'audio/mpeg',
      txt: 'text/plain',
      json: 'application/json',
      csv: 'text/csv',
    };

    return mimeMap[ext];
  }
}
