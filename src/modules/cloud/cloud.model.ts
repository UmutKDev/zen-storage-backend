import {
  ArchiveEntryType,
  ArchiveFormat,
  ArchiveJobState,
  ArchivePhase,
  CloudBreadcrumbLevelType,
  ConflictResolutionStrategy,
  DuplicateScanPhase,
  DuplicateScanStatus,
  ScanStatus,
} from '@common/enums';
import { CDNPathResolver, S3KeyConverter } from '@common/helpers/cast.helper';
import { PaginationRequestModel } from '@common/models/pagination.model';
import { ApiProperty, OmitType } from '@nestjs/swagger';
import { Expose, Transform, Type } from 'class-transformer';
import {
  IsString,
  IsNotEmpty,
  IsBoolean,
  IsOptional,
  IsArray,
  IsNumber,
  IsEnum,
  ValidateNested,
  MinLength,
  ValidateIf,
  Matches,
  Min,
  Max,
  ArrayMinSize,
  ArrayMaxSize,
} from 'class-validator';

export class CloudBreadCrumbModel {
  @Expose()
  @ApiProperty()
  Name: string;

  @Expose()
  @ApiProperty()
  Path: string;

  @Expose()
  @ApiProperty({ enum: CloudBreadcrumbLevelType })
  Type: string;
}

export class CloudPathModel {
  @Expose()
  @ApiProperty()
  Host: string;

  @Expose()
  @ApiProperty()
  Key: string;

  @Expose()
  @ApiProperty()
  @Transform(({ value }) => CDNPathResolver(value), {
    toClassOnly: true,
  })
  Url: string;
}

export class CloudMetadataDefaultModel {
  @Expose()
  @ApiProperty()
  Originalfilename?: string;

  @Expose()
  @ApiProperty()
  Width?: string;

  @Expose()
  @ApiProperty()
  Height?: string;
}

export class CloudObjectModel {
  @Expose()
  @ApiProperty()
  Name: string;

  @Expose()
  @ApiProperty()
  Extension: string;

  @Expose()
  @ApiProperty()
  MimeType: string = 'application/octet-stream';

  @Expose()
  @ApiProperty({ type: CloudPathModel })
  @Type(() => CloudPathModel)
  Path: CloudPathModel;

  @Expose()
  @ApiProperty({ required: false, type: CloudMetadataDefaultModel })
  @Type(() => CloudMetadataDefaultModel)
  Metadata: Record<string, unknown>;

  @Expose()
  @ApiProperty()
  LastModified: string;

  @Expose()
  @ApiProperty()
  ETag: string;

  @Expose()
  @ApiProperty()
  Size: number;
}

export class CloudDirectoryModel {
  @Expose()
  @ApiProperty()
  Name: string;

  @Expose()
  @ApiProperty()
  Prefix: string;

  @Expose()
  @ApiProperty({ default: false })
  IsEncrypted?: boolean = false;

  @Expose()
  @ApiProperty({
    default: true,
    description: 'True if encrypted folder is locked (no valid session)',
  })
  IsLocked?: boolean = true;

  @Expose()
  @ApiProperty({ default: false, description: 'Whether directory is hidden' })
  IsHidden?: boolean = false;

  @Expose()
  @ApiProperty({
    default: true,
    description: 'True if hidden folder is concealed (no valid hidden session)',
  })
  IsConcealed?: boolean = true;

  @Expose()
  @ApiProperty({ required: false, type: CloudObjectModel, isArray: true })
  @Type(() => CloudObjectModel)
  Thumbnails?: Array<CloudObjectModel> = [];
}

export class CloudViewModel {
  @Expose()
  @ApiProperty({ type: CloudBreadCrumbModel, isArray: true })
  @Type(() => CloudBreadCrumbModel)
  Breadcrumb: Array<CloudBreadCrumbModel>;

  @Expose()
  @ApiProperty({ type: CloudDirectoryModel, isArray: true })
  @Type(() => CloudDirectoryModel)
  Directories: Array<CloudDirectoryModel>;

  @Expose()
  @ApiProperty({ type: CloudObjectModel, isArray: true })
  @Type(() => CloudObjectModel)
  Contents: Array<CloudObjectModel>;
}

export class CloudListResponseModel extends CloudViewModel {}

export class CloudListRequestModel extends PaginationRequestModel {
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  Path: string;

