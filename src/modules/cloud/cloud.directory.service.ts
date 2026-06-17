import {
  CopyObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { Readable } from 'stream';
import {
  createCipheriv,
  createDecipheriv,
  pbkdf2Sync,
  randomBytes,
} from 'crypto';
import {
  CloudKeyRequestModel,
  CloudRenameDirectoryRequestModel,
  DirectoryCreateRequestModel,
  DirectoryRenameRequestModel,
  DirectoryDeleteRequestModel,
  DirectoryUnlockRequestModel,
  DirectoryUnlockResponseModel,
  DirectoryLockRequestModel,
  DirectoryConvertToEncryptedRequestModel,
  DirectoryDecryptRequestModel,
  DirectoryResponseModel,
  DirectoryHideRequestModel,
  DirectoryUnhideRequestModel,
  DirectoryRevealRequestModel,
  DirectoryRevealResponseModel,
  DirectoryConcealRequestModel,
  ConflictDetailsResponseModel,
} from './cloud.model';
import { CloudS3Service } from './cloud.s3.service';
import { CloudConflictService } from './cloud.conflict.service';
import { CloudVersionService } from './cloud.version.service';
import { RedisService } from '@modules/redis/redis.service';
import { CloudKeys } from '@modules/redis/redis.keys';
import {
  ENCRYPTED_FOLDER_SESSION_TTL,
  ENCRYPTED_MANIFEST_CACHE_TTL,
  HIDDEN_FOLDER_SESSION_TTL,
  HIDDEN_MANIFEST_CACHE_TTL,
} from '@modules/redis/redis.ttl';
import { EncodeCopySource, KeyBuilder } from '@common/helpers/cast.helper';
import { GetStorageOwnerId } from './cloud.context';
import { EnsureTrailingSlash, NormalizeDirectoryPath } from './cloud.utils';
import { CloudUsageService } from './cloud.usage.service';
import { ConflictResolutionStrategy } from '@common/enums';

type EncryptedFolderRecord = {
  ciphertext: string;
  iv: string;
  authTag: string;
  salt: string;
  createdAt: string;
  updatedAt: string;
};

type EncryptedFolderManifest = {
  folders: Record<string, EncryptedFolderRecord>;
};

type EncryptedFolderSession = {
  token: string;
  folderPath: string;
  folderKey: string;
  expiresAt: number;
};

type HiddenFolderRecord = {
  ciphertext: string;
  iv: string;
  authTag: string;
  salt: string;
  createdAt: string;
  updatedAt: string;
};

type HiddenFolderManifest = {
  folders: Record<string, HiddenFolderRecord>;
};

type HiddenFolderSession = {
  token: string;
  folderPath: string;
  folderKey: string;
  expiresAt: number;
};

@Injectable()
export class CloudDirectoryService {
  private readonly Logger = new Logger(CloudDirectoryService.name);
  private readonly EmptyFolderPlaceholder = '.emptyFolderPlaceholder';
  private readonly EncryptedFoldersManifestKey =
    '.secure/encrypted-folders.json';
  private readonly HiddenFoldersManifestKey = '.secure/hidden-folders.json';
  private readonly EncryptedFolderKeyBytes = 32;
  private readonly EncryptedFolderIvLength = 12;
  private readonly EncryptedFolderKdfIterations = 120000;
  private readonly EncryptedFolderAlgorithm = 'aes-256-gcm';
  private readonly MaxListObjects = 1000;

  constructor(
    private readonly CloudS3Service: CloudS3Service,
    private readonly CloudConflictService: CloudConflictService,
    private readonly CloudVersionService: CloudVersionService,
    private readonly RedisService: RedisService,
    private readonly CloudUsageService: CloudUsageService,
  ) {}

  async CreateDirectory(
    { Key }: CloudKeyRequestModel,
    User: UserContext,
  ): Promise<boolean> {
    const directoryKey =
      Key.replace(/^\/+|\/+$/g, '') + '/' + this.EmptyFolderPlaceholder;

    await this.CloudS3Service.Send(
      new PutObjectCommand({
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        Key: KeyBuilder([GetStorageOwnerId(User), directoryKey]),
        Body: '',
      }),
    );

    return true;
  }

  async RenameDirectory(
    { Key, Name }: CloudRenameDirectoryRequestModel,
    User: UserContext,
    options?: {
      allowEncryptedDirectories?: boolean;
      ConflictStrategy?: ConflictResolutionStrategy;
    },
  ): Promise<boolean> {
    const sourcePath = NormalizeDirectoryPath(Key);
    if (!sourcePath) {
      throw new HttpException(
        'Directory path is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!options?.allowEncryptedDirectories) {
      const encryptedFolders = await this.GetEncryptedFolderSet(User);
      if (encryptedFolders.has(sourcePath)) {
        throw new HttpException(
          'Encrypted folders must be renamed via the encrypted-folder endpoint.',
          HttpStatus.FORBIDDEN,
        );
      }
    }

    const trimmedName = (Name || '').trim();
    if (!trimmedName) {
      throw new HttpException(
        'Directory name is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const sanitizedName = trimmedName.replace(/^\/+|\/+$/g, '');
    if (!sanitizedName) {
      throw new HttpException(
        'Directory name is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const segments = sourcePath.split('/').filter((segment) => !!segment);
    if (!segments.length) {
      throw new HttpException(
        'Directory path is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const parentSegments = segments.slice(0, -1);
    const targetPath = parentSegments.length
      ? `${parentSegments.join('/')}/${sanitizedName}`
      : sanitizedName;
    let normalizedTargetPath = NormalizeDirectoryPath(targetPath);

    if (!normalizedTargetPath) {
      throw new HttpException(
        'Target directory path is invalid',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (normalizedTargetPath === sourcePath) {
      return true;
    }

    const bucket = this.CloudS3Service.GetBuckets().Storage;
    const sourcePrefixFull = EnsureTrailingSlash(
      KeyBuilder([GetStorageOwnerId(User), sourcePath]),
    );
    let targetPrefixFull = EnsureTrailingSlash(
      KeyBuilder([GetStorageOwnerId(User), normalizedTargetPath]),
    );

    try {
      const targetCheck = await this.CloudS3Service.Send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: targetPrefixFull,
          MaxKeys: 1,
        }),
      );

      const targetExists =
        (targetCheck.KeyCount ?? targetCheck.Contents?.length ?? 0) > 0;

      if (targetExists) {
        const strategy =
          options?.ConflictStrategy ?? ConflictResolutionStrategy.FAIL;

        if (strategy === ConflictResolutionStrategy.FAIL) {
          throw new HttpException(
            plainToInstance(ConflictDetailsResponseModel, {
              Conflicts: [
                this.CloudConflictService.BuildConflictDetail(
                  {
                    Name: sourcePath.split('/').pop() || '',
                    Key: sourcePath,
                    IsDirectory: true,
                  },
                  {
                    Name: sanitizedName,
                    Key: normalizedTargetPath,
                    IsDirectory: true,
                  },
                ),
              ],
              TotalItems: 1,
              ConflictCount: 1,
            }),
            HttpStatus.CONFLICT,
          );
        }

        if (strategy === ConflictResolutionStrategy.SKIP) {
          return true;
        }

        if (strategy === ConflictResolutionStrategy.KEEP_BOTH) {
          const newTargetFull =
            await this.CloudConflictService.GenerateKeepBothKey(
              targetPrefixFull,
              true,
            );
          // Extract user-relative path from the resolved full key
          const ownerPrefix = GetStorageOwnerId(User) + '/';
          const newRelativePath = newTargetFull.startsWith(ownerPrefix)
            ? newTargetFull.slice(ownerPrefix.length)
            : newTargetFull;
          normalizedTargetPath = NormalizeDirectoryPath(newRelativePath);
          targetPrefixFull = EnsureTrailingSlash(
            KeyBuilder([GetStorageOwnerId(User), normalizedTargetPath]),
          );
        }

        if (strategy === ConflictResolutionStrategy.REPLACE) {
          // Delete target directory contents before proceeding
          await this.DeleteDirectoryContents(normalizedTargetPath, User);
        }
      }

      let continuationToken: string | undefined = undefined;
      let movedObjects = 0;

      do {
        const listResp = await this.CloudS3Service.Send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: sourcePrefixFull,
            ContinuationToken: continuationToken,
            MaxKeys: this.MaxListObjects,
          }),
        );

        const contents = listResp.Contents || [];
        if (!contents.length && !listResp.IsTruncated && movedObjects === 0) {
          throw new HttpException(
            Codes.Error.Cloud.FILE_NOT_FOUND,
            HttpStatus.NOT_FOUND,
          );
        }

        for (const content of contents) {
          if (!content.Key) {
            continue;
          }

          const suffix = content.Key.startsWith(sourcePrefixFull)
            ? content.Key.slice(sourcePrefixFull.length)
            : '';
          const destinationKey = suffix
            ? targetPrefixFull + suffix
            : targetPrefixFull.slice(0, -1);

          await this.CloudS3Service.Send(
            new CopyObjectCommand({
              Bucket: bucket,
              CopySource: EncodeCopySource(bucket, content.Key),
              Key: destinationKey,
            }),
          );

          await this.CloudVersionService.PermanentlyDeleteAllVersions(
            bucket,
            content.Key,
          );

          movedObjects++;
        }

        continuationToken = listResp.IsTruncated
          ? listResp.NextContinuationToken
          : undefined;
      } while (continuationToken);

      await this.UpdateEncryptedFoldersAfterRename(
        sourcePath,
        normalizedTargetPath,
        User,
      );

      await this.UpdateHiddenFoldersAfterRename(
        sourcePath,
        normalizedTargetPath,
        User,
      );

      return true;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      if (this.CloudS3Service.IsNotFoundError(error)) {
        throw new HttpException(Codes.Error.Cloud.FILE_NOT_FOUND, 404);
      }
      throw error;
    }
  }

  async DirectoryCreate(
    { Path, IsEncrypted, ConflictStrategy }: DirectoryCreateRequestModel,
    passphrase: string | undefined,
    User: UserContext,
  ): Promise<DirectoryResponseModel> {
    let normalizedPath = NormalizeDirectoryPath(Path);
    if (!normalizedPath) {
      throw new HttpException(
        'Directory path is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Conflict detection for non-encrypted directories (shared with the async
    // create-Start path so both run the same interactive 409/SKIP/KEEP_BOTH flow).
    if (!IsEncrypted) {
      const resolved = await this.ResolvePlainDirectoryTarget(
        normalizedPath,
        ConflictStrategy,
        User,
      );
      if (resolved.skip) {
        return plainToInstance(DirectoryResponseModel, {
          Path: resolved.path,
          IsEncrypted: false,
        });
      }
      normalizedPath = resolved.path;
    }

    if (IsEncrypted) {
      if (!passphrase || passphrase.length < 8) {
        throw new HttpException(
          'Passphrase is required (min 8 characters) for encrypted directories. Provide via X-Folder-Passphrase header.',
          HttpStatus.BAD_REQUEST,
        );
      }

      const manifest = await this.GetEncryptedFolderManifest(User);
      if (manifest.folders[normalizedPath]) {
        throw new HttpException(
          'Encrypted folder already exists',
          HttpStatus.CONFLICT,
        );
      }

      await this.CreateDirectory(
        { Key: normalizedPath } as CloudKeyRequestModel,
        User,
      );

      const folderKey = randomBytes(this.EncryptedFolderKeyBytes).toString(
        'base64',
      );
      const encrypted = this.EncryptFolderKey(passphrase, folderKey);

      const now = new Date().toISOString();
      manifest.folders[normalizedPath] = {
        ...encrypted,
        createdAt: now,
        updatedAt: now,
      };

      await this.SaveEncryptedFolderManifest(User, manifest);

      return plainToInstance(DirectoryResponseModel, {
        Path: normalizedPath,
        IsEncrypted: true,
        CreatedAt: now,
        UpdatedAt: now,
      });
    }

    await this.CreateDirectory(
      { Key: normalizedPath } as CloudKeyRequestModel,
      User,
    );

    return plainToInstance(DirectoryResponseModel, {
      Path: normalizedPath,
      IsEncrypted: false,
    });
  }

  /**
   * Synchronous conflict detection + path resolution for PLAIN (non-encrypted)
   * directory creation. Extracted so the async create path (the create-Start
   * endpoint) can run the SAME interactive 409/SKIP/KEEP_BOTH/REPLACE flow before
   * enqueuing the worker — only the S3 placeholder write is deferred. FAIL throws
   * a 409 with ConflictDetailsResponseModel; SKIP onto an existing folder returns
   * `{ skip: true }` (nothing to create); KEEP_BOTH returns the freshly-resolved
   * sibling path; REPLACE / no-conflict returns the normalized path as-is.
   */
  async ResolvePlainDirectoryTarget(
    Path: string,
    ConflictStrategy: ConflictResolutionStrategy | undefined,
    User: UserContext,
  ): Promise<{ path: string; skip: boolean }> {
    let normalizedPath = NormalizeDirectoryPath(Path);
    if (!normalizedPath) {
      throw new HttpException(
        'Directory path is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const fullPrefix = EnsureTrailingSlash(
      KeyBuilder([GetStorageOwnerId(User), normalizedPath]),
    );
    const exists =
      await this.CloudConflictService.CheckDirectoryExists(fullPrefix);
    if (exists) {
      const strategy = ConflictStrategy ?? ConflictResolutionStrategy.FAIL;

      if (strategy === ConflictResolutionStrategy.FAIL) {
        throw new HttpException(
          plainToInstance(ConflictDetailsResponseModel, {
            Conflicts: [
              this.CloudConflictService.BuildConflictDetail(
                {
                  Name: normalizedPath.split('/').pop() || '',
                  Key: normalizedPath,
                  IsDirectory: true,
                },
                {
                  Name: normalizedPath.split('/').pop() || '',
                  Key: normalizedPath,
                  IsDirectory: true,
                },
              ),
            ],
            TotalItems: 1,
            ConflictCount: 1,
          }),
          HttpStatus.CONFLICT,
        );
      }

      if (strategy === ConflictResolutionStrategy.SKIP) {
        return { path: normalizedPath, skip: true };
      }

      if (strategy === ConflictResolutionStrategy.KEEP_BOTH) {
        const resolvedFull =
          await this.CloudConflictService.GenerateKeepBothKey(fullPrefix, true);
        const ownerPrefix = GetStorageOwnerId(User) + '/';
        const newRelativePath = resolvedFull.startsWith(ownerPrefix)
          ? resolvedFull.slice(ownerPrefix.length)
          : resolvedFull;
        normalizedPath = NormalizeDirectoryPath(newRelativePath);
      }

      // REPLACE: continue (directory already exists, just proceed)
    }

    return { path: normalizedPath, skip: false };
  }

  async DirectoryRename(
    { Path, Name, ConflictStrategy }: DirectoryRenameRequestModel,
    passphrase: string | undefined,
    User: UserContext,
  ): Promise<DirectoryResponseModel> {
    const normalizedPath = NormalizeDirectoryPath(Path);
    if (!normalizedPath) {
      throw new HttpException(
        'Directory path is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const manifest = await this.GetEncryptedFolderManifest(User);
    const isEncrypted = !!manifest.folders[normalizedPath];

    if (isEncrypted) {
      if (!passphrase) {
        throw new HttpException(
          'Passphrase required for encrypted directories. Provide via X-Folder-Passphrase header.',
          HttpStatus.BAD_REQUEST,
        );
      }

      const entry = manifest.folders[normalizedPath];
      try {
        this.DecryptFolderKey(passphrase, entry);
      } catch {
        throw new HttpException('Invalid passphrase', HttpStatus.BAD_REQUEST);
      }
    }

    await this.RenameDirectory({ Key: normalizedPath, Name }, User, {
      allowEncryptedDirectories: isEncrypted,
      ConflictStrategy,
    });

    const segments = normalizedPath.split('/').filter((s) => !!s);
    const parentSegments = segments.slice(0, -1);
    const newPath = parentSegments.length
      ? `${parentSegments.join('/')}/${Name}`
      : Name;

    return plainToInstance(DirectoryResponseModel, {
      Path: NormalizeDirectoryPath(newPath),
      IsEncrypted: isEncrypted,
    });
  }

  async DirectoryDelete(
    { Path }: DirectoryDeleteRequestModel,
    passphrase: string | undefined,
    User: UserContext,
  ): Promise<boolean> {
    const normalizedPath = NormalizeDirectoryPath(Path);
    if (!normalizedPath) {
      throw new HttpException(
        'Directory path is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    const manifest = await this.GetEncryptedFolderManifest(User);
    const isEncrypted = !!manifest.folders[normalizedPath];

    if (isEncrypted) {
      if (!passphrase) {
        throw new HttpException(
          'Passphrase required for encrypted directories. Provide via X-Folder-Passphrase header.',
          HttpStatus.BAD_REQUEST,
        );
      }

      const entry = manifest.folders[normalizedPath];
      try {
        this.DecryptFolderKey(passphrase, entry);
      } catch {
        throw new HttpException('Invalid passphrase', HttpStatus.BAD_REQUEST);
      }

      await this.DeleteDirectoryContents(normalizedPath, User);

      delete manifest.folders[normalizedPath];
      await this.SaveEncryptedFolderManifest(User, manifest);
    } else {
      await this.DeleteDirectoryContents(normalizedPath, User);
    }

    return true;
  }

  async DeleteDirectoryContents(
    Key: string,
    User: UserContext,
  ): Promise<number> {
    const normalized = NormalizeDirectoryPath(Key);
    if (!normalized) {
      return 0;
    }

    const bucket = this.CloudS3Service.GetBuckets().Storage;
    const prefix = EnsureTrailingSlash(
      KeyBuilder([GetStorageOwnerId(User), normalized]),
    );

    // First pass: calculate total bytes from current versions for usage tracking
    let continuationToken: string | undefined = undefined;
    let totalBytes = 0;

    do {
      const list = await this.CloudS3Service.Send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: prefix,
          MaxKeys: this.MaxListObjects,
          ContinuationToken: continuationToken,
        }),
      );

      const contents = list.Contents || [];
      for (const content of contents) {
        if (content.Size) {
          totalBytes += content.Size;
        }
      }

      continuationToken = list.IsTruncated
        ? list.NextContinuationToken
        : undefined;
    } while (continuationToken);

    // Second pass: permanently delete all versions (including delete markers)
    await this.CloudVersionService.PermanentlyDeleteAllVersionsByPrefix(
      bucket,
      prefix,
    );

    if (totalBytes > 0) {
      await this.CloudUsageService.DecrementUsage(
        GetStorageOwnerId(User),
        totalBytes,
      );
    }

    return totalBytes;
  }

  async DirectoryUnlock(
    { Path }: DirectoryUnlockRequestModel,
    passphrase: string | undefined,
    User: UserContext,
  ): Promise<DirectoryUnlockResponseModel> {
    const normalizedPath = NormalizeDirectoryPath(Path);
    if (!normalizedPath) {
      throw new HttpException(
        'Directory path is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!passphrase || passphrase.length < 8) {
      throw new HttpException(
        'Passphrase is required (min 8 characters). Provide via X-Folder-Passphrase header.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const manifest = await this.GetEncryptedFolderManifest(User);

    let entry = manifest.folders[normalizedPath];
    let encryptedFolderPath = normalizedPath;

    if (!entry) {
      const pathSegments = normalizedPath.split('/');

      for (let i = pathSegments.length - 1; i > 0; i--) {
        const parentPath = pathSegments.slice(0, i).join('/');
        if (manifest.folders[parentPath]) {
          entry = manifest.folders[parentPath];
          encryptedFolderPath = parentPath;
          break;
        }
      }

      if (!entry) {
        throw new HttpException(
          'Encrypted folder not found',
          HttpStatus.NOT_FOUND,
        );
      }
    }

    let folderKey: string;
    try {
      folderKey = this.DecryptFolderKey(passphrase, entry);
    } catch {
      throw new HttpException('Invalid passphrase', HttpStatus.BAD_REQUEST);
    }

    const sessionToken = randomBytes(32).toString('hex');
    const expiresAt =
      Math.floor(Date.now() / 1000) + ENCRYPTED_FOLDER_SESSION_TTL;

    const session: EncryptedFolderSession = {
      token: sessionToken,
      folderPath: encryptedFolderPath,
      folderKey,
      expiresAt,
    };

    const cacheKey = CloudKeys.EncryptedFolderSession(
      GetStorageOwnerId(User),
      encryptedFolderPath,
    );
    await this.RedisService.Set(
      cacheKey,
      session,
      ENCRYPTED_FOLDER_SESSION_TTL,
    );

    if (normalizedPath !== encryptedFolderPath) {
      const childCacheKey = CloudKeys.EncryptedFolderSession(
        GetStorageOwnerId(User),
        normalizedPath,
      );
      await this.RedisService.Set(
        childCacheKey,
        session,
        ENCRYPTED_FOLDER_SESSION_TTL,
      );
    }

    return plainToInstance(DirectoryUnlockResponseModel, {
      Path: normalizedPath,
      EncryptedFolderPath: encryptedFolderPath,
      SessionToken: sessionToken,
      ExpiresAt: expiresAt,
      TTL: ENCRYPTED_FOLDER_SESSION_TTL,
    });
  }

  async DirectoryLock(
    { Path }: DirectoryLockRequestModel,
    User: UserContext,
  ): Promise<boolean> {
    const normalizedPath = NormalizeDirectoryPath(Path);
    if (!normalizedPath) {
      throw new HttpException(
        'Directory path is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.RedisService.DeleteByPattern(
      CloudKeys.EncryptedFolderSessionPattern(
        GetStorageOwnerId(User),
        normalizedPath,
      ),
    );

    return true;
  }

  async DirectoryConvertToEncrypted(
    { Path }: DirectoryConvertToEncryptedRequestModel,
    passphrase: string | undefined,
    User: UserContext,
  ): Promise<DirectoryResponseModel> {
    const normalizedPath = NormalizeDirectoryPath(Path);
    if (!normalizedPath) {
      throw new HttpException(
        'Directory path is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!passphrase || passphrase.length < 8) {
      throw new HttpException(
        'Passphrase is required (min 8 characters). Provide via X-Folder-Passphrase header.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const manifest = await this.GetEncryptedFolderManifest(User);
    if (manifest.folders[normalizedPath]) {
      throw new HttpException(
        'Directory is already encrypted',
        HttpStatus.CONFLICT,
      );
    }

    const ensureTrailingSlash = (value: string): string =>
      value.endsWith('/') ? value : value + '/';
    const directoryPrefix = ensureTrailingSlash(
      KeyBuilder([GetStorageOwnerId(User), normalizedPath]),
    );

    const listResponse = await this.CloudS3Service.Send(
      new ListObjectsV2Command({
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        Prefix: directoryPrefix,
        MaxKeys: 1,
      }),
    );

    const hasObjects = (listResponse.Contents?.length ?? 0) > 0;
    if (!hasObjects) {
      throw new HttpException(
        'Directory not found or is empty',
        HttpStatus.NOT_FOUND,
      );
    }

    const folderKey = randomBytes(this.EncryptedFolderKeyBytes).toString(
      'base64',
    );
    const encrypted = this.EncryptFolderKey(passphrase, folderKey);
    const now = new Date().toISOString();

    manifest.folders[normalizedPath] = {
      ...encrypted,
      createdAt: now,
      updatedAt: now,
    };

    await this.SaveEncryptedFolderManifest(User, manifest);

    return plainToInstance(DirectoryResponseModel, {
      Path: normalizedPath,
      IsEncrypted: true,
      CreatedAt: now,
      UpdatedAt: now,
    });
  }

  async DirectoryDecrypt(
    { Path }: DirectoryDecryptRequestModel,
    passphrase: string | undefined,
    User: UserContext,
  ): Promise<DirectoryResponseModel> {
    const normalizedPath = NormalizeDirectoryPath(Path);
    if (!normalizedPath) {
      throw new HttpException(
        'Directory path is required',
        HttpStatus.BAD_REQUEST,
      );
    }

    if (!passphrase) {
      throw new HttpException(
        'Passphrase is required. Provide via X-Folder-Passphrase header.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const manifest = await this.GetEncryptedFolderManifest(User);
    const entry = manifest.folders[normalizedPath];

    if (!entry) {
      throw new HttpException(
        'Directory is not encrypted',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      this.DecryptFolderKey(passphrase, entry);
    } catch {
      throw new HttpException('Invalid passphrase', HttpStatus.BAD_REQUEST);
    }

    delete manifest.folders[normalizedPath];
    await this.SaveEncryptedFolderManifest(User, manifest);

    return plainToInstance(DirectoryResponseModel, {
      Path: normalizedPath,
      IsEncrypted: false,
    });
  }

  async ValidateDirectorySession(
    userId: string,
    folderPath: string,
    sessionToken: string,
  ): Promise<EncryptedFolderSession | null> {
    const normalizedPath = NormalizeDirectoryPath(folderPath);

    const cacheKey = CloudKeys.EncryptedFolderSession(userId, normalizedPath);
    const session =
      await this.RedisService.Get<EncryptedFolderSession>(cacheKey);

    if (!session || session.token !== sessionToken) {
      return null;
    }

    if (session.expiresAt < Math.floor(Date.now() / 1000)) {
      await this.RedisService.Delete(cacheKey);
      return null;
    }

    return session;
  }

  async CheckEncryptedFolderAccess(
    path: string,
    userId: string,
    sessionToken?: string,
  ): Promise<{
    isEncrypted: boolean;
    hasAccess: boolean;
    encryptingFolder?: string;
  }> {
    const normalizedPath = NormalizeDirectoryPath(path);
    const manifest = await this.GetEncryptedFolderManifestByUserId(userId);

    let encryptingFolder: string | undefined;
    for (const encPath of Object.keys(manifest.folders)) {
      if (
        normalizedPath === encPath ||
        normalizedPath.startsWith(encPath + '/')
      ) {
        encryptingFolder = encPath;
        break;
      }
    }

    if (!encryptingFolder) {
      return { isEncrypted: false, hasAccess: true };
    }

    if (!sessionToken) {
      return { isEncrypted: true, hasAccess: false, encryptingFolder };
    }

    const session = await this.ValidateDirectorySession(
      userId,
      encryptingFolder,
      sessionToken,
    );

    return {
      isEncrypted: true,
      hasAccess: !!session,
      encryptingFolder,
    };
  }

  /**
   * The HIDDEN-folder counterpart of {@link CheckEncryptedFolderAccess}: is
   * `path` itself a hidden folder or inside one (ancestor-aware), and if so does
   * the caller hold a valid reveal session for it? Listing inside a hidden folder
   * must be gated the same way encrypted is — otherwise the per-entry conceal
   * filter (which only hides directly-hidden children) leaks the folder's OWN
   * files and subfolders once you're inside it.
   */
  async CheckHiddenFolderAccess(
    path: string,
    userId: string,
    hiddenSessionToken?: string,
  ): Promise<{
    isHidden: boolean;
    hasAccess: boolean;
    hidingFolder?: string;
  }> {
    const normalizedPath = NormalizeDirectoryPath(path);
    const manifest = await this.GetHiddenFolderManifestByUserId(userId);

    let hidingFolder: string | undefined;
    for (const hidPath of Object.keys(manifest.folders)) {
      if (
        normalizedPath === hidPath ||
        normalizedPath.startsWith(hidPath + '/')
      ) {
        hidingFolder = hidPath;
        break;
      }
    }

    if (!hidingFolder) {
      return { isHidden: false, hasAccess: true };
    }

    if (!hiddenSessionToken) {
      return { isHidden: true, hasAccess: false, hidingFolder };
    }

    const session = await this.ValidateHiddenSession(
      userId,
      hidingFolder,
      hiddenSessionToken,
    );

    return {
      isHidden: true,
      hasAccess: !!session,
      hidingFolder,
    };
  }

  async GetActiveSession(
    userId: string,
    folderPath: string,
  ): Promise<EncryptedFolderSession | null> {
    const cacheKey = CloudKeys.EncryptedFolderSession(userId, folderPath);
    const session =
      await this.RedisService.Get<EncryptedFolderSession>(cacheKey);

    if (!session || session.expiresAt < Math.floor(Date.now() / 1000)) {
      return null;
    }

    return session;
  }

  async GetEncryptedFolderSet(User: UserContext): Promise<Set<string>> {
    const manifest = await this.GetEncryptedFolderManifest(User);
    return this.BuildEncryptedFolderSet(manifest);
  }

  private async UpdateEncryptedFoldersAfterRename(
    sourcePath: string,
    targetPath: string,
    User: UserContext,
  ): Promise<void> {
    const manifest = await this.GetEncryptedFolderManifest(User);
    const folders = manifest.folders || {};
    const updatedFolders: Record<string, EncryptedFolderRecord> = {};
    const sourcePrefix = sourcePath + '/';
    let hasChanges = false;
    const now = new Date().toISOString();

    for (const [path, record] of Object.entries(folders)) {
      if (path === sourcePath || path.startsWith(sourcePrefix)) {
        const suffix = path.slice(sourcePath.length);
        const normalizedSuffix = suffix.startsWith('/')
          ? suffix.slice(1)
          : suffix;
        const updatedPath = normalizedSuffix
          ? `${targetPath}/${normalizedSuffix}`
          : targetPath;
        const normalizedUpdatedPath = NormalizeDirectoryPath(updatedPath);
        updatedFolders[normalizedUpdatedPath] = {
          ...record,
          updatedAt: now,
        };
        hasChanges = true;
      } else {
        updatedFolders[path] = record;
      }
    }

    if (hasChanges) {
      manifest.folders = updatedFolders;
      await this.SaveEncryptedFolderManifest(User, manifest);
    }
  }

  private BuildEncryptedFolderSet(
    manifest: EncryptedFolderManifest,
  ): Set<string> {
    const folders = manifest.folders || {};
    const set = new Set<string>();
    for (const path of Object.keys(folders)) {
      const normalized = NormalizeDirectoryPath(path);
      if (normalized) {
        set.add(normalized);
      }
    }
    return set;
  }

  private async GetEncryptedFolderManifest(
    User: UserContext,
  ): Promise<EncryptedFolderManifest> {
    // Try Redis cache first
    const cacheKey = CloudKeys.EncryptedFolderManifest(GetStorageOwnerId(User));
    const cached =
      await this.RedisService.Get<EncryptedFolderManifest>(cacheKey);
    if (cached) {
      return cached;
    }

    const manifestKey = KeyBuilder([
      GetStorageOwnerId(User),
      this.EncryptedFoldersManifestKey,
    ]);

    try {
      const command = await this.CloudS3Service.Send(
        new GetObjectCommand({
          Bucket: this.CloudS3Service.GetBuckets().Storage,
          Key: manifestKey,
        }),
      );

      const body = command.Body as Readable;
      if (!body) {
        const empty: EncryptedFolderManifest = { folders: {} };
        await this.RedisService.Set(
          cacheKey,
          empty,
          ENCRYPTED_MANIFEST_CACHE_TTL,
        );
        return empty;
      }

      const json = await this.ReadStreamToString(body);
      if (!json) {
        const empty: EncryptedFolderManifest = { folders: {} };
        await this.RedisService.Set(
          cacheKey,
          empty,
          ENCRYPTED_MANIFEST_CACHE_TTL,
        );
        return empty;
      }

      let raw: Record<string, unknown> = {};
      try {
        raw = JSON.parse(json) as Record<string, unknown>;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (parseError) {
        const empty: EncryptedFolderManifest = { folders: {} };
        await this.RedisService.Set(
          cacheKey,
          empty,
          ENCRYPTED_MANIFEST_CACHE_TTL,
        );
        return empty;
      }
      const normalized: Record<string, EncryptedFolderRecord> = {};
      if (raw && typeof raw === 'object' && raw.folders) {
        for (const [path, entry] of Object.entries(
          raw.folders as Record<string, EncryptedFolderRecord>,
        )) {
          const normalizedPath = NormalizeDirectoryPath(path);
          if (
            normalizedPath &&
            entry &&
            typeof entry === 'object' &&
            entry.ciphertext &&
            entry.iv &&
            entry.authTag &&
            entry.salt
          ) {
            normalized[normalizedPath] = entry;
          }
        }
      }
      const manifest: EncryptedFolderManifest = { folders: normalized };
      await this.RedisService.Set(
        cacheKey,
        manifest,
        ENCRYPTED_MANIFEST_CACHE_TTL,
      );
      return manifest;
    } catch (error) {
      if (this.CloudS3Service.IsNotFoundError(error)) {
        const empty: EncryptedFolderManifest = { folders: {} };
        await this.RedisService.Set(
          cacheKey,
          empty,
          ENCRYPTED_MANIFEST_CACHE_TTL,
        );
        return empty;
      }
      this.Logger.error('Failed to load encrypted folder manifest', error);
      throw error;
    }
  }

  private async SaveEncryptedFolderManifest(
    User: UserContext,
    manifest: EncryptedFolderManifest,
  ): Promise<void> {
    const manifestKey = KeyBuilder([
      GetStorageOwnerId(User),
      this.EncryptedFoldersManifestKey,
    ]);

    await this.CloudS3Service.Send(
      new PutObjectCommand({
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        Key: manifestKey,
        Body: JSON.stringify({ folders: manifest.folders || {} }),
        ContentType: 'application/json',
      }),
    );

    // Invalidate the cached manifest
    await this.RedisService.Delete(
      CloudKeys.EncryptedFolderManifest(GetStorageOwnerId(User)),
    );
  }

  private EncryptFolderKey(
    passphrase: string,
    folderKey: string,
  ): Omit<EncryptedFolderRecord, 'createdAt' | 'updatedAt'> {
    const salt = randomBytes(16);
    const key = pbkdf2Sync(
      passphrase,
      salt,
      this.EncryptedFolderKdfIterations,
      32,
      'sha512',
    );
    const iv = randomBytes(this.EncryptedFolderIvLength);
    const cipher = createCipheriv(this.EncryptedFolderAlgorithm, key, iv);
    const encrypted = Buffer.concat([
      cipher.update(folderKey, 'utf8'),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    return {
      ciphertext: encrypted.toString('base64'),
      iv: iv.toString('base64'),
      authTag: authTag.toString('base64'),
      salt: salt.toString('base64'),
    };
  }

  private DecryptFolderKey(
    passphrase: string,
    record: EncryptedFolderRecord,
  ): string {
    const salt = Buffer.from(record.salt, 'base64');
    const key = pbkdf2Sync(
      passphrase,
      salt,
      this.EncryptedFolderKdfIterations,
      32,
      'sha512',
    );
    const iv = Buffer.from(record.iv, 'base64');
    const decipher = createDecipheriv(this.EncryptedFolderAlgorithm, key, iv);
    decipher.setAuthTag(Buffer.from(record.authTag, 'base64'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, 'base64')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  }

  private async ReadStreamToString(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      const bufferChunk = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(chunk instanceof Uint8Array ? chunk : String(chunk));
      chunks.push(bufferChunk);
    }
    return Buffer.concat(chunks).toString('utf8');
  }

  private async GetEncryptedFolderManifestByUserId(
    userId: string,
  ): Promise<EncryptedFolderManifest> {
    return this.GetEncryptedFolderManifest({ Id: userId } as UserContext);
  }

  // ============================================================================
  // HIDDEN FOLDER METHODS
  // ============================================================================

  async DirectoryHide(
    { Path }: DirectoryHideRequestModel,
    passphrase: string | undefined,
    User: UserContext,
  ): Promise<DirectoryResponseModel> {
    if (!Path) {
      throw new HttpException(
        'Directory path is required',
        HttpStatus.BAD_REQUEST,
      );
    }
    const normalizedPath = NormalizeDirectoryPath(Path);

    if (!passphrase || passphrase.length < 8) {
      throw new HttpException(
        'Passphrase is required (min 8 characters) for hidden directories. Provide via X-Folder-Passphrase header.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const manifest = await this.GetHiddenFolderManifest(User);
    if (manifest.folders[normalizedPath]) {
      throw new HttpException(
        'Directory is already hidden',
        HttpStatus.CONFLICT,
      );
    }

    const ensureTrailingSlash = (value: string): string =>
      value.endsWith('/') ? value : value + '/';
    const directoryPrefix = ensureTrailingSlash(
      KeyBuilder([GetStorageOwnerId(User), normalizedPath]),
    );

    const listResponse = await this.CloudS3Service.Send(
      new ListObjectsV2Command({
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        Prefix: directoryPrefix,
        MaxKeys: 1,
      }),
    );

    const hasObjects = (listResponse.Contents?.length ?? 0) > 0;
    if (!hasObjects) {
      throw new HttpException(
        'Directory not found or is empty',
        HttpStatus.NOT_FOUND,
      );
    }

    const folderKey = randomBytes(this.EncryptedFolderKeyBytes).toString(
      'base64',
    );
    const encrypted = this.EncryptFolderKey(passphrase, folderKey);
    const now = new Date().toISOString();

    manifest.folders[normalizedPath] = {
      ...encrypted,
      createdAt: now,
      updatedAt: now,
    };

    await this.SaveHiddenFolderManifest(User, manifest);

    return plainToInstance(DirectoryResponseModel, {
      Path: normalizedPath,
      IsEncrypted: false,
      CreatedAt: now,
      UpdatedAt: now,
    });
  }

  async DirectoryUnhide(
    { Path }: DirectoryUnhideRequestModel,
    passphrase: string | undefined,
    User: UserContext,
  ): Promise<DirectoryResponseModel> {
    if (!Path) {
      throw new HttpException(
        'Directory path is required',
        HttpStatus.BAD_REQUEST,
      );
    }
    const normalizedPath = NormalizeDirectoryPath(Path);

    if (!passphrase) {
      throw new HttpException(
        'Passphrase is required. Provide via X-Folder-Passphrase header.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const manifest = await this.GetHiddenFolderManifest(User);
    const entry = manifest.folders[normalizedPath];

    if (!entry) {
      throw new HttpException(
        'Directory is not hidden',
        HttpStatus.BAD_REQUEST,
      );
    }

    try {
      this.DecryptFolderKey(passphrase, entry);
    } catch {
      throw new HttpException('Invalid passphrase', HttpStatus.BAD_REQUEST);
    }

    delete manifest.folders[normalizedPath];
    await this.SaveHiddenFolderManifest(User, manifest);

    return plainToInstance(DirectoryResponseModel, {
      Path: normalizedPath,
      IsEncrypted: false,
    });
  }

  async DirectoryReveal(
    { Path }: DirectoryRevealRequestModel,
    passphrase: string | undefined,
    User: UserContext,
  ): Promise<DirectoryRevealResponseModel> {
    if (!Path) {
      throw new HttpException(
        'Directory path is required',
        HttpStatus.BAD_REQUEST,
      );
    }
    const normalizedPath = NormalizeDirectoryPath(Path);

    if (!passphrase || passphrase.length < 8) {
      throw new HttpException(
        'Passphrase is required (min 8 characters). Provide via X-Folder-Passphrase header.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const manifest = await this.GetHiddenFolderManifest(User);

    let entry = manifest.folders[normalizedPath];
    let hiddenFolderPath = normalizedPath;

    if (!entry) {
      const pathSegments = normalizedPath.split('/');

      for (let i = pathSegments.length - 1; i > 0; i--) {
        const parentPath = pathSegments.slice(0, i).join('/');
        if (manifest.folders[parentPath]) {
          entry = manifest.folders[parentPath];
          hiddenFolderPath = parentPath;
          break;
        }
      }

      // If parent search also fails, search for descendant hidden folders
      if (!entry) {
        return this.RevealDescendantHiddenFolders(
          normalizedPath,
          passphrase,
          manifest,
          User,
        );
      }
    }

    let folderKey: string;
    try {
      folderKey = this.DecryptFolderKey(passphrase, entry);
    } catch {
      throw new HttpException('Invalid passphrase', HttpStatus.BAD_REQUEST);
    }

    const sessionToken = randomBytes(32).toString('hex');
    const expiresAt = Math.floor(Date.now() / 1000) + HIDDEN_FOLDER_SESSION_TTL;

    const session: HiddenFolderSession = {
      token: sessionToken,
      folderPath: hiddenFolderPath,
      folderKey,
      expiresAt,
    };

    const cacheKey = CloudKeys.HiddenFolderSession(
      GetStorageOwnerId(User),
      hiddenFolderPath,
    );
    await this.RedisService.Set(cacheKey, session, HIDDEN_FOLDER_SESSION_TTL);

    if (normalizedPath !== hiddenFolderPath) {
      const childCacheKey = CloudKeys.HiddenFolderSession(
        GetStorageOwnerId(User),
        normalizedPath,
      );
      await this.RedisService.Set(
        childCacheKey,
        session,
        HIDDEN_FOLDER_SESSION_TTL,
      );
    }

    return plainToInstance(DirectoryRevealResponseModel, {
      Path: normalizedPath,
      HiddenFolderPath: hiddenFolderPath,
      SessionToken: sessionToken,
      ExpiresAt: expiresAt,
      TTL: HIDDEN_FOLDER_SESSION_TTL,
    });
  }

  async DirectoryConceal(
    { Path }: DirectoryConcealRequestModel,
    User: UserContext,
  ): Promise<boolean> {
    if (!Path) {
      throw new HttpException(
        'Directory path is required',
        HttpStatus.BAD_REQUEST,
      );
    }
    const normalizedPath = NormalizeDirectoryPath(Path);

    await this.RedisService.DeleteByPattern(
      CloudKeys.HiddenFolderSessionPattern(
        GetStorageOwnerId(User),
        normalizedPath,
      ),
    );

    return true;
  }

  async ValidateHiddenSession(
    userId: string,
    folderPath: string,
    sessionToken: string,
  ): Promise<HiddenFolderSession | null> {
    const normalizedPath = NormalizeDirectoryPath(folderPath);

    const cacheKey = CloudKeys.HiddenFolderSession(userId, normalizedPath);
    const session = await this.RedisService.Get<HiddenFolderSession>(cacheKey);

    if (!session || session.token !== sessionToken) {
      return null;
    }

    if (session.expiresAt < Math.floor(Date.now() / 1000)) {
      await this.RedisService.Delete(cacheKey);
      return null;
    }

    return session;
  }

  async GetHiddenFolderSet(User: UserContext): Promise<Set<string>> {
    const manifest = await this.GetHiddenFolderManifest(User);
    return this.BuildHiddenFolderSet(manifest);
  }

  async UpdateHiddenFoldersAfterRename(
    sourcePath: string,
    targetPath: string,
    User: UserContext,
  ): Promise<void> {
    const manifest = await this.GetHiddenFolderManifest(User);
    const folders = manifest.folders || {};
    const updatedFolders: Record<string, HiddenFolderRecord> = {};
    const sourcePrefix = sourcePath + '/';
    let hasChanges = false;
    const now = new Date().toISOString();

    for (const [path, record] of Object.entries(folders)) {
      if (path === sourcePath || path.startsWith(sourcePrefix)) {
        const suffix = path.slice(sourcePath.length);
        const normalizedSuffix = suffix.startsWith('/')
          ? suffix.slice(1)
          : suffix;
        const updatedPath = normalizedSuffix
          ? `${targetPath}/${normalizedSuffix}`
          : targetPath;
        const normalizedUpdatedPath = NormalizeDirectoryPath(updatedPath);
        updatedFolders[normalizedUpdatedPath] = {
          ...record,
          updatedAt: now,
        };
        hasChanges = true;
      } else {
        updatedFolders[path] = record;
      }
    }

    if (hasChanges) {
      manifest.folders = updatedFolders;
      await this.SaveHiddenFolderManifest(User, manifest);
    }
  }

  private BuildHiddenFolderSet(manifest: HiddenFolderManifest): Set<string> {
    const folders = manifest.folders || {};
    const set = new Set<string>();
    for (const path of Object.keys(folders)) {
      set.add(NormalizeDirectoryPath(path));
    }
    return set;
  }

  private async RevealDescendantHiddenFolders(
    normalizedPath: string,
    passphrase: string,
    manifest: HiddenFolderManifest,
    User: UserContext,
  ): Promise<DirectoryRevealResponseModel> {
    const matched: Array<{ path: string; folderKey: string }> = [];

    for (const [folderPath, folderEntry] of Object.entries(manifest.folders)) {
      const isDescendant =
        normalizedPath === ''
          ? true
          : folderPath.startsWith(normalizedPath + '/');

      if (!isDescendant) continue;

      try {
        const key = this.DecryptFolderKey(passphrase, folderEntry);
        matched.push({ path: folderPath, folderKey: key });
      } catch {
        // Passphrase does not match this folder
      }
    }

    if (matched.length === 0) {
      throw new HttpException('Hidden folder not found', HttpStatus.NOT_FOUND);
    }

    const sessionToken = randomBytes(32).toString('hex');
    const expiresAt = Math.floor(Date.now() / 1000) + HIDDEN_FOLDER_SESSION_TTL;

    for (const match of matched) {
      const session: HiddenFolderSession = {
        token: sessionToken,
        folderPath: match.path,
        folderKey: match.folderKey,
        expiresAt,
      };
      await this.RedisService.Set(
        CloudKeys.HiddenFolderSession(GetStorageOwnerId(User), match.path),
        session,
        HIDDEN_FOLDER_SESSION_TTL,
      );
    }

    return plainToInstance(DirectoryRevealResponseModel, {
      Path: normalizedPath,
      HiddenFolderPath: matched[0].path,
      SessionToken: sessionToken,
      ExpiresAt: expiresAt,
      TTL: HIDDEN_FOLDER_SESSION_TTL,
    });
  }

  private async GetHiddenFolderManifest(
    User: UserContext,
  ): Promise<HiddenFolderManifest> {
    const cacheKey = CloudKeys.HiddenFolderManifest(GetStorageOwnerId(User));
    const cached = await this.RedisService.Get<HiddenFolderManifest>(cacheKey);
    if (cached) {
      return cached;
    }

    const manifestKey = KeyBuilder([
      GetStorageOwnerId(User),
      this.HiddenFoldersManifestKey,
    ]);

    try {
      const command = await this.CloudS3Service.Send(
        new GetObjectCommand({
          Bucket: this.CloudS3Service.GetBuckets().Storage,
          Key: manifestKey,
        }),
      );

      const body = command.Body as Readable;
      if (!body) {
        const empty: HiddenFolderManifest = { folders: {} };
        await this.RedisService.Set(cacheKey, empty, HIDDEN_MANIFEST_CACHE_TTL);
        return empty;
      }

      const json = await this.ReadStreamToString(body);
      if (!json) {
        const empty: HiddenFolderManifest = { folders: {} };
        await this.RedisService.Set(cacheKey, empty, HIDDEN_MANIFEST_CACHE_TTL);
        return empty;
      }

      let raw: Record<string, unknown> = {};
      try {
        raw = JSON.parse(json) as Record<string, unknown>;
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
      } catch (parseError) {
        const empty: HiddenFolderManifest = { folders: {} };
        await this.RedisService.Set(cacheKey, empty, HIDDEN_MANIFEST_CACHE_TTL);

        return empty;
      }
      const normalized: Record<string, HiddenFolderRecord> = {};
      if (raw && typeof raw === 'object' && raw.folders) {
        for (const [path, entry] of Object.entries(
          raw.folders as Record<string, HiddenFolderRecord>,
        )) {
          const normalizedPath = NormalizeDirectoryPath(path);
          if (
            entry &&
            typeof entry === 'object' &&
            entry.ciphertext &&
            entry.iv &&
            entry.authTag &&
            entry.salt
          ) {
            normalized[normalizedPath] = entry;
          }
        }
      }
      const manifest: HiddenFolderManifest = { folders: normalized };
      await this.RedisService.Set(
        cacheKey,
        manifest,
        HIDDEN_MANIFEST_CACHE_TTL,
      );
      return manifest;
    } catch (error) {
      if (this.CloudS3Service.IsNotFoundError(error)) {
        const empty: HiddenFolderManifest = { folders: {} };
        await this.RedisService.Set(cacheKey, empty, HIDDEN_MANIFEST_CACHE_TTL);
        return empty;
      }
      this.Logger.error('Failed to load hidden folder manifest', error);
      throw error;
    }
  }

  private async SaveHiddenFolderManifest(
    User: UserContext,
    manifest: HiddenFolderManifest,
  ): Promise<void> {
    const manifestKey = KeyBuilder([
      GetStorageOwnerId(User),
      this.HiddenFoldersManifestKey,
    ]);

    await this.CloudS3Service.Send(
      new PutObjectCommand({
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        Key: manifestKey,
        Body: JSON.stringify({ folders: manifest.folders || {} }),
        ContentType: 'application/json',
      }),
    );

    await this.RedisService.Delete(
      CloudKeys.HiddenFolderManifest(GetStorageOwnerId(User)),
    );
  }

  private async GetHiddenFolderManifestByUserId(
    userId: string,
  ): Promise<HiddenFolderManifest> {
    return this.GetHiddenFolderManifest({ Id: userId } as UserContext);
  }
}
