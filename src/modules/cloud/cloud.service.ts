import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import { Readable } from 'stream';
import {
  CloudAbortMultipartUploadRequestModel,
  CloudBreadCrumbModel,
  CloudCompleteMultipartUploadRequestModel,
  CloudCompleteMultipartUploadResponseModel,
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
  CloudCreateMultipartUploadRequestModel,
  CloudCreateMultipartUploadResponseModel,
  CloudKeyRequestModel,
  CloudRenameDirectoryRequestModel,
  CloudGetMultipartPartUrlRequestModel,
  CloudGetMultipartPartUrlResponseModel,
  CloudGetMultipartPartUrlsBatchRequestModel,
  CloudGetMultipartPartUrlsBatchResponseModel,
  CloudListRequestModel,
  CloudListResponseModel,
  CloudObjectModel,
  CloudDeleteRequestModel,
  CloudMoveRequestModel,
  CloudUpdateRequestModel,
  CloudDirectoryModel,
  CloudListDirectoriesRequestModel,
  CloudListBreadcrumbRequestModel,
  CloudUploadPartRequestModel,
  CloudUploadPartResponseModel,
  CloudUserStorageUsageResponseModel,
  CloudScanStatusResponseModel,
  CloudPreSignedUrlRequestModel,
  CloudSearchRequestModel,
  CloudSearchResponseModel,
  CloudVersionListResponseModel,
  CloudRestoreVersionRequestModel,
  CloudDeleteVersionRequestModel,
  // New Directories API models
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
} from './cloud.model';
import {
  CloudDuplicateScanStartRequestModel,
  CloudDuplicateScanStartResponseModel,
  CloudDuplicateScanIdRequestModel,
  CloudDuplicateScanStatusResponseModel,
  CloudDuplicateScanResultResponseModel,
  CloudDuplicateScanCancelResponseModel,
} from './cloud.model';
import { asyncLocalStorage } from '@common/context/context.service';
import { CloudListService } from './cloud.list.service';
import { CloudObjectService } from './cloud.object.service';
import { CloudArchiveService } from './cloud.archive.service';
import { CloudUploadService } from './cloud.upload.service';
import { CloudDirectoryService } from './cloud.directory.service';
import { CloudUsageService } from './cloud.usage.service';
import { CloudScanService } from './cloud.scan.service';
import { CloudVersionService } from './cloud.version.service';
import { CloudDuplicateService } from './cloud.duplicate.service';
import { CloudS3Service } from './cloud.s3.service';
import { NormalizeDirectoryPath } from './cloud.utils';
import { GetStorageOwnerId } from './cloud.context';
import { KeyBuilder, SizeFormatter } from '@common/helpers/cast.helper';
import { RedisService } from '@modules/redis/redis.service';
import { CloudKeys } from '@modules/redis/redis.keys';
import { CLOUD_IDEMPOTENCY_TTL } from '@modules/redis/redis.ttl';
import { NotificationService } from '@modules/notification/notification.service';
import { NotificationType } from '@common/enums';

@Injectable()
export class CloudService {
  private readonly Logger = new Logger(CloudService.name);
  public readonly MaxMultipartUploadSizeBytes = 50 * 1024 * 1024; // 50 MB

  constructor(
    private readonly CloudListService: CloudListService,
    private readonly CloudObjectService: CloudObjectService,
    private readonly CloudArchiveService: CloudArchiveService,
    private readonly CloudUploadService: CloudUploadService,
    private readonly CloudDirectoryService: CloudDirectoryService,
    private readonly CloudUsageService: CloudUsageService,
    private readonly CloudScanService: CloudScanService,
    private readonly CloudVersionService: CloudVersionService,
    private readonly CloudDuplicateService: CloudDuplicateService,
    private readonly CloudS3Service: CloudS3Service,
    private readonly RedisService: RedisService,
    private readonly NotificationService: NotificationService,
  ) {}

  //#region List

  async List(
    { Path, Delimiter, IsMetadataProcessing }: CloudListRequestModel,
    User: UserContext,
    sessionToken?: string,
    hiddenSessionToken?: string,
  ): Promise<CloudListResponseModel> {
    const cleanedPath = Path ? Path.replace(/^\/+|\/+$/g, '') : '';

    // Check if we're trying to access an encrypted folder
    const accessCheck = await this.CheckEncryptedFolderAccess(
      cleanedPath,
      GetStorageOwnerId(User),
      sessionToken,
    );

    if (accessCheck.isEncrypted && !accessCheck.hasAccess) {
      throw new HttpException(
        `Access denied. Folder "${accessCheck.encryptingFolder}" is encrypted. Unlock it first via POST /Cloud/Directories/Unlock`,
        HttpStatus.FORBIDDEN,
      );
    }

    const encryptedFolders = await this.GetEncryptedFolderSet(User);
    const hiddenFolders = await this.GetHiddenFolderSet(User);

    return this.CloudListService.List(
      {
        Path,
        Delimiter,
        IsMetadataProcessing,
        Search: undefined,
        Skip: undefined,
        Take: undefined,
      },
      User,
      encryptedFolders,
      sessionToken,
      this.ValidateDirectorySession.bind(this),
      hiddenFolders,
      hiddenSessionToken,
      this.ValidateHiddenSession.bind(this),
    );
  }

