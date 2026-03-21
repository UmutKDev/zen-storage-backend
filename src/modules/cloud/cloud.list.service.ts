import {
  CommonPrefix,
  HeadObjectCommand,
  ListObjectsV2Command,
  ListObjectsV2CommandInput,
  _Object,
} from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import {
  CloudBreadCrumbModel,
  CloudDirectoryModel,
  CloudListRequestModel,
  CloudListResponseModel,
  CloudObjectModel,
} from './cloud.model';
import { CloudBreadcrumbLevelType } from '@common/enums';
import {
  IsImageFile,
  KeyBuilder,
  MimeTypeFromExtension,
} from '@common/helpers/cast.helper';
import { CloudS3Service } from './cloud.s3.service';
import { CloudMetadataService } from './cloud.metadata.service';
import { NormalizeDirectoryPath } from './cloud.utils';
import { GetStorageOwnerId } from './cloud.context';
import { RedisService } from '@modules/redis/redis.service';
import { CloudKeys } from '@modules/redis/redis.keys';
import {
  CLOUD_LIST_CACHE_TTL,
  CLOUD_THUMBNAIL_CACHE_TTL,
} from '@modules/redis/redis.ttl';

@Injectable()
export class CloudListService {
  private readonly Logger = new Logger(CloudListService.name);
  private readonly MaxProcessMetadataObjects = Math.max(
    1,
    parseInt(process.env.CLOUD_LIST_METADATA_MAX ?? '1000', 10),
  );
  private readonly MaxListObjects = 1000;
  private readonly MetadataProcessingConcurrency = Math.max(
    1,
    parseInt(process.env.CLOUD_LIST_METADATA_CONCURRENCY ?? '5', 10),
  );
  private readonly DirectoryThumbnailLimit = 4;
  private readonly DirectoryThumbnailMaxFolders = 4;
  private readonly EmptyFolderPlaceholder = '.emptyFolderPlaceholder';
  private readonly IsSignedUrlProcessing =
    process.env.S3_PROTOCOL_SIGNED_URL_PROCESSING === 'true';
  private readonly IsDirectory = (key: string) =>
    key.includes(this.EmptyFolderPlaceholder);
  private readonly MaxSearchScanObjects = Math.max(
    1,
    parseInt(process.env.CLOUD_SEARCH_SCAN_MAX ?? '10000', 10),
  );

  constructor(
    private readonly CloudS3Service: CloudS3Service,
    private readonly CloudMetadataService: CloudMetadataService,
    private readonly RedisService: RedisService,
  ) {}

  async List(
    { Path, Delimiter, IsMetadataProcessing }: CloudListRequestModel,
    User: UserContext,
    EncryptedFolders?: Set<string>,
    SessionToken?: string,
    ValidateDirectorySession?: (
      userId: string,
      folderPath: string,
      sessionToken: string,
    ) => Promise<unknown>,
    HiddenFolders?: Set<string>,
    HiddenSessionToken?: string,
    ValidateHiddenSession?: (
      userId: string,
      folderPath: string,
      sessionToken: string,
    ) => Promise<unknown>,
  ): Promise<CloudListResponseModel> {
    const cleanedPath = Path ? Path.replace(/^\/+|\/+$/g, '') : '';

    const cacheKey = CloudKeys.List(
      GetStorageOwnerId(User),
      cleanedPath,
      !!Delimiter,
      !!IsMetadataProcessing,
      !!SessionToken,
      !!HiddenSessionToken,
    );
    const cached =
      await this.RedisService.Get<CloudListResponseModel>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    let prefix = KeyBuilder([GetStorageOwnerId(User), cleanedPath]);
    if (!prefix.endsWith('/')) {
      prefix = prefix + '/';
    }

    const command = await this.CloudS3Service.Send(
      new ListObjectsV2Command({
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        MaxKeys: this.MaxListObjects,
        Delimiter: Delimiter ? '/' : undefined,
        Prefix: prefix,
      }),
    );

    const [Breadcrumb, Directories, Contents] = await Promise.all([
      this.ProcessBreadcrumb(Path || '', Delimiter),
      this.ProcessDirectories(
        command.CommonPrefixes ?? [],
        prefix,
        User,
        EncryptedFolders,
        SessionToken,
        ValidateDirectorySession,
        false,
        false,
        HiddenFolders,
        HiddenSessionToken,
        ValidateHiddenSession,
      ),
      this.ProcessObjects(
        command.Contents ?? [],
        IsMetadataProcessing,
        User,
        this.IsSignedUrlProcessing,
      ),
    ]);

    const result = plainToInstance(CloudListResponseModel, {
      Breadcrumb,
      Directories,
      Contents,
    });

    await this.RedisService.Set(cacheKey, result, CLOUD_LIST_CACHE_TTL);
    return result;
  }