  @ApiProperty({ required: false })
  @IsBoolean()
  @Transform(({ obj }) => {
    return obj.Delimiter === 'true' ? true : false;
  })
  @IsOptional()
  Delimiter: boolean;

  @ApiProperty({ required: false, default: true })
  @IsBoolean()
  @Transform(({ obj }) => {
    return obj.IsMetadataProcessing === 'true' ? true : false;
  })
  @IsOptional()
  IsMetadataProcessing: boolean = true;
}

export class CloudListBreadcrumbRequestModel extends OmitType(
  CloudListRequestModel,
  ['IsMetadataProcessing'] as const,
) {}

export class CloudListDirectoriesRequestModel extends OmitType(
  CloudListRequestModel,
  ['IsMetadataProcessing'] as const,
) {}

export class CloudListObjectsRequestModel extends CloudListRequestModel {}

export class CloudKeyRequestModel {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Key: string;
}

export class CloudRenameDirectoryRequestModel extends CloudKeyRequestModel {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Matches(/^[^/]+$/, {
    message: 'Directory name cannot contain slashes',
  })
  @Transform(({ value }) => S3KeyConverter(value))
  Name: string;
}

export class CloudEncryptedFolderRenameRequestModel {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Path: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Matches(/^[^/]+$/, {
    message: 'Directory name cannot contain slashes',
  })
  @Transform(({ value }) => S3KeyConverter(value))
  Name: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  Passphrase: string;
}

export class CloudPreSignedUrlRequestModel {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Key: string;

  @ApiProperty({ required: false })
  @IsNumber()
  @IsOptional()
  ExpiresInSeconds?: number;
}

export class CloudDeleteModel {
  @ApiProperty()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Key: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  IsDirectory?: boolean;
}
export class CloudDeleteRequestModel {
  @ApiProperty({ type: CloudDeleteModel, isArray: true })
  @IsNotEmpty()
  @IsArray()
  @Type(() => CloudDeleteModel)
  @ValidateNested({ each: true })
  Items: Array<CloudDeleteModel>;
}

export class CloudCreateMultipartUploadRequestModel {
  @Expose()
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Key: string;

  @Expose()
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  ContentType?: string;

  @Expose()
  @ApiProperty({ required: false })
  @IsOptional()
  Metadata?: Record<string, string>;

  @Expose()
  @ApiProperty()
  @IsNotEmpty()
  @IsNumber()
  TotalSize: number;

  @ApiProperty({ required: false, enum: ConflictResolutionStrategy })
  @IsOptional()
  @IsEnum(ConflictResolutionStrategy)
  ConflictStrategy?: ConflictResolutionStrategy;
}

export class CloudCreateMultipartUploadResponseModel {
  @Expose()
  @ApiProperty()
  UploadId: string;

  @Expose()
  @ApiProperty()
  Key: string;
}

export class CloudGetMultipartPartUrlRequestModel {
  @Expose()
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Key: string;

  @Expose()
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  UploadId: string;

  @Expose()
  @ApiProperty()
  @IsNotEmpty()
  PartNumber: number;
}

export class CloudGetMultipartPartUrlResponseModel {
  @Expose()
  @ApiProperty()
  Url: string;

  @Expose()
  @ApiProperty()
  Expires: number;
}

export class CloudGetMultipartPartUrlsBatchRequestModel {
  @Expose()
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Key: string;

  @Expose()
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  UploadId: string;

  @Expose()
  @ApiProperty({ required: false })
  @IsOptional()
  @IsNumber()
  @Min(1)
  @Max(10000)
  TotalParts?: number;

  @Expose()
  @ApiProperty({ required: false, type: [Number] })
  @IsOptional()
  @IsArray()
  @IsNumber({}, { each: true })
  @ArrayMinSize(1)
  @ArrayMaxSize(10000)
  PartNumbers?: number[];
}

export class CloudMultipartPartUrlModel {
  @Expose()
  @ApiProperty()
  PartNumber: number;

  @Expose()
  @ApiProperty()
  Url: string;

  @Expose()
  @ApiProperty()
  Expires: number;
}

export class CloudGetMultipartPartUrlsBatchResponseModel {
  @Expose()
  @ApiProperty({ type: CloudMultipartPartUrlModel, isArray: true })
  @Type(() => CloudMultipartPartUrlModel)
  Parts: CloudMultipartPartUrlModel[];
}

export class CloudUploadPartRequestModel {
  @Expose()
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Key: string;

  @Expose()
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  UploadId: string;