  //#endregion

  async GetDownloadSpeedBytesPerSec(User: UserContext): Promise<number> {
    return this.CloudUsageService.GetDownloadSpeedBytesPerSec(User);
  }

  //#region Breadcrumb

  async ListBreadcrumb({
    Path,
    Delimiter,
  }: CloudListBreadcrumbRequestModel): Promise<CloudBreadCrumbModel[]> {
    const store = asyncLocalStorage.getStore();
    const request: Request = store?.get('request');

    const breadcrumb = await this.CloudListService.ProcessBreadcrumb(
      Path || '',
      Delimiter,
    );

    request.TotalRowCount = breadcrumb.length;

    return breadcrumb;
  }

  //#endregion

  //#region Directories

  async ListDirectories(
    { Path, Delimiter, Search, Skip, Take }: CloudListDirectoriesRequestModel,
    User: UserContext,
    sessionToken?: string,
    hiddenSessionToken?: string,
  ): Promise<CloudDirectoryModel[]> {
    const store = asyncLocalStorage.getStore();
    const request: Request = store?.get('request');

    const cleanedPath = Path ? Path.replace(/^\/+|\/+$/g, '') : '';

    // Check encrypted folder access
    const accessCheck = await this.CheckEncryptedFolderAccess(
      cleanedPath,
      GetStorageOwnerId(User),
      sessionToken,
    );

    if (accessCheck.isEncrypted && !accessCheck.hasAccess) {
      throw new HttpException(
        `Access denied. Folder "${accessCheck.encryptingFolder}" is encrypted. Unlock it first via POST /Cloud/Directories/Unlock`,
        HttpStatus.FORBIDDEN,
      );
    }

    const encryptedFolders = await this.GetEncryptedFolderSet(User);
    const hiddenFolders = await this.GetHiddenFolderSet(User);

    const result = await this.CloudListService.ListDirectories(
      { Path, Delimiter, IsMetadataProcessing: false, Search, Skip, Take },
      User,
      encryptedFolders,
      sessionToken,
      this.ValidateDirectorySession.bind(this),
      hiddenFolders,
      hiddenSessionToken,
      this.ValidateHiddenSession.bind(this),
    );

    if (request) {
      request.TotalRowCount = result.TotalCount;
    }

    return result.Directories;
  }

  //#endregion