  async ListObjects(
    {
      Path,
      Delimiter,
      IsMetadataProcessing,
      Search,
      Skip,
      Take,
    }: CloudListRequestModel,
    User: UserContext,
  ): Promise<{ Objects: CloudObjectModel[]; TotalCount: number }> {
    const cleanedPath = Path ? Path.replace(/^\/+|\/+$/g, '') : '';

    let prefix = KeyBuilder([GetStorageOwnerId(User), cleanedPath]);
    if (!prefix.endsWith('/')) {
      prefix = prefix + '/';
    }

    const skipValue = typeof Skip === 'number' && Skip > 0 ? Skip : 0;
    const takeValue =
      typeof Take === 'number' && Take > 0 ? Take : this.MaxListObjects;

    const cacheKey = CloudKeys.ListObjects(
      GetStorageOwnerId(User),
      cleanedPath,
      !!Delimiter,
      !!IsMetadataProcessing,
      skipValue,
      takeValue,
      Search,
    );
    const cached = await this.RedisService.Get<{
      Objects: CloudObjectModel[];
      TotalCount: number;
    }>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    if (!skipValue && takeValue === this.MaxListObjects) {
      const command = await this.CloudS3Service.Send(
        new ListObjectsV2Command({
          Bucket: this.CloudS3Service.GetBuckets().Storage,
          MaxKeys: this.MaxListObjects,
          Delimiter: Delimiter ? '/' : undefined,
          Prefix: prefix,
        }),
      );

      const objects = await this.ProcessObjects(
        command.Contents ?? [],
        IsMetadataProcessing,
        User,
        this.IsSignedUrlProcessing,
      );

      const result = { Objects: objects, TotalCount: objects.length };
      await this.RedisService.Set(cacheKey, result, CLOUD_LIST_CACHE_TTL);
      return result;
    }

    const aggregated: _Object[] = [];
    let continuationToken: string | undefined = undefined;
    let isFirstRequest = true;

    while (true) {
      const maxKeys = Math.min(
        this.MaxListObjects,
        Math.max(1, skipValue + takeValue - aggregated.length),
      );
      const params: ListObjectsV2CommandInput = {
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        Delimiter: Delimiter ? '/' : undefined,
        Prefix: prefix,
        MaxKeys: maxKeys,
      };

      if (isFirstRequest && Search) {
        params.StartAfter = Search;
      }
      if (continuationToken) {
        params.ContinuationToken = continuationToken;
      }

      const command = await this.CloudS3Service.Send(
        new ListObjectsV2Command(params),
      );

      const contents = command.Contents ?? [];
      aggregated.push(...contents);

      const isTruncated = command.IsTruncated;
      continuationToken = isTruncated
        ? command.NextContinuationToken
        : undefined;

      if (aggregated.length >= skipValue + takeValue) {
        break;
      }

      if (!isTruncated) {
        break;
      }

      isFirstRequest = false;
    }

    const sliced = aggregated.slice(skipValue, skipValue + takeValue);

    const objects = await this.ProcessObjects(
      sliced,
      IsMetadataProcessing,
      User,
      this.IsSignedUrlProcessing,
    );

    let totalCount = aggregated.length;
    while (continuationToken) {
      const countParams: ListObjectsV2CommandInput = {
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        Delimiter: Delimiter ? '/' : undefined,
        Prefix: prefix,
        MaxKeys: this.MaxListObjects,
        ContinuationToken: continuationToken,
      };

      const countCommand = await this.CloudS3Service.Send(
        new ListObjectsV2Command(countParams),
      );
      totalCount += (countCommand.Contents ?? []).length;

      if (!countCommand.IsTruncated) {
        break;
      }
      continuationToken = countCommand.NextContinuationToken;
    }

    const result = { Objects: objects, TotalCount: totalCount };
    await this.RedisService.Set(cacheKey, result, CLOUD_LIST_CACHE_TTL);
    return result;
  }