  @Expose()
  @ApiProperty()
  @IsNotEmpty()
  PartNumber: number;

  @Expose()
  @ApiProperty({
    type: 'string',
    format: 'binary',
  })
  @IsOptional()
  File: Express.Multer.File;

  @Expose()
  @IsOptional()
  ContentMd5?: string;
}

export class CloudUploadPartResponseModel {
  @Expose()
  @ApiProperty()
  ETag: string;
}

export class CloudMultipartPartModel {
  @Expose()
  @ApiProperty()
  @IsNotEmpty()
  PartNumber: number;

  @Expose()
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  ETag: string;
}

export class CloudCompleteMultipartUploadRequestModel {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Key: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  UploadId: string;

  @ApiProperty({ type: CloudMultipartPartModel, isArray: true })
  @IsNotEmpty()
  @IsArray()
  @Type(() => CloudMultipartPartModel)
  @ValidateNested({ each: true })
  Parts: Array<CloudMultipartPartModel>;
}

// ============================================================================
// ARCHIVE API - Multi-format archive operations
// ============================================================================

export class CloudArchiveExtractStartRequestModel {
  @ApiProperty({ description: 'Key of the archive file to extract' })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Key: string;

  @ApiProperty({
    required: false,
    type: [String],
    description:
      'Specific entry paths to extract (selective extraction). Omit for full extraction.',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  SelectedEntries?: string[];

  @ApiProperty({
    required: false,
    enum: ConflictResolutionStrategy,
    description:
      'How to handle an existing extract-output folder. Defaults to REPLACE.',
  })
  @IsEnum(ConflictResolutionStrategy)
  @IsOptional()
  Strategy?: ConflictResolutionStrategy;

  @ApiProperty({
    required: false,
    description:
      'When true (default), extract into a new subfolder named after the ' +
      'archive; when false, extract straight into the archive’s folder.',
  })
  @IsBoolean()
  @IsOptional()
  CreateFolder?: boolean;
}

export class CloudArchiveExtractStartResponseModel {
  @Expose()
  @ApiProperty()
  JobId: string;

  @Expose()
  @ApiProperty({ description: 'Detected archive format', enum: ArchiveFormat })
  Format: string;
}

export class CloudArchiveExtractCancelRequestModel {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  JobId: string;
}

export class CloudArchiveExtractCancelResponseModel {
  @Expose()
  @ApiProperty()
  Cancelled: boolean;
}

export class CloudArchivePreviewRequestModel {
  @ApiProperty({ description: 'Key of the archive file to preview' })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Key: string;
}

export class CloudArchivePreviewEntryModel {
  @Expose()
  @ApiProperty()
  Path: string;

  @Expose()
  @ApiProperty({ enum: ArchiveEntryType })
  Type: string;

  @Expose()
  @ApiProperty()
  Size: number;

  @Expose()
  @ApiProperty({ required: false })
  CompressedSize?: number;

  @Expose()
  @ApiProperty({ required: false })
  LastModified?: string;
}

export class CloudArchivePreviewResponseModel {
  @Expose()
  @ApiProperty()
  Key: string;

  @Expose()
  @ApiProperty({ enum: ArchiveFormat })
  Format: string;

  @Expose()
  @ApiProperty()
  TotalEntries: number;

  @Expose()
  @ApiProperty({ type: CloudArchivePreviewEntryModel, isArray: true })
  @Type(() => CloudArchivePreviewEntryModel)
  Entries: CloudArchivePreviewEntryModel[];
}

export class CloudArchiveCreateStartRequestModel {
  @ApiProperty({
    type: [String],
    description: 'S3 keys to include in the archive (files and/or directories)',
  })
  @IsArray()
  @IsString({ each: true })
  @IsNotEmpty()
  @Transform(({ value }) => value.map((v: string) => S3KeyConverter(v)))
  Keys: string[];

  @ApiProperty({
    required: false,
    description: 'Output format',
    enum: ArchiveFormat,
    default: ArchiveFormat.ZIP,
  })
  @IsString()
  @IsOptional()
  Format?: string = ArchiveFormat.ZIP;

  @ApiProperty({
    required: false,
    description: 'Custom output filename (without extension)',
  })
  @IsString()
  @IsOptional()
  OutputName?: string;
}

export class CloudArchiveCreateStartResponseModel {
  @Expose()
  @ApiProperty()
  JobId: string;

  @Expose()
  @ApiProperty({ enum: ArchiveFormat })
  Format: string;

  @Expose()
  @ApiProperty({ description: 'S3 key where the archive will be created' })
  OutputKey: string;
}

export class CloudArchiveCreateCancelRequestModel {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  JobId: string;
}

export class CloudArchiveCreateCancelResponseModel {
  @Expose()
  @ApiProperty()
  Cancelled: boolean;
}

export class CloudArchiveStatusRequestModel {
  @ApiProperty({ description: 'Job ID returned by archive create/extract start' })
  @IsString()
  @IsNotEmpty()
  JobId: string;

  @ApiProperty({
    description: 'Which archive job the JobId belongs to (create or extract)',
    enum: ArchivePhase,
  })
  @IsEnum(ArchivePhase)
  @IsNotEmpty()
  Kind: string;
}

export class CloudArchiveStatusResponseModel {
  @Expose()
  @ApiProperty()
  JobId: string;

  @Expose()
  @ApiProperty({ enum: ArchivePhase })
  Kind: string;

  @Expose()
  @ApiProperty({
    enum: ArchiveJobState,
    description: 'Current BullMQ job state',
  })
  Status: string;

  @Expose()
  @ApiProperty({ required: false })
  EntriesProcessed?: number;

  @Expose()
  @ApiProperty({ required: false })
  TotalEntries?: number;

  @Expose()
  @ApiProperty({
    required: false,
    description: 'Computed completion percentage (0-100)',
  })
  Percentage?: number;

  @Expose()
  @ApiProperty({
    required: false,
    description: 'Output archive key (create jobs only)',
  })
  OutputKey?: string;

  @Expose()
  @ApiProperty({ required: false })
  Error?: string;
}

export class CloudCompleteMultipartUploadResponseModel {
  @Expose()
  @ApiProperty()
  Location: string;

  @Expose()
  @ApiProperty()
  Key: string;

  @Expose()
  @ApiProperty()
  Bucket: string;

  @Expose()
  @ApiProperty()
  ETag: string;

  @Expose()
  @ApiProperty({ required: false, type: CloudMetadataDefaultModel })
  @IsOptional()
  @Type(() => CloudMetadataDefaultModel)
  Metadata?: Record<string, string>;
}

export class CloudUserStorageUsageResponseModel {
  @Expose()
  @ApiProperty()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  UsedStorageInBytes: number = 0;

  @Expose()
  @ApiProperty()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  MaxStorageInBytes: number = 0;

  @Expose()
  @ApiProperty()
  IsLimitExceeded: boolean = false;

  @Expose()
  @ApiProperty()
  UsagePercentage: number = 0;

  @Expose()
  @ApiProperty()
  @IsNumber()
  @Transform(({ value }) => Number(value))
  MaxUploadSizeBytes: number = 0;
}

export class CloudScanStatusResponseModel {
  @Expose()
  @ApiProperty({ enum: ScanStatus })
  Status: string;

  @Expose()
  @ApiProperty({ required: false })
  Reason?: string;

  @Expose()
  @ApiProperty({ required: false })
  Signature?: string;

  @Expose()
  @ApiProperty({ required: false })
  ScannedAt?: string;
}

export class CloudAbortMultipartUploadRequestModel {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Key: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  UploadId: string;
}

// ============================================================================
// CONFLICT RESOLUTION API
// ============================================================================

export class ConflictItemInfoModel {
  @Expose()
  @ApiProperty()
  Name: string;

  @Expose()
  @ApiProperty()
  Key: string;

  @Expose()
  @ApiProperty({ required: false })
  Size?: number;

  @Expose()
  @ApiProperty({ required: false })
  LastModified?: string;

  @Expose()
  @ApiProperty()
  IsDirectory: boolean;
}

export class ConflictDetailModel {
  @Expose()
  @ApiProperty({ type: ConflictItemInfoModel })
  @Type(() => ConflictItemInfoModel)
  Source: ConflictItemInfoModel;

  @Expose()
  @ApiProperty({ type: ConflictItemInfoModel })
  @Type(() => ConflictItemInfoModel)
  Target: ConflictItemInfoModel;
}

export class ConflictResolutionItemModel {
  @ApiProperty({ description: 'Source key this resolution applies to' })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Key: string;

  @ApiProperty({ enum: ConflictResolutionStrategy })
  @IsEnum(ConflictResolutionStrategy)
  Strategy: ConflictResolutionStrategy;
}

export class ConflictResolutionModel {
  @ApiProperty({
    required: false,
    enum: ConflictResolutionStrategy,
    description:
      'Global strategy applied to all conflicts. Default: FAIL (return 409)',
  })
  @IsOptional()
  @IsEnum(ConflictResolutionStrategy)
  Strategy?: ConflictResolutionStrategy;

  @ApiProperty({
    required: false,
    type: ConflictResolutionItemModel,
    isArray: true,
    description:
      'Per-item strategy overrides. Key matches the source item key.',
  })
  @IsOptional()
  @IsArray()
  @Type(() => ConflictResolutionItemModel)
  @ValidateNested({ each: true })
  Items?: ConflictResolutionItemModel[];
}

export class ConflictDetailsResponseModel {
  @Expose()
  @ApiProperty({ type: ConflictDetailModel, isArray: true })
  @Type(() => ConflictDetailModel)
  Conflicts: ConflictDetailModel[];

  @Expose()
  @ApiProperty({ description: 'Total number of items in the original request' })
  TotalItems: number;

  @Expose()
  @ApiProperty({ description: 'Number of items that have conflicts' })
  ConflictCount: number;
}

// ============================================================================
// MOVE / UPDATE API
// ============================================================================

export class CloudMoveItemModel {
  @ApiProperty()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Key: string;

  @ApiProperty({ required: false })
  @IsOptional()
  @IsBoolean()
  IsDirectory?: boolean;
}

export class CloudMoveRequestModel {
  @ApiProperty({ type: CloudMoveItemModel, isArray: true })
  @IsNotEmpty()
  @IsArray()
  @Type(() => CloudMoveItemModel)
  @ValidateNested({ each: true })
  Items: Array<CloudMoveItemModel>;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  DestinationKey: string;

  @ApiProperty({ required: false, type: () => ConflictResolutionModel })
  @IsOptional()
  @Type(() => ConflictResolutionModel)
  @ValidateNested()
  ConflictResolution?: ConflictResolutionModel;
}

export class CloudUpdateRequestModel {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Key: string;

  // Only a filename (no slashes) is expected for Name. If provided, the object
  // will be renamed (within the same directory) to this name.
  @ApiProperty({ required: false })
  @IsOptional()
  @IsString()
  @Transform(({ value }) => S3KeyConverter(value))
  Name?: string;

  // Arbitrary metadata key/value pairs to replace for the object (optional)
  @ApiProperty({ required: false })
  @IsOptional()
  Metadata?: Record<string, string>;

  @ApiProperty({ required: false, enum: ConflictResolutionStrategy })
  @IsOptional()
  @IsEnum(ConflictResolutionStrategy)
  ConflictStrategy?: ConflictResolutionStrategy;
}

export class CloudEncryptedFolderSummaryModel {
  @Expose()
  @ApiProperty()
  Path: string;

  @Expose()
  @ApiProperty()
  CreatedAt: string;

  @Expose()
  @ApiProperty()
  UpdatedAt: string;
}

export class CloudEncryptedFolderListResponseModel {
  @Expose()
  @ApiProperty({ type: CloudEncryptedFolderSummaryModel, isArray: true })
  @Type(() => CloudEncryptedFolderSummaryModel)
  Folders: CloudEncryptedFolderSummaryModel[];
}

export class CloudEncryptedFolderCreateRequestModel {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  Path: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  Passphrase: string;
}

export class CloudEncryptedFolderConvertRequestModel extends CloudEncryptedFolderCreateRequestModel {}

export class CloudEncryptedFolderUnlockRequestModel {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  Path: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @IsNotEmpty()
  @MinLength(8)
  Passphrase: string;
}

export class CloudEncryptedFolderUnlockResponseModel {
  @Expose()
  @ApiProperty()
  Path: string;

  @Expose()
  @ApiProperty({
    description: 'Base64 encoded symmetric key for the folder',
  })
  FolderKey: string;
}

export class CloudEncryptedFolderDeleteRequestModel {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  Path: string;

  @ApiProperty({ required: false, default: false })
  @IsBoolean()
  @IsOptional()
  ShouldDeleteContents?: boolean = false;

  @ApiProperty({
    required: false,
    description: 'Required when ShouldDeleteContents is true',
    minLength: 8,
  })
  @ValidateIf((o) => o.ShouldDeleteContents === true)
  @IsString()
  @MinLength(8)
  Passphrase?: string;
}

// ============================================================================
// DIRECTORIES API - Unified Directory Management
// ============================================================================

/**
 * Request model for creating a directory.
 * If IsEncrypted is true, passphrase must be provided via X-Folder-Passphrase header.
 */
export class DirectoryCreateRequestModel {
  @ApiProperty({ description: 'Directory path to create' })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Path: string;

  @ApiProperty({
    required: false,
    default: false,
    description: 'Create as encrypted directory',
  })
  @IsBoolean()
  @IsOptional()
  IsEncrypted?: boolean = false;

  @ApiProperty({ required: false, enum: ConflictResolutionStrategy })
  @IsOptional()
  @IsEnum(ConflictResolutionStrategy)
  ConflictStrategy?: ConflictResolutionStrategy;
}

/**
 * Request model for renaming a directory.
 * For encrypted directories, passphrase must be provided via X-Folder-Passphrase header.
 */
export class DirectoryRenameRequestModel {
  @ApiProperty({ description: 'Current directory path' })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Path: string;

  @ApiProperty({ description: 'New directory name (not full path)' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^[^/]+$/, {
    message: 'Directory name cannot contain slashes',
  })
  Name: string;

  @ApiProperty({ required: false, enum: ConflictResolutionStrategy })
  @IsOptional()
  @IsEnum(ConflictResolutionStrategy)
  ConflictStrategy?: ConflictResolutionStrategy;
}

/**
 * Request model for deleting a directory.
 * For encrypted directories, passphrase must be provided via X-Folder-Passphrase header.
 */
export class DirectoryDeleteRequestModel {
  @ApiProperty({ description: 'Directory path to delete' })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Path: string;
}

/**
 * Request model for unlocking an encrypted directory.
 * Creates a session token for subsequent requests.
 */
export class DirectoryUnlockRequestModel {
  @ApiProperty({ description: 'Encrypted directory path' })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Path: string;
}

/**
 * Response model for directory unlock operation.
 */
export class DirectoryUnlockResponseModel {
  @Expose()
  @ApiProperty({ description: 'Directory path that was requested for unlock' })
  Path: string;

  @Expose()
  @ApiProperty({
    description:
      'The root encrypted folder path (parent folder that is actually encrypted)',
  })
  EncryptedFolderPath: string;

  @Expose()
  @ApiProperty({
    description:
      'Session token for subsequent requests. Pass via X-Folder-Session header.',
  })
  SessionToken: string;

  @Expose()
  @ApiProperty({
    description: 'Session expiration timestamp (Unix epoch in seconds)',
  })
  ExpiresAt: number;

  @Expose()
  @ApiProperty({ description: 'Session TTL in seconds' })
  TTL: number;
}

/**
 * Request model for locking an encrypted directory (invalidate session).
 */
export class DirectoryLockRequestModel {
  @ApiProperty({ description: 'Encrypted directory path to lock' })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Path: string;
}

/**
 * Request model for converting an existing directory to encrypted.
 * Passphrase must be provided via X-Folder-Passphrase header.
 */
export class DirectoryConvertToEncryptedRequestModel {
  @ApiProperty({ description: 'Directory path to convert' })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Path: string;
}

/**
 * Request model for decrypting an encrypted directory (remove encryption).
 * Passphrase must be provided via X-Folder-Passphrase header.
 */
export class DirectoryDecryptRequestModel {
  @ApiProperty({ description: 'Encrypted directory path to decrypt' })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Path: string;
}

/**
 * Response model for directory operations.
 */
export class DirectoryResponseModel {
  @Expose()
  @ApiProperty()
  Path: string;

  @Expose()
  @ApiProperty()
  IsEncrypted: boolean;

  @Expose()
  @ApiProperty({ required: false })
  CreatedAt?: string;

  @Expose()
  @ApiProperty({ required: false })
  UpdatedAt?: string;
}

// ============================================================================
// HIDDEN DIRECTORIES API
// ============================================================================

/**
 * Request model for hiding a directory.
 * Passphrase must be provided via X-Folder-Passphrase header.
 */
export class DirectoryHideRequestModel {
  @ApiProperty({ description: 'Directory path to hide' })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Path: string;
}

/**
 * Request model for unhiding a directory.
 * Passphrase must be provided via X-Folder-Passphrase header.
 */
export class DirectoryUnhideRequestModel {
  @ApiProperty({ description: 'Hidden directory path to unhide' })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Path: string;
}

/**
 * Request model for revealing hidden directories (create session).
 * Passphrase must be provided via X-Folder-Passphrase header.
 */
export class DirectoryRevealRequestModel {
  @ApiProperty({ description: 'Path containing hidden directories to reveal' })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Path: string;
}

/**
 * Response model for directory reveal operation.
 */
export class DirectoryRevealResponseModel {
  @Expose()
  @ApiProperty({ description: 'Directory path that was requested for reveal' })
  Path: string;

  @Expose()
  @ApiProperty({
    description: 'The hidden folder path that was revealed',
  })
  HiddenFolderPath: string;

  @Expose()
  @ApiProperty({
    description:
      'Session token for subsequent requests. Pass via X-Hidden-Session header.',
  })
  SessionToken: string;

  @Expose()
  @ApiProperty({
    description: 'Session expiration timestamp (Unix epoch in seconds)',
  })
  ExpiresAt: number;

  @Expose()
  @ApiProperty({ description: 'Session TTL in seconds' })
  TTL: number;
}

/**
 * Request model for concealing hidden directories (invalidate session).
 */
export class DirectoryConcealRequestModel {
  @ApiProperty({ description: 'Hidden directory path to conceal' })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Path: string;
}

// ============================================================================
// VERSIONING API
// ============================================================================

export class CloudVersionModel {
  @Expose()
  @ApiProperty()
  VersionId: string;

  @Expose()
  @ApiProperty()
  Key: string;

  @Expose()
  @ApiProperty()
  Size: number;

  @Expose()
  @ApiProperty()
  LastModified: string;

  @Expose()
  @ApiProperty()
  IsLatest: boolean;

  @Expose()
  @ApiProperty()
  ETag: string;
}

export class CloudVersionListResponseModel {
  @Expose()
  @ApiProperty({ type: CloudVersionModel, isArray: true })
  @Type(() => CloudVersionModel)
  Versions: CloudVersionModel[];

  @Expose()
  @ApiProperty()
  Key: string;
}

export class CloudRestoreVersionRequestModel {
  @ApiProperty({ description: 'File key (relative, without owner prefix)' })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Key: string;

  @ApiProperty({ description: 'Version ID to restore' })
  @IsString()
  @IsNotEmpty()
  VersionId: string;
}

export class CloudDeleteVersionRequestModel {
  @ApiProperty({ description: 'File key (relative, without owner prefix)' })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Key: string;

  @ApiProperty({ description: 'Version ID to delete' })
  @IsString()
  @IsNotEmpty()
  VersionId: string;
}

// ============================================================================
// SEARCH API
// ============================================================================

export class CloudSearchRequestModel extends PaginationRequestModel {
  @ApiProperty({
    description:
      'Search query - partial filename match (case-insensitive, min 2 chars)',
  })
  @IsString()
  @IsNotEmpty()
  @MinLength(2)
  Query: string;

  @ApiProperty({
    required: false,
    description: 'Restrict search to a specific directory path',
  })
  @IsString()
  @IsOptional()
  Path?: string;

  @ApiProperty({
    required: false,
    description:
      'Filter by file extension (e.g. "pdf", "jpg"). Without leading dot.',
  })
  @IsString()
  @IsOptional()
  @Transform(({ value }) => value?.replace(/^\./, ''))
  Extension?: string;

  @ApiProperty({ required: false, default: false })
  @IsBoolean()
  @Transform(({ obj }) => {
    return obj.IsMetadataProcessing === 'true' ? true : false;
  })
  @IsOptional()
  IsMetadataProcessing: boolean = false;
}

export class CloudSearchResponseModel {
  @Expose()
  @ApiProperty({ type: CloudDirectoryModel, isArray: true })
  @Type(() => CloudDirectoryModel)
  Directories: CloudDirectoryModel[];

  @Expose()
  @ApiProperty({ type: CloudObjectModel, isArray: true })
  @Type(() => CloudObjectModel)
  Objects: CloudObjectModel[];

  @Expose()
  @ApiProperty()
  TotalObjectCount: number;

  @Expose()
  @ApiProperty()
  TotalDirectoryCount: number;
}

// ============================================================================
// DUPLICATE SCAN API
// ============================================================================

export class CloudDuplicateScanStartRequestModel {
  @ApiProperty({ description: 'Folder path to scan for duplicates' })
  @IsString()
  @IsNotEmpty()
  @Transform(({ value }) => S3KeyConverter(value))
  Path: string;

  @ApiProperty({
    required: false,
    default: true,
    description: 'Whether to scan subdirectories recursively',
  })
  @IsBoolean()
  @IsOptional()
  Recursive?: boolean = true;

  @ApiProperty({
    required: false,
    default: 95,
    description:
      'Similarity threshold percentage for image perceptual hashing (1-100)',
  })
  @IsNumber()
  @IsOptional()
  @Min(1)
  @Max(100)
  SimilarityThreshold?: number = 95;
}

export class CloudDuplicateScanStartResponseModel {
  @Expose()
  @ApiProperty()
  ScanId: string;

  @Expose()
  @ApiProperty({ enum: DuplicateScanStatus })
  Status: string;
}

export class CloudDuplicateScanIdRequestModel {
  @ApiProperty({ description: 'ID of the duplicate scan job' })
  @IsString()
  @IsNotEmpty()
  ScanId: string;
}

export class CloudDuplicateScanProgressModel {
  @Expose()
  @ApiProperty()
  TotalFiles: number;

  @Expose()
  @ApiProperty()
  ProcessedFiles: number;

  @Expose()
  @ApiProperty({ enum: DuplicateScanPhase })
  Phase: string;

  @Expose()
  @ApiProperty({ required: false })
  Percentage?: number;
}

export class CloudDuplicateScanStatusResponseModel {
  @Expose()
  @ApiProperty()
  ScanId: string;

  @Expose()
  @ApiProperty({ enum: DuplicateScanStatus })
  Status: string;

  @Expose()
  @ApiProperty({ required: false, type: CloudDuplicateScanProgressModel })
  @Type(() => CloudDuplicateScanProgressModel)
  Progress?: CloudDuplicateScanProgressModel;

  @Expose()
  @ApiProperty({ required: false })
  StartedAt?: string;

  @Expose()
  @ApiProperty({ required: false })
  CompletedAt?: string;

  @Expose()
  @ApiProperty({ required: false })
  Error?: string;
}

export class CloudDuplicateFileModel {
  @Expose()
  @ApiProperty({ description: 'Object key (relative, without owner prefix)' })
  @Transform(({ value }) => S3KeyConverter(value))
  Key: string;

  @Expose()
  @ApiProperty()
  Name: string;

  @Expose()
  @ApiProperty()
  Size: number;

  @Expose()
  @ApiProperty({ required: false })
  LastModified?: string;

  @Expose()
  @ApiProperty({ required: false })
  MimeType?: string;

  @Expose()
  @ApiProperty({ required: false, type: CloudPathModel })
  @Type(() => CloudPathModel)
  Path?: CloudPathModel;
}

export class CloudDuplicateGroupModel {
  @Expose()
  @ApiProperty({ description: 'Unique identifier for this duplicate group' })
  GroupId: string;

  @Expose()
  @ApiProperty({
    description: 'Type of duplicate detection: "exact" or "similar"',
  })
  MatchType: string;

  @Expose()
  @ApiProperty({
    description:
      'Similarity percentage (100 for exact match, <100 for perceptual)',
  })
  Similarity: number;

  @Expose()
  @ApiProperty({ type: CloudDuplicateFileModel, isArray: true })
  @Type(() => CloudDuplicateFileModel)
  Files: CloudDuplicateFileModel[];

  @Expose()
  @ApiProperty({
    description: 'Total bytes that could be reclaimed by removing duplicates',
  })
  PotentialSavingsBytes: number;
}

export class CloudDuplicateScanResultResponseModel {
  @Expose()
  @ApiProperty()
  ScanId: string;

  @Expose()
  @ApiProperty({ enum: DuplicateScanStatus })
  Status: string;

  @Expose()
  @ApiProperty()
  TotalFilesScanned: number;

  @Expose()
  @ApiProperty()
  TotalDuplicateGroups: number;

  @Expose()
  @ApiProperty()
  TotalPotentialSavingsBytes: number;

  @Expose()
  @ApiProperty({ type: CloudDuplicateGroupModel, isArray: true })
  @Type(() => CloudDuplicateGroupModel)
  Groups: CloudDuplicateGroupModel[];

  @Expose()
  @ApiProperty({ required: false })
  ScannedAt?: string;
}

export class CloudDuplicateScanCancelResponseModel {
  @Expose()
  @ApiProperty()
  Cancelled: boolean;
}