  //#region Objects

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
    sessionToken?: string,
  ): Promise<CloudObjectModel[]> {
    const store = asyncLocalStorage.getStore();
    const request: Request = store?.get('request');

    const cleanedPath = Path ? Path.replace(/^\/+|\/+$/g, '') : '';

    // Check encrypted folder access
    const accessCheck = await this.CheckEncryptedFolderAccess(
      cleanedPath,
      GetStorageOwnerId(User),
      sessionToken,
    );

    if (accessCheck.isEncrypted && !accessCheck.hasAccess) {
      throw new HttpException(
        `Access denied. Folder "${accessCheck.encryptingFolder}" is encrypted. Unlock it first via POST /Cloud/Directories/Unlock`,
        HttpStatus.FORBIDDEN,
      );
    }

    const result = await this.CloudListService.ListObjects(
      { Path, Delimiter, IsMetadataProcessing, Search, Skip, Take },
      User,
    );

    if (request) {
      request.TotalRowCount = result.TotalCount;
    }

    return result.Objects;
  }

  //#endregion

  //#region Search

  async Search(
    {
      Query,
      Path,
      Extension,
      IsMetadataProcessing,
      Skip,
      Take,
    }: CloudSearchRequestModel,
    User: UserContext,
    sessionToken?: string,
    hiddenSessionToken?: string,
  ): Promise<CloudSearchResponseModel> {
    const store = asyncLocalStorage.getStore();
    const request: Request = store?.get('request');

    if (Path) {
      const cleanedPath = Path.replace(/^\/+|\/+$/g, '');
      const accessCheck = await this.CheckEncryptedFolderAccess(
        cleanedPath,
        GetStorageOwnerId(User),
        sessionToken,
      );

      if (accessCheck.isEncrypted && !accessCheck.hasAccess) {
        throw new HttpException(
          `Access denied. Folder "${accessCheck.encryptingFolder}" is encrypted. Unlock it first via POST /Cloud/Directories/Unlock`,
          HttpStatus.FORBIDDEN,
        );
      }
    }

    const encryptedFolders = await this.GetEncryptedFolderSet(User);
    const hiddenFolders = await this.GetHiddenFolderSet(User);

    const result = await this.CloudListService.SearchObjects(
      { Query, Path, Extension, IsMetadataProcessing, Skip, Take },
      User,
      encryptedFolders,
      sessionToken,
      this.ValidateDirectorySession.bind(this),
      hiddenFolders,
      hiddenSessionToken,
      this.ValidateHiddenSession.bind(this),
    );

    if (request) {
      request.TotalRowCount = result.TotalCount + result.TotalDirectoryCount;
    }

    return {
      Objects: result.Objects,
      Directories: result.Directories,
      TotalObjectCount: result.TotalCount,
      TotalDirectoryCount: result.TotalDirectoryCount,
    };
  }

  //#endregion

  //#region User Storage Usage

  async UserStorageUsage(
    User: UserContext,
  ): Promise<CloudUserStorageUsageResponseModel> {
    return this.CloudUsageService.UserStorageUsage(User);
  }

  async GetScanStatus(
    { Key }: CloudKeyRequestModel,
    User: UserContext,
  ): Promise<CloudScanStatusResponseModel | null> {
    const status = await this.CloudScanService.GetScanStatus(
      GetStorageOwnerId(User),
      Key,
    );
    if (!status) {
      return null;
    }
    return {
      Status: status.status,
      Reason: status.reason,
      Signature: status.signature,
      ScannedAt: status.scannedAt,
    };
  }

  //#endregion

  //#region Find

  async Find(
    { Key }: CloudKeyRequestModel,
    User: UserContext,
  ): Promise<CloudObjectModel> {
    return this.CloudObjectService.Find({ Key }, User);
  }

  //#endregion

  //#region PresignedURL

  async GetPresignedUrl(
    { Key, ExpiresInSeconds }: CloudPreSignedUrlRequestModel,
    User: UserContext,
  ): Promise<string> {
    return this.CloudObjectService.GetPresignedUrl(
      { Key, ExpiresInSeconds },
      User,
    );
  }

  //#region Get Object Stream

  async GetObjectStream(
    { Key }: CloudKeyRequestModel,
    User: UserContext,
  ): Promise<ReadableStream> {
    return this.CloudObjectService.GetObjectStream({ Key }, User);
  }

  // Return a Node Readable stream for the requested object (useful for piping)
  async GetObjectReadable(
    { Key }: CloudKeyRequestModel,
    User: UserContext,
  ): Promise<Readable> {
    return this.CloudObjectService.GetObjectReadable({ Key }, User);
  }

  //#endregion

  //#region Move

  async Move(
    { Items, DestinationKey, ConflictResolution }: CloudMoveRequestModel,
    User: UserContext,
    idempotencyKey?: string,
  ): Promise<boolean> {
    const cached = await this.GetIdempotentResult<boolean>(
      GetStorageOwnerId(User),
      'move',
      idempotencyKey,
    );
    if (cached !== undefined) {
      return cached;
    }
    const result = await this.CloudObjectService.Move(
      { Items, DestinationKey, ConflictResolution },
      User,
    );
    for (const item of Items) {
      await this.CloudListService.InvalidateThumbnailCacheForObjectKey(
        GetStorageOwnerId(User),
        item.Key,
      );
    }
    if (DestinationKey) {
      await this.CloudListService.InvalidateDirectoryThumbnailCache(
        GetStorageOwnerId(User),
        DestinationKey,
      );
    }
    await this.SetIdempotentResult(
      GetStorageOwnerId(User),
      'move',
      idempotencyKey,
      result,
    );
    await this.CloudListService.InvalidateListCache(GetStorageOwnerId(User));

    // Notify user about file move
    const movedNames = Items.map((i) => i.Key.split('/').pop() || i.Key);
    this.NotificationService.EmitToUser(
      User.Id,
      NotificationType.FILE_MOVED,
      'Files Moved',
      `${movedNames.length} item(s) moved to "${DestinationKey || 'root'}".`,
      { Items, DestinationKey, Count: Items.length },
    );

    return result;
  }

  //#endregion

  //#region Delete

  async Delete(
    { Items }: CloudDeleteRequestModel,
    User: UserContext,
    _options?: { allowEncryptedDirectories?: boolean },
    idempotencyKey?: string,
  ): Promise<boolean> {
    // mark _options as used to avoid unused-parameter errors
    void _options;
    const cached = await this.GetIdempotentResult<boolean>(
      GetStorageOwnerId(User),
      'delete',
      idempotencyKey,
    );
    if (cached !== undefined) {
      return cached;
    }
    const files: CloudDeleteRequestModel['Items'] = [];
    let bytesToDecrement = 0;
    for (const item of Items) {
      if (item.IsDirectory) {
        await this.CloudDirectoryService.DeleteDirectoryContents(
          item.Key,
          User,
        );
        await this.CloudListService.InvalidateDirectoryThumbnailCache(
          GetStorageOwnerId(User),
          item.Key,
        );
        continue;
      }
      try {
        const fileInfo = await this.CloudObjectService.Find(
          { Key: item.Key },
          User,
        );
        bytesToDecrement += fileInfo.Size || 0;
      } catch (error) {
        if (
          error instanceof HttpException &&
          error.getStatus() === HttpStatus.NOT_FOUND
        ) {
          continue;
        }
        throw error;
      }
      files.push(item);
    }

    if (files.length) {
      const deleted = await this.CloudObjectService.Delete(
        { Items: files },
        User,
      );
      for (const file of files) {
        await this.CloudListService.InvalidateThumbnailCacheForObjectKey(
          GetStorageOwnerId(User),
          file.Key,
        );
      }
      await this.CloudUsageService.DecrementUsage(
        GetStorageOwnerId(User),
        bytesToDecrement,
      );
      await this.SetIdempotentResult(
        GetStorageOwnerId(User),
        'delete',
        idempotencyKey,
        deleted,
      );
      await this.CloudListService.InvalidateListCache(GetStorageOwnerId(User));

      // Notify user about file deletion
      const deletedNames = files.map((f) => f.Key.split('/').pop() || f.Key);
      this.NotificationService.EmitToUser(
        User.Id,
        NotificationType.FILE_DELETED,
        'Files Deleted',
        `${deletedNames.length} file(s) deleted successfully.`,
        { Keys: files.map((f) => f.Key), Count: files.length },
      );

      return deleted;
    }
    await this.SetIdempotentResult(
      GetStorageOwnerId(User),
      'delete',
      idempotencyKey,
      true,
    );
    await this.CloudListService.InvalidateListCache(GetStorageOwnerId(User));
    return true;
  }

  //#endregion

  //#region Directory Management

  async CreateDirectory(
    { Key }: CloudKeyRequestModel,
    User: UserContext,
  ): Promise<boolean> {
    const result = await this.CloudDirectoryService.CreateDirectory(
      { Key },
      User,
    );
    await this.CloudListService.InvalidateDirectoryThumbnailCache(
      GetStorageOwnerId(User),
      Key,
    );
    await this.CloudListService.InvalidateListCache(GetStorageOwnerId(User));
    return result;
  }

  async RenameDirectory(
    { Key, Name }: CloudRenameDirectoryRequestModel,
    User: UserContext,
    options?: { allowEncryptedDirectories?: boolean },
  ): Promise<boolean> {
    const result = await this.CloudDirectoryService.RenameDirectory(
      { Key, Name },
      User,
      options,
    );
    await this.CloudListService.InvalidateDirectoryThumbnailCache(
      GetStorageOwnerId(User),
      Key,
    );
    if (Name) {
      const parent = this.GetParentDirectoryPath(Key);
      const renamedPath = parent ? `${parent}/${Name}` : Name;
      await this.CloudListService.InvalidateDirectoryThumbnailCache(
        GetStorageOwnerId(User),
        renamedPath,
      );
    }
    await this.CloudListService.InvalidateListCache(GetStorageOwnerId(User));
    return result;
  }

  async GetEncryptedFolderSet(User: UserContext): Promise<Set<string>> {
    return this.CloudDirectoryService.GetEncryptedFolderSet(User);
  }

  async ValidateDirectorySession(
    userId: string,
    folderPath: string,
    sessionToken: string,
  ): Promise<unknown | null> {
    return this.CloudDirectoryService.ValidateDirectorySession(
      userId,
      folderPath,
      sessionToken,
    );
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
    return this.CloudDirectoryService.CheckEncryptedFolderAccess(
      path,
      userId,
      sessionToken,
    );
  }

  async GetActiveSession(
    userId: string,
    folderPath: string,
  ): Promise<unknown | null> {
    return this.CloudDirectoryService.GetActiveSession(userId, folderPath);
  }

  async GetHiddenFolderSet(User: UserContext): Promise<Set<string>> {
    return this.CloudDirectoryService.GetHiddenFolderSet(User);
  }

  async ValidateHiddenSession(
    userId: string,
    folderPath: string,
    sessionToken: string,
  ): Promise<unknown | null> {
    return this.CloudDirectoryService.ValidateHiddenSession(
      userId,
      folderPath,
      sessionToken,
    );
  }

  //#endregion

  //#region Multipart Upload

  async UploadCreateMultipartUpload(
    {
      Key,
      ContentType,
      Metadata,
      TotalSize,
      ConflictStrategy,
    }: CloudCreateMultipartUploadRequestModel,
    User: UserContext,
    sessionToken?: string,
  ): Promise<CloudCreateMultipartUploadResponseModel> {
    await this.EnsureUploadAccess(Key, GetStorageOwnerId(User), sessionToken);
    return this.CloudUploadService.UploadCreateMultipartUpload(
      { Key, ContentType, Metadata, TotalSize, ConflictStrategy },
      User,
    );
  }

  //#endregion

  //#region Multipart Upload

  async UploadGetMultipartPartUrl(
    { Key, UploadId, PartNumber }: CloudGetMultipartPartUrlRequestModel,
    User: UserContext,
    sessionToken?: string,
  ): Promise<CloudGetMultipartPartUrlResponseModel> {
    await this.EnsureUploadAccess(Key, GetStorageOwnerId(User), sessionToken);
    return this.CloudUploadService.UploadGetMultipartPartUrl(
      { Key, UploadId, PartNumber },
      User,
    );
  }

  async UploadGetMultipartPartUrlsBatch(
    model: CloudGetMultipartPartUrlsBatchRequestModel,
    User: UserContext,
    sessionToken?: string,
  ): Promise<CloudGetMultipartPartUrlsBatchResponseModel> {
    await this.EnsureUploadAccess(
      model.Key,
      GetStorageOwnerId(User),
      sessionToken,
    );
    return this.CloudUploadService.UploadGetMultipartPartUrlsBatch(model, User);
  }

  //#endregion

  //#region Multipart Upload

  async UploadPart(
    { Key, UploadId, PartNumber }: CloudUploadPartRequestModel,
    file: Express.Multer.File,
    User: UserContext,
    sessionToken?: string,
    contentMd5?: string,
  ): Promise<CloudUploadPartResponseModel> {
    await this.EnsureUploadAccess(Key, GetStorageOwnerId(User), sessionToken);
    if (contentMd5) {
      const hash = createHash('md5').update(file.buffer).digest('base64');
      if (hash !== contentMd5) {
        throw new HttpException(
          'Content-MD5 mismatch.',
          HttpStatus.BAD_REQUEST,
        );
      }
    }
    return this.CloudUploadService.UploadPart(
      { Key, UploadId, PartNumber, File: file, ContentMd5: contentMd5 },
      User,
    );
  }

  //#endregion

  //#region Complete Multipart Upload

  async UploadCompleteMultipartUpload(
    { Key, UploadId, Parts }: CloudCompleteMultipartUploadRequestModel,
    User: UserContext,
    sessionToken?: string,
    idempotencyKey?: string,
  ): Promise<CloudCompleteMultipartUploadResponseModel> {
    await this.EnsureUploadAccess(Key, GetStorageOwnerId(User), sessionToken);
    const cached =
      await this.GetIdempotentResult<CloudCompleteMultipartUploadResponseModel>(
        GetStorageOwnerId(User),
        'upload-complete',
        idempotencyKey,
      );
    if (cached !== undefined) {
      return cached;
    }
    const result = await this.CloudUploadService.UploadCompleteMultipartUpload(
      { Key, UploadId, Parts },
      User,
    );
    const uploadedObject = await this.CloudObjectService.Find({ Key }, User);
    const uploadedSize = uploadedObject.Size || 0;
    await this.CloudUsageService.IncrementUsage(
      GetStorageOwnerId(User),
      uploadedSize,
    );
    await this.EnsureUploadedObjectWithinLimits(Key, User, uploadedSize);
    await this.CloudScanService.EnqueueScan(GetStorageOwnerId(User), Key);
    await this.CloudListService.InvalidateThumbnailCacheForObjectKey(
      GetStorageOwnerId(User),
      Key,
    );
    await this.SetIdempotentResult(
      GetStorageOwnerId(User),
      'upload-complete',
      idempotencyKey,
      result,
    );
    await this.CloudListService.InvalidateListCache(GetStorageOwnerId(User));

    // Enforce version limit after upload (prune old versions)
    const bucket = this.CloudS3Service.GetBuckets().Storage;
    const fullKey = KeyBuilder([GetStorageOwnerId(User), Key]);
    await this.CloudVersionService.CleanupOldVersions(bucket, fullKey).catch(
      (err) =>
        this.Logger.warn(
          `Version cleanup failed for "${Key}": ${err?.message}`,
        ),
    );

    // Notify user about upload completion
    const fileName = Key.split('/').pop() || Key;
    this.NotificationService.EmitToUser(
      User.Id,
      NotificationType.UPLOAD_COMPLETE,
      'Upload Complete',
      `"${fileName}" has been uploaded successfully.`,
      { Key, Size: uploadedSize },
    );

    return result;
  }

  //#endregion

  //#region Image Metadata Processing
  //#endregion

  // ============================================================================
  // ARCHIVE API - Multi-format archive operations
  // ============================================================================

  //#region Archive Extract

  async ArchiveExtractStart(
    model: CloudArchiveExtractStartRequestModel,
    User: UserContext,
    sessionToken?: string,
  ): Promise<CloudArchiveExtractStartResponseModel> {
    await this.EnsureUploadAccess(
      model.Key,
      GetStorageOwnerId(User),
      sessionToken,
    );
    return this.CloudArchiveService.ArchiveExtractStart(model, User);
  }

  async ArchiveExtractCancel(
    model: CloudArchiveExtractCancelRequestModel,
    User: UserContext,
  ): Promise<CloudArchiveExtractCancelResponseModel> {
    return this.CloudArchiveService.ArchiveExtractCancel(model, User);
  }

  //#endregion

  //#region Archive Preview

  async ArchivePreview(
    model: CloudArchivePreviewRequestModel,
    User: UserContext,
    sessionToken?: string,
  ): Promise<CloudArchivePreviewResponseModel> {
    await this.EnsureUploadAccess(
      model.Key,
      GetStorageOwnerId(User),
      sessionToken,
    );
    return this.CloudArchiveService.ArchivePreview(model, User);
  }

  //#endregion

  //#region Archive Create

  async ArchiveCreateStart(
    model: CloudArchiveCreateStartRequestModel,
    User: UserContext,
  ): Promise<CloudArchiveCreateStartResponseModel> {
    return this.CloudArchiveService.ArchiveCreateStart(model, User);
  }

  async ArchiveCreateCancel(
    model: CloudArchiveCreateCancelRequestModel,
    User: UserContext,
  ): Promise<CloudArchiveCreateCancelResponseModel> {
    return this.CloudArchiveService.ArchiveCreateCancel(model, User);
  }

  //#endregion

  //#region Abort Multipart Upload

  async UploadAbortMultipartUpload(
    { Key, UploadId }: CloudAbortMultipartUploadRequestModel,
    User: UserContext,
  ): Promise<void> {
    await this.CloudUploadService.UploadAbortMultipartUpload(
      { Key, UploadId },
      User,
    );
  }

  //#region Update (rename/metadata)

  async Update(
    { Key, Name, Metadata, ConflictStrategy }: CloudUpdateRequestModel,
    User: UserContext,
  ): Promise<CloudObjectModel> {
    const result = await this.CloudObjectService.Update(
      { Key, Name, Metadata, ConflictStrategy },
      User,
    );
    await this.CloudListService.InvalidateThumbnailCacheForObjectKey(
      GetStorageOwnerId(User),
      Key,
    );
    await this.CloudListService.InvalidateListCache(GetStorageOwnerId(User));
    return result;
  }

  //#endregion

  // ============================================================================
  // VERSIONING API
  // ============================================================================

  //#region Versioning

  async ListVersions(
    { Key }: CloudKeyRequestModel,
    User: UserContext,
  ): Promise<CloudVersionListResponseModel> {
    const bucket = this.CloudS3Service.GetBuckets().Storage;
    const fullKey = KeyBuilder([GetStorageOwnerId(User), Key]);
    const versions = await this.CloudVersionService.ListVersions(
      bucket,
      fullKey,
    );
    return { Versions: versions, Key };
  }

  async RestoreVersion(
    { Key, VersionId }: CloudRestoreVersionRequestModel,
    User: UserContext,
  ): Promise<void> {
    const bucket = this.CloudS3Service.GetBuckets().Storage;
    const fullKey = KeyBuilder([GetStorageOwnerId(User), Key]);
    await this.CloudVersionService.RestoreVersion(bucket, fullKey, VersionId);
    await this.CloudListService.InvalidateThumbnailCacheForObjectKey(
      GetStorageOwnerId(User),
      Key,
    );
    await this.CloudListService.InvalidateListCache(GetStorageOwnerId(User));
  }

  async DeleteVersion(
    { Key, VersionId }: CloudDeleteVersionRequestModel,
    User: UserContext,
  ): Promise<void> {
    const bucket = this.CloudS3Service.GetBuckets().Storage;
    const fullKey = KeyBuilder([GetStorageOwnerId(User), Key]);
    await this.CloudVersionService.DeleteVersion(bucket, fullKey, VersionId);
  }

  //#endregion

  // ============================================================================
  // DIRECTORIES API - Unified Directory Management
  // ============================================================================

  //#region Directories API

  /**
   * Create a directory. If IsEncrypted is true, creates an encrypted directory.
   * For encrypted directories, passphrase is required via X-Folder-Passphrase header.
   */
  async DirectoryCreate(
    { Path, IsEncrypted, ConflictStrategy }: DirectoryCreateRequestModel,
    passphrase: string | undefined,
    User: UserContext,
    sessionToken?: string,
  ): Promise<DirectoryResponseModel> {
    await this.EnsureDirectoryAccess(
      Path,
      GetStorageOwnerId(User),
      sessionToken,
    );
    const result = await this.CloudDirectoryService.DirectoryCreate(
      { Path, IsEncrypted, ConflictStrategy },
      passphrase,
      User,
    );
    await this.CloudListService.InvalidateDirectoryThumbnailCache(
      GetStorageOwnerId(User),
      Path,
    );
    await this.CloudListService.InvalidateListCache(GetStorageOwnerId(User));
    return result;
  }

  /**
   * Rename a directory. For encrypted directories, validates passphrase.
   */
  async DirectoryRename(
    { Path, Name, ConflictStrategy }: DirectoryRenameRequestModel,
    passphrase: string | undefined,
    User: UserContext,
    sessionToken?: string,
  ): Promise<DirectoryResponseModel> {
    await this.EnsureDirectoryAccess(
      Path,
      GetStorageOwnerId(User),
      sessionToken,
    );
    const result = await this.CloudDirectoryService.DirectoryRename(
      { Path, Name, ConflictStrategy },
      passphrase,
      User,
    );
    await this.CloudListService.InvalidateDirectoryThumbnailCache(
      GetStorageOwnerId(User),
      Path,
    );
    if (Name) {
      const parent = this.GetParentDirectoryPath(Path);
      const renamedPath = parent ? `${parent}/${Name}` : Name;
      await this.CloudListService.InvalidateDirectoryThumbnailCache(
        GetStorageOwnerId(User),
        renamedPath,
      );
    }
    await this.CloudListService.InvalidateListCache(GetStorageOwnerId(User));
    return result;
  }

  /**
   * Delete a directory. For encrypted directories, validates passphrase.
   */
  async DirectoryDelete(
    { Path }: DirectoryDeleteRequestModel,
    passphrase: string | undefined,
    User: UserContext,
    sessionToken?: string,
  ): Promise<boolean> {
    await this.EnsureDirectoryAccess(
      Path,
      GetStorageOwnerId(User),
      sessionToken,
    );
    const result = await this.CloudDirectoryService.DirectoryDelete(
      { Path },
      passphrase,
      User,
    );
    await this.CloudListService.InvalidateDirectoryThumbnailCache(
      GetStorageOwnerId(User),
      Path,
    );
    await this.CloudListService.InvalidateListCache(GetStorageOwnerId(User));
    return result;
  }

  /**
   * Unlock an encrypted directory and create a session token.
   * The session token allows access to folder contents without providing passphrase.
   */
  async DirectoryUnlock(
    { Path }: DirectoryUnlockRequestModel,
    passphrase: string | undefined,
    User: UserContext,
  ): Promise<DirectoryUnlockResponseModel> {
    const result = await this.CloudDirectoryService.DirectoryUnlock(
      { Path },
      passphrase,
      User,
    );
    await this.CloudListService.InvalidateDirectoryThumbnailCache(
      GetStorageOwnerId(User),
      Path,
    );
    await this.CloudListService.InvalidateListCache(GetStorageOwnerId(User));
    return result;
  }

  /**
   * Lock an encrypted directory (invalidate session).
   */
  async DirectoryLock(
    { Path }: DirectoryLockRequestModel,
    User: UserContext,
  ): Promise<boolean> {
    const result = await this.CloudDirectoryService.DirectoryLock(
      { Path },
      User,
    );
    await this.CloudListService.InvalidateDirectoryThumbnailCache(
      GetStorageOwnerId(User),
      Path,
    );
    await this.CloudListService.InvalidateListCache(GetStorageOwnerId(User));
    return result;
  }

  /**
   * Convert an existing directory to encrypted.
   */
  async DirectoryConvertToEncrypted(
    { Path }: DirectoryConvertToEncryptedRequestModel,
    passphrase: string | undefined,
    User: UserContext,
    sessionToken?: string,
  ): Promise<DirectoryResponseModel> {
    await this.EnsureDirectoryAccess(
      Path,
      GetStorageOwnerId(User),
      sessionToken,
    );
    const result = await this.CloudDirectoryService.DirectoryConvertToEncrypted(
      { Path },
      passphrase,
      User,
    );
    await this.CloudListService.InvalidateDirectoryThumbnailCache(
      GetStorageOwnerId(User),
      Path,
    );
    await this.CloudListService.InvalidateListCache(GetStorageOwnerId(User));
    return result;
  }

  /**
   * Remove encryption from a directory (decrypt).
   */
  async DirectoryDecrypt(
    { Path }: DirectoryDecryptRequestModel,
    passphrase: string | undefined,
    User: UserContext,
    sessionToken?: string,
  ): Promise<DirectoryResponseModel> {
    await this.EnsureDirectoryAccess(
      Path,
      GetStorageOwnerId(User),
      sessionToken,
    );
    const result = await this.CloudDirectoryService.DirectoryDecrypt(
      { Path },
      passphrase,
      User,
    );
    await this.CloudListService.InvalidateDirectoryThumbnailCache(
      GetStorageOwnerId(User),
      Path,
    );
    await this.CloudListService.InvalidateListCache(GetStorageOwnerId(User));
    return result;
  }

  //#endregion

  // ============================================================================
  // HIDDEN DIRECTORIES API
  // ============================================================================

  //#region Hidden Directories API

  async DirectoryHide(
    model: DirectoryHideRequestModel,
    passphrase: string | undefined,
    User: UserContext,
  ): Promise<DirectoryResponseModel> {
    const result = await this.CloudDirectoryService.DirectoryHide(
      model,
      passphrase,
      User,
    );
    await this.CloudListService.InvalidateListCache(GetStorageOwnerId(User));
    return result;
  }

  async DirectoryUnhide(
    model: DirectoryUnhideRequestModel,
    passphrase: string | undefined,
    User: UserContext,
  ): Promise<DirectoryResponseModel> {
    const result = await this.CloudDirectoryService.DirectoryUnhide(
      model,
      passphrase,
      User,
    );
    await this.CloudListService.InvalidateListCache(GetStorageOwnerId(User));
    return result;
  }

  async DirectoryReveal(
    model: DirectoryRevealRequestModel,
    passphrase: string | undefined,
    User: UserContext,
  ): Promise<DirectoryRevealResponseModel> {
    const result = await this.CloudDirectoryService.DirectoryReveal(
      model,
      passphrase,
      User,
    );
    await this.CloudListService.InvalidateListCache(GetStorageOwnerId(User));
    return result;
  }

  async DirectoryConceal(
    model: DirectoryConcealRequestModel,
    User: UserContext,
  ): Promise<boolean> {
    const result = await this.CloudDirectoryService.DirectoryConceal(
      model,
      User,
    );
    await this.CloudListService.InvalidateListCache(GetStorageOwnerId(User));
    return result;
  }

  //#endregion

  //#region Duplicate Scan

  async DuplicateScanStart(
    model: CloudDuplicateScanStartRequestModel,
    User: UserContext,
  ): Promise<CloudDuplicateScanStartResponseModel> {
    return this.CloudDuplicateService.EnqueueDuplicateScan(model, User);
  }

  async DuplicateScanStatus(
    { ScanId }: CloudDuplicateScanIdRequestModel,
  ): Promise<CloudDuplicateScanStatusResponseModel | null> {
    return this.CloudDuplicateService.GetDuplicateScanStatus(ScanId);
  }

  async DuplicateScanResult(
    { ScanId }: CloudDuplicateScanIdRequestModel,
  ): Promise<CloudDuplicateScanResultResponseModel | null> {
    return this.CloudDuplicateService.GetDuplicateScanResult(ScanId);
  }

  async DuplicateScanCancel(
    { ScanId }: CloudDuplicateScanIdRequestModel,
  ): Promise<CloudDuplicateScanCancelResponseModel> {
    return this.CloudDuplicateService.CancelDuplicateScan(ScanId);
  }

  //#endregion

  private GetParentDirectoryPath(key: string): string {
    const normalized = NormalizeDirectoryPath(key);
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

  private async EnsureUploadAccess(
    key: string,
    userId: string,
    sessionToken?: string,
  ): Promise<void> {
    const folderPath = this.GetParentDirectoryPath(key);
    const accessCheck = await this.CheckEncryptedFolderAccess(
      folderPath,
      userId,
      sessionToken,
    );

    if (accessCheck.isEncrypted && !accessCheck.hasAccess) {
      throw new HttpException(
        `Access denied. Folder "${accessCheck.encryptingFolder}" is encrypted. Unlock it first via POST /Cloud/Directories/Unlock`,
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async EnsureDirectoryAccess(
    path: string,
    userId: string,
    sessionToken?: string,
  ): Promise<void> {
    const normalizedPath = NormalizeDirectoryPath(path);
    const accessCheck = await this.CheckEncryptedFolderAccess(
      normalizedPath,
      userId,
      sessionToken,
    );

    if (accessCheck.isEncrypted && !accessCheck.hasAccess) {
      throw new HttpException(
        `Access denied. Folder "${accessCheck.encryptingFolder}" is encrypted. Unlock it first via POST /Cloud/Directories/Unlock`,
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private async EnsureUploadedObjectWithinLimits(
    key: string,
    user: UserContext,
    objectSize?: number,
  ): Promise<void> {
    const usage = await this.CloudUsageService.UserStorageUsage(user);
    let resolvedSize = typeof objectSize === 'number' ? objectSize : 0;
    if (!resolvedSize) {
      const object = await this.CloudObjectService.Find({ Key: key }, user);
      resolvedSize = object.Size || 0;
    }

    if (usage.MaxUploadSizeBytes && resolvedSize > usage.MaxUploadSizeBytes) {
      await this.CloudObjectService.Delete(
        { Items: [{ Key: key, IsDirectory: false }] },
        user,
      );
      await this.CloudUsageService.DecrementUsage(
        GetStorageOwnerId(user),
        resolvedSize,
      );
      throw new HttpException(
        `File size exceeds the maximum upload size of ${SizeFormatter({ From: usage.MaxUploadSizeBytes, FromUnit: 'B', ToUnit: 'MB' })} MB.`,
        HttpStatus.BAD_REQUEST,
      );
    }

    if (
      usage.MaxStorageInBytes &&
      usage.UsedStorageInBytes > usage.MaxStorageInBytes
    ) {
      await this.CloudObjectService.Delete(
        { Items: [{ Key: key, IsDirectory: false }] },
        user,
      );
      await this.CloudUsageService.DecrementUsage(
        GetStorageOwnerId(user),
        resolvedSize,
      );
      throw new HttpException(
        'Storage limit exceeded. Please upgrade your subscription.',
        HttpStatus.BAD_REQUEST,
      );
    }
  }

  private BuildIdempotencyKey(
    userId: string,
    action: string,
    idempotencyKey?: string,
  ): string | null {
    if (!idempotencyKey) {
      return null;
    }
    return CloudKeys.Idempotency(userId, action, idempotencyKey);
  }

  private async GetIdempotentResult<T>(
    userId: string,
    action: string,
    idempotencyKey?: string,
  ): Promise<T | undefined> {
    const key = this.BuildIdempotencyKey(userId, action, idempotencyKey);
    if (!key) {
      return undefined;
    }
    return this.RedisService.Get<T>(key);
  }

  private async SetIdempotentResult<T>(
    userId: string,
    action: string,
    idempotencyKey: string | undefined,
    value: T,
  ): Promise<void> {
    const key = this.BuildIdempotencyKey(userId, action, idempotencyKey);
    if (!key) {
      return;
    }
    await this.RedisService.Set(key, value, CLOUD_IDEMPOTENCY_TTL);
  }
}