  async ListDirectories(
    {
      Path,
      search,
      skip,
      take,
    }: CloudListRequestModel & {
      search?: string;
      skip?: number;
      take?: number;
    },
    User: UserContext,
    EncryptedFolders?: Set<string>,
    SessionToken?: string,
    ValidateDirectorySession?: (
      userId: string,
      folderPath: string,
      sessionToken: string,
    ) => Promise<unknown>,
    HiddenFolders?: Set<string>,
    HiddenSessionToken?: string,
    ValidateHiddenSession?: (
      userId: string,
      folderPath: string,
      sessionToken: string,
    ) => Promise<unknown>,
  ): Promise<{ Directories: CloudDirectoryModel[]; TotalCount: number }> {
    const cleanedPath = Path ? Path.replace(/^\/+|\/+$/g, '') : '';

    const cacheKey = CloudKeys.ListDirectories(
      GetStorageOwnerId(User),
      cleanedPath,
      typeof skip === 'number' && skip > 0 ? skip : 0,
      typeof take === 'number' && take > 0 ? take : 0,
      !!SessionToken,
      !!HiddenSessionToken,
      search,
    );
    const cached = await this.RedisService.Get<{
      Directories: CloudDirectoryModel[];
      TotalCount: number;
    }>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    let prefix = KeyBuilder([GetStorageOwnerId(User), cleanedPath]);
    if (!prefix.endsWith('/')) {
      prefix = prefix + '/';
    }

    const usePagination = typeof skip === 'number' || typeof take === 'number';
    const delimiterValue = '/';

    if (!usePagination) {
      const command = await this.CloudS3Service.Send(
        new ListObjectsV2Command({
          Bucket: this.CloudS3Service.GetBuckets().Storage,
          Delimiter: delimiterValue,
          Prefix: prefix,
        }),
      );

      const directories = await this.ProcessDirectories(
        command.CommonPrefixes ?? [],
        prefix,
        User,
        EncryptedFolders,
        SessionToken,
        ValidateDirectorySession,
        true,
        this.IsSignedUrlProcessing,
        HiddenFolders,
        HiddenSessionToken,
        ValidateHiddenSession,
      );

      const result = {
        Directories: directories,
        TotalCount: command.CommonPrefixes?.length ?? 0,
      };
      await this.RedisService.Set(cacheKey, result, CLOUD_LIST_CACHE_TTL);
      return result;
    }

    const skipValue = typeof skip === 'number' && skip > 0 ? skip : 0;
    const takeValue =
      typeof take === 'number' && take > 0 ? take : this.MaxListObjects;

    const aggregated: CommonPrefix[] = [];
    let continuationToken: string | undefined = undefined;
    let isFirstRequest = true;

    while (true) {
      const maxKeys = Math.min(
        this.MaxListObjects,
        Math.max(1, skipValue + takeValue - aggregated.length),
      );
      const params: ListObjectsV2CommandInput = {
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        Delimiter: delimiterValue,
        Prefix: prefix,
        MaxKeys: maxKeys,
      };

      if (isFirstRequest && search) {
        params.StartAfter = search;
      }
      if (continuationToken) {
        params.ContinuationToken = continuationToken;
      }

      const command = await this.CloudS3Service.Send(
        new ListObjectsV2Command(params),
      );

      const commonPrefixes = command.CommonPrefixes ?? [];
      aggregated.push(...commonPrefixes);

      const isTruncated = command.IsTruncated;
      continuationToken = isTruncated
        ? command.NextContinuationToken
        : undefined;

      if (aggregated.length >= skipValue + takeValue) {
        break;
      }

      if (!isTruncated) {
        break;
      }

      isFirstRequest = false;
    }

    const sliced = aggregated.slice(skipValue, skipValue + takeValue);

    const directories = await this.ProcessDirectories(
      sliced,
      prefix,
      User,
      EncryptedFolders,
      SessionToken,
      ValidateDirectorySession,
      true,
      this.IsSignedUrlProcessing,
      HiddenFolders,
      HiddenSessionToken,
      ValidateHiddenSession,
    );

    let totalCount = aggregated.length;
    while (continuationToken) {
      const countParams: ListObjectsV2CommandInput = {
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        Delimiter: delimiterValue,
        Prefix: prefix,
        MaxKeys: this.MaxListObjects,
        ContinuationToken: continuationToken,
      };

      const countCommand = await this.CloudS3Service.Send(
        new ListObjectsV2Command(countParams),
      );
      totalCount += (countCommand.CommonPrefixes ?? []).length;

      if (!countCommand.IsTruncated) {
        break;
      }
      continuationToken = countCommand.NextContinuationToken;
    }

    const result = { Directories: directories, TotalCount: totalCount };
    await this.RedisService.Set(cacheKey, result, CLOUD_LIST_CACHE_TTL);
    return result;
  }

  async SearchObjects(
    {
      Query,
      Path,
      Extension,
      IsMetadataProcessing,
      Skip,
      Take,
    }: {
      Query: string;
      Path?: string;
      Extension?: string;
      IsMetadataProcessing: boolean;
      Skip?: number;
      Take?: number;
    },
    User: UserContext,
    EncryptedFolders?: Set<string>,
    SessionToken?: string,
    ValidateDirectorySession?: (
      userId: string,
      folderPath: string,
      sessionToken: string,
    ) => Promise<unknown>,
    HiddenFolders?: Set<string>,
    HiddenSessionToken?: string,
    ValidateHiddenSession?: (
      userId: string,
      folderPath: string,
      sessionToken: string,
    ) => Promise<unknown>,
  ): Promise<{
    Objects: CloudObjectModel[];
    TotalCount: number;
    Directories: CloudDirectoryModel[];
    TotalDirectoryCount: number;
  }> {
    const cleanedPath = Path ? Path.replace(/^\/+|\/+$/g, '') : '';

    let prefix = KeyBuilder([GetStorageOwnerId(User), cleanedPath]);
    if (!prefix.endsWith('/')) {
      prefix = prefix + '/';
    }

    const skipValue = typeof Skip === 'number' && Skip > 0 ? Skip : 0;
    const takeValue = typeof Take === 'number' && Take > 0 ? Take : 50;
    const lowerQuery = Query.toLowerCase();
    const lowerExtension = Extension?.toLowerCase();

    const matched: _Object[] = [];
    let totalMatched = 0;
    let continuationToken: string | undefined;
    let scannedObjects = 0;

    const sessionCache = new Map<string, boolean>();
    const matchedDirs = new Map<string, string>(); // dirPath -> dirName

    do {
      const command = await this.CloudS3Service.Send(
        new ListObjectsV2Command({
          Bucket: this.CloudS3Service.GetBuckets().Storage,
          Prefix: prefix,
          MaxKeys: this.MaxListObjects,
          ContinuationToken: continuationToken,
        }),
      );

      for (const obj of command.Contents ?? []) {
        scannedObjects++;
        if (!obj.Key) continue;
        if (obj.Key.includes('.secure/')) continue;

        const relativePath = obj.Key.replace(GetStorageOwnerId(User) + '/', '');

        // Check encrypted folder access
        if (this.IsInsideEncryptedFolder(relativePath, EncryptedFolders)) {
          const encFolder = this.FindEncryptingFolder(
            relativePath,
            EncryptedFolders,
          );
          if (encFolder) {
            if (!sessionCache.has(encFolder)) {
              const session =
                SessionToken && ValidateDirectorySession
                  ? await ValidateDirectorySession(
                      GetStorageOwnerId(User),
                      encFolder,
                      SessionToken,
                    )
                  : null;
              sessionCache.set(encFolder, !!session);
            }
            if (!sessionCache.get(encFolder)) continue;
          }
        }

        // Check hidden folder access
        if (this.IsInsideHiddenFolder(relativePath, HiddenFolders)) {
          const hiddenFolder = this.FindHiddenFolder(
            relativePath,
            HiddenFolders,
          );
          if (hiddenFolder) {
            const hiddenCacheKey = `hidden:${hiddenFolder}`;
            if (!sessionCache.has(hiddenCacheKey)) {
              const session =
                HiddenSessionToken && ValidateHiddenSession
                  ? await ValidateHiddenSession(
                      GetStorageOwnerId(User),
                      hiddenFolder,
                      HiddenSessionToken,
                    )
                  : null;
              sessionCache.set(hiddenCacheKey, !!session);
            }
            if (!sessionCache.get(hiddenCacheKey)) continue;
          }
        }

        // Extract directories from .emptyFolderPlaceholder files
        if (this.IsDirectory(obj.Key)) {
          const folderPath = relativePath.replace(
            '/' + this.EmptyFolderPlaceholder,
            '',
          );
          const folderName = folderPath.split('/').pop() || '';
          if (
            folderName.toLowerCase().includes(lowerQuery) &&
            !matchedDirs.has(folderPath)
          ) {
            matchedDirs.set(folderPath, folderName);
          }
          continue;
        }

        // Extract directory names from object path segments
        const pathParts = relativePath.split('/');
        if (pathParts.length > 1) {
          let dirPath = '';
          for (let i = 0; i < pathParts.length - 1; i++) {
            dirPath = dirPath ? dirPath + '/' + pathParts[i] : pathParts[i];
            const dirName = pathParts[i];
            if (
              !matchedDirs.has(dirPath) &&
              dirName.toLowerCase().includes(lowerQuery)
            ) {
              matchedDirs.set(dirPath, dirName);
            }
          }
        }

        // Match file name
        const fileName = obj.Key.split('/').pop() || '';
        if (!fileName.toLowerCase().includes(lowerQuery)) continue;

        if (lowerExtension) {
          const ext = fileName.includes('.')
            ? fileName.split('.').pop()?.toLowerCase()
            : '';
          if (ext !== lowerExtension) continue;
        }

        totalMatched++;

        if (totalMatched > skipValue && matched.length < takeValue) {
          matched.push(obj);
        }
      }

      continuationToken = command.IsTruncated
        ? command.NextContinuationToken
        : undefined;
    } while (continuationToken && scannedObjects < this.MaxSearchScanObjects);

    const objects = await this.ProcessObjects(
      matched,
      IsMetadataProcessing,
      User,
      this.IsSignedUrlProcessing,
    );

    const directories: CloudDirectoryModel[] = Array.from(
      matchedDirs.entries(),
    ).map(([dirPrefix, name]) => ({
      Name: name,
      Prefix: dirPrefix.endsWith('/') ? dirPrefix : dirPrefix + '/',
      IsEncrypted: EncryptedFolders?.has(dirPrefix) ?? false,
      IsLocked: false,
      IsHidden: HiddenFolders?.has(dirPrefix) ?? false,
      IsConcealed: false,
    }));

    return {
      Objects: objects,
      TotalCount: totalMatched,
      Directories: directories,
      TotalDirectoryCount: directories.length,
    };
  }

  async ProcessBreadcrumb(
    Path: string,
    Delimiter: boolean = false,
  ): Promise<CloudBreadCrumbModel[]> {
    const breadcrumb: CloudBreadCrumbModel[] = Delimiter
      ? [
          {
            Name: 'root',
            Path: '/',
            Type: CloudBreadcrumbLevelType.ROOT,
          },
        ]
      : [];

    const cleanPath = (Path || '').replace(/^\/+|\/+$/g, '');

    if (!cleanPath) {
      return breadcrumb;
    }

    const parts = cleanPath.split('/');
    let accumulatedPath = '';

    for (const part of parts) {
      accumulatedPath += `/${part}`;
      breadcrumb.push({
        Name: part,
        Path: accumulatedPath,
        Type: CloudBreadcrumbLevelType.SUBFOLDER,
      });
    }

    return breadcrumb;
  }

  async ProcessDirectories(
    CommonPrefixes: CommonPrefix[],
    Prefix: string,
    User: UserContext,
    EncryptedFolders?: Set<string>,
    SessionToken?: string,
    ValidateDirectorySession?: (
      userId: string,
      folderPath: string,
      sessionToken: string,
    ) => Promise<unknown>,
    IncludeThumbnails = false,
    IsSignedUrlProcessing = false,
    HiddenFolders?: Set<string>,
    HiddenSessionToken?: string,
    ValidateHiddenSession?: (
      userId: string,
      folderPath: string,
      sessionToken: string,
    ) => Promise<unknown>,
  ): Promise<CloudDirectoryModel[]> {
    const CommonPrefixesFiltered = CommonPrefixes.filter(
      (cp) => !cp.Prefix.includes('.secure/'),
    );

    if (CommonPrefixes.length === 0) {
      return [];
    }

    const directories: CloudDirectoryModel[] = [];
    for (const commonPrefix of CommonPrefixesFiltered) {
      if (commonPrefix.Prefix) {
        const DirectoryName = commonPrefix.Prefix.replace(Prefix, '').replace(
          '/',
          '',
        );
        const DirectoryPrefix: string = commonPrefix.Prefix.replace(
          GetStorageOwnerId(User) + '/',
          '',
        );
        const normalizedPrefix = NormalizeDirectoryPath(DirectoryPrefix);
        const isEncrypted = EncryptedFolders?.has(normalizedPrefix) ?? false;

        let isLocked = true;
        if (isEncrypted && SessionToken && ValidateDirectorySession) {
          const session = await ValidateDirectorySession(
            GetStorageOwnerId(User),
            normalizedPrefix,
            SessionToken,
          );
          isLocked = !session;
        }

        const isHidden = HiddenFolders?.has(normalizedPrefix) ?? false;

        if (isHidden) {
          let isConcealed = true;
          if (HiddenSessionToken && ValidateHiddenSession) {
            const hiddenSession = await ValidateHiddenSession(
              GetStorageOwnerId(User),
              normalizedPrefix,
              HiddenSessionToken,
            );

            isConcealed = !hiddenSession;
          }
          if (isConcealed) {
            continue;
          }

          directories.push({
            Name: DirectoryName,
            Prefix: DirectoryPrefix,
            IsEncrypted: isEncrypted,
            IsLocked: isEncrypted ? isLocked : false,
            IsHidden: true,
            IsConcealed: false,
          });
        } else {
          directories.push({
            Name: DirectoryName,
            Prefix: DirectoryPrefix,
            IsEncrypted: isEncrypted,
            IsLocked: isEncrypted ? isLocked : false,
            IsHidden: false,
            IsConcealed: false,
          });
        }
      }
    }

    if (IncludeThumbnails && directories.length > 0) {
      const concurrency = Math.min(
        this.MetadataProcessingConcurrency,
        directories.length,
      );
      let currentIndex = 0;
      const worker = async () => {
        while (true) {
          const index = currentIndex++;
          if (index >= directories.length) {
            break;
          }
          const directory = directories[index];
          if (directory.IsEncrypted && directory.IsLocked) {
            directory.Thumbnails = [];
            continue;
          }
          if (directory.IsHidden && directory.IsConcealed) {
            directory.Thumbnails = [];
            continue;
          }
          directory.Thumbnails = await this.ListDirectoryThumbnails(
            directory.Prefix,
            User,
            IsSignedUrlProcessing,
          );
        }
      };
      await Promise.all(Array.from({ length: concurrency }, () => worker()));
    }
    return directories;
  }

  async ProcessObjects(
    Contents: _Object[],
    IsMetadataProcessing = false,
    User: UserContext,
    IsSignedUrlProcessing = false,
  ): Promise<CloudObjectModel[]> {
    if (Contents.length === 0) {
      return [];
    }

    if (Contents.length > this.MaxProcessMetadataObjects) {
      Contents = Contents.slice(0, this.MaxProcessMetadataObjects);
    }

    Contents = Contents.filter((c) => c.Key !== undefined);
    Contents = Contents.filter((c) => !this.IsDirectory(c.Key || ''));
    const processedContents = new Array<CloudObjectModel>(Contents.length);
    let index = 0;
    const worker = async () => {
      while (true) {
        const current = index++;
        if (current >= Contents.length) {
          break;
        }
        const content = Contents[current];
        processedContents[current] = await this.BuildObjectModel(
          content,
          User,
          IsMetadataProcessing,
          IsSignedUrlProcessing,
        );
      }
    };
    const concurrency = Math.min(
      this.MetadataProcessingConcurrency,
      Contents.length,
    );
    await Promise.all(Array.from({ length: concurrency }, () => worker()));
    return processedContents.filter((item) => !!item);
  }

  private async BuildObjectModel(
    content: _Object,
    User: UserContext,
    IsMetadataProcessing: boolean,
    IsSignedUrlProcessing: boolean,
  ): Promise<CloudObjectModel> {
    let metadata: Record<string, string> = {};
    let contentType: string | undefined = undefined;

    if (IsMetadataProcessing) {
      const head = await this.CloudS3Service.Send(
        new HeadObjectCommand({
          Bucket: this.CloudS3Service.GetBuckets().Storage,
          Key: content.Key,
        }),
      );
      metadata = this.CloudMetadataService.DecodeMetadataFromS3(head.Metadata);
      contentType = head.ContentType;
    }

    const SignedUrl = await this.CloudS3Service.SignedUrlBuilder(
      content,
      IsSignedUrlProcessing,
      this.CloudS3Service,
      this.CloudS3Service.PresignedUrlExpirySeconds,
    );

    const Name = content.Key?.split('/').pop();
    const Extension = Name?.includes('.') ? Name.split('.').pop() : '';

    return {
      Name: Name,
      Extension: Extension,
      MimeType:
        (contentType ?? MimeTypeFromExtension(Extension)) ||
        'application/octet-stream',
      Path: {
        Host: this.CloudS3Service.GetPublicHostname(),
        Key: this.CloudS3Service.GetKey(content.Key!, GetStorageOwnerId(User)),
        Url: SignedUrl,
      },
      Metadata: metadata,
      Size: content.Size,
      ETag: content.ETag,
      LastModified: content.LastModified
        ? content.LastModified.toISOString()
        : '',
    };
  }

  private async ListDirectoryThumbnails(
    directoryPrefix: string,
    User: UserContext,
    IsSignedUrlProcessing: boolean,
  ): Promise<CloudObjectModel[]> {
    const normalizedPrefix = NormalizeDirectoryPath(directoryPrefix);
    if (!normalizedPrefix) {
      return [];
    }

    const prefix = KeyBuilder([GetStorageOwnerId(User), normalizedPrefix]);
    const cacheKey = CloudKeys.DirectoryThumbnails(
      GetStorageOwnerId(User),
      normalizedPrefix,
      IsSignedUrlProcessing,
    );
    const cached = await this.RedisService.Get<CloudObjectModel[]>(cacheKey);
    if (cached !== undefined) {
      return cached;
    }

    const thumbnails: CloudObjectModel[] = [];
    const foldersUsed = new Set<string>();
    const folderOrder: string[] = [];
    const folderBuckets = new Map<string, CloudObjectModel[]>();
    let continuationToken: string | undefined = undefined;

    const totalBucketItems = (): number =>
      Array.from(folderBuckets.values()).reduce(
        (total, bucket) => total + bucket.length,
        0,
      );

    while (true) {
      const command = await this.CloudS3Service.Send(
        new ListObjectsV2Command({
          Bucket: this.CloudS3Service.GetBuckets().Storage,
          Prefix: prefix,
          MaxKeys: this.MaxListObjects,
          ContinuationToken: continuationToken,
        }),
      );

      for (const content of command.Contents ?? []) {
        const key = content.Key;
        if (!key) {
          continue;
        }
        if (this.IsDirectory(key)) {
          continue;
        }
        if (!IsImageFile(key)) {
          continue;
        }
        const groupKey = this.GetThumbnailGroupKey(prefix, key);
        if (
          groupKey &&
          !foldersUsed.has(groupKey) &&
          foldersUsed.size >= this.DirectoryThumbnailMaxFolders
        ) {
          continue;
        }
        if (groupKey) {
          if (!foldersUsed.has(groupKey)) {
            foldersUsed.add(groupKey);
            folderOrder.push(groupKey);
            folderBuckets.set(groupKey, []);
          }
          const bucket = folderBuckets.get(groupKey);
          if (bucket && bucket.length < this.DirectoryThumbnailLimit) {
            bucket.push(
              await this.BuildObjectModel(
                content,
                User,
                false,
                IsSignedUrlProcessing,
              ),
            );
          }
          continue;
        }

        if (!foldersUsed.has('root')) {
          foldersUsed.add('root');
          folderOrder.push('root');
          folderBuckets.set('root', []);
        }
        const rootBucket = folderBuckets.get('root');
        if (rootBucket && rootBucket.length < this.DirectoryThumbnailLimit) {
          rootBucket.push(
            await this.BuildObjectModel(
              content,
              User,
              false,
              IsSignedUrlProcessing,
            ),
          );
        }
      }

      if (
        totalBucketItems() >= this.DirectoryThumbnailLimit &&
        foldersUsed.size >= this.DirectoryThumbnailMaxFolders
      ) {
        break;
      }

      if (!command.IsTruncated) {
        break;
      }
      continuationToken = command.NextContinuationToken;
    }

    while (thumbnails.length < this.DirectoryThumbnailLimit) {
      let added = false;
      for (const folderKey of folderOrder) {
        const bucket = folderBuckets.get(folderKey);
        if (!bucket || bucket.length === 0) {
          continue;
        }
        const item = bucket.shift();
        if (item) {
          thumbnails.push(item);
          added = true;
          if (thumbnails.length >= this.DirectoryThumbnailLimit) {
            break;
          }
        }
      }
      if (!added) {
        break;
      }
    }

    const ttlSeconds = IsSignedUrlProcessing
      ? Math.min(
          CLOUD_THUMBNAIL_CACHE_TTL,
          Math.max(1, this.CloudS3Service.PresignedUrlExpirySeconds - 60),
        )
      : CLOUD_THUMBNAIL_CACHE_TTL;
    await this.RedisService.Set(cacheKey, thumbnails, ttlSeconds);

    return thumbnails;
  }

  async InvalidateDirectoryThumbnailCache(
    userId: string,
    directoryPath: string,
  ): Promise<void> {
    const normalized = NormalizeDirectoryPath(directoryPath);
    if (!normalized) {
      return;
    }
    const ancestors = this.GetDirectoryAncestors(normalized);
    for (const path of ancestors) {
      await this.RedisService.Delete(
        CloudKeys.DirectoryThumbnails(userId, path, false),
      );
      await this.RedisService.Delete(
        CloudKeys.DirectoryThumbnails(userId, path, true),
      );
    }
  }

  async InvalidateThumbnailCacheForObjectKey(
    userId: string,
    objectKey: string,
  ): Promise<void> {
    const parent = this.GetParentDirectoryPath(objectKey);
    if (!parent) {
      return;
    }
    await this.InvalidateDirectoryThumbnailCache(userId, parent);
  }

  /**
   * Invalidate all list/directory/object listing caches for a user.
   * Call after any mutation (upload, delete, move, rename, directory changes).
   */
  async InvalidateListCache(userId: string): Promise<void> {
    await this.RedisService.DeleteByPattern(CloudKeys.ListAllPattern(userId));
  }

  private GetDirectoryAncestors(path: string): string[] {
    const normalized = NormalizeDirectoryPath(path);
    if (!normalized) {
      return [];
    }
    const parts = normalized.split('/').filter((part) => !!part);
    const ancestors: string[] = [];
    for (let i = parts.length; i >= 1; i -= 1) {
      ancestors.push(parts.slice(0, i).join('/'));
    }
    return ancestors;
  }

  private GetParentDirectoryPath(path: string): string {
    const normalized = NormalizeDirectoryPath(path);
    if (!normalized) {
      return '';
    }
    const parts = normalized.split('/').filter((part) => !!part);
    if (parts.length <= 1) {
      return '';
    }
    parts.pop();
    return parts.join('/');
  }

  private GetThumbnailGroupKey(
    prefix: string,
    objectKey: string,
  ): string | null {
    if (!objectKey.startsWith(prefix)) {
      return null;
    }
    const relative = objectKey.slice(prefix.length);
    const parts = relative.split('/').filter((part) => !!part);
    if (parts.length <= 1) {
      return 'root';
    }
    return parts[0];
  }

  private IsInsideEncryptedFolder(
    relativePath: string,
    encryptedFolders?: Set<string>,
  ): boolean {
    if (!encryptedFolders || encryptedFolders.size === 0) return false;
    for (const folder of encryptedFolders) {
      if (relativePath === folder || relativePath.startsWith(folder + '/')) {
        return true;
      }
    }
    return false;
  }

  private FindEncryptingFolder(
    relativePath: string,
    encryptedFolders?: Set<string>,
  ): string | null {
    if (!encryptedFolders) return null;
    for (const folder of encryptedFolders) {
      if (relativePath === folder || relativePath.startsWith(folder + '/')) {
        return folder;
      }
    }
    return null;
  }

  private IsInsideHiddenFolder(
    relativePath: string,
    hiddenFolders?: Set<string>,
  ): boolean {
    if (!hiddenFolders || hiddenFolders.size === 0) return false;
    for (const folder of hiddenFolders) {
      if (relativePath === folder || relativePath.startsWith(folder + '/')) {
        return true;
      }
    }
    return false;
  }

  private FindHiddenFolder(
    relativePath: string,
    hiddenFolders?: Set<string>,
  ): string | null {
    if (!hiddenFolders) return null;
    for (const folder of hiddenFolders) {
      if (relativePath === folder || relativePath.startsWith(folder + '/')) {
        return folder;
      }
    }
    return null;
  }
}
