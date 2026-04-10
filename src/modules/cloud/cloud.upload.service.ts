import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { Injectable } from '@nestjs/common';
import { HttpException, HttpStatus } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import {
  CloudAbortMultipartUploadRequestModel,
  CloudCompleteMultipartUploadRequestModel,
  CloudCompleteMultipartUploadResponseModel,
  CloudCreateMultipartUploadRequestModel,
  CloudCreateMultipartUploadResponseModel,
  CloudGetMultipartPartUrlRequestModel,
  CloudGetMultipartPartUrlResponseModel,
  CloudGetMultipartPartUrlsBatchRequestModel,
  CloudGetMultipartPartUrlsBatchResponseModel,
  CloudUploadPartRequestModel,
  CloudUploadPartResponseModel,
  ConflictDetailsResponseModel,
} from './cloud.model';
import { CloudS3Service } from './cloud.s3.service';
import { CloudMetadataService } from './cloud.metadata.service';
import { CloudConflictService } from './cloud.conflict.service';
import { KeyBuilder } from '@common/helpers/cast.helper';
import { GetStorageOwnerId } from './cloud.context';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { ConflictResolutionStrategy } from '@common/enums';

@Injectable()
export class CloudUploadService {
  constructor(
    private readonly CloudS3Service: CloudS3Service,
    private readonly CloudMetadataService: CloudMetadataService,
    private readonly CloudConflictService: CloudConflictService,
  ) {}

  async UploadCreateMultipartUpload(
    {
      Key,
      ContentType,
      Metadata,
      TotalSize,
      ConflictStrategy,
    }: CloudCreateMultipartUploadRequestModel,
    User: UserContext,
  ): Promise<CloudCreateMultipartUploadResponseModel> {
    const ownerId = GetStorageOwnerId(User);
    let resolvedKey = Key;
    const fullKey = KeyBuilder([ownerId, Key]);

    // Conflict detection
    const existingFile =
      await this.CloudConflictService.CheckFileExists(fullKey);
    if (existingFile) {
      const strategy = ConflictStrategy ?? ConflictResolutionStrategy.FAIL;

      if (strategy === ConflictResolutionStrategy.FAIL) {
        const fileName = Key.split('/').pop() || '';
        throw new HttpException(
          plainToInstance(ConflictDetailsResponseModel, {
            Conflicts: [
              this.CloudConflictService.BuildConflictDetail(
                {
                  Name: fileName,
                  Key: Key,
                  Size: TotalSize,
                  IsDirectory: false,
                },
                {
                  Name: fileName,
                  Key: Key,
                  Size: existingFile.Size,
                  LastModified: existingFile.LastModified,
                  IsDirectory: false,
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
        throw new HttpException(
          'SKIP is not a valid strategy for uploads',
          HttpStatus.BAD_REQUEST,
        );
      }

      if (strategy === ConflictResolutionStrategy.KEEP_BOTH) {
        const resolvedFullKey =
          await this.CloudConflictService.GenerateKeepBothKey(fullKey, false);
        const ownerPrefix = ownerId + '/';
        resolvedKey = resolvedFullKey.startsWith(ownerPrefix)
          ? resolvedFullKey.slice(ownerPrefix.length)
          : resolvedFullKey;
      }

      // REPLACE: continue with the original key (overwrite)
    }

    // Update Originalfilename metadata if the key was changed by KEEP_BOTH
    const resolvedMetadata = { ...(Metadata ?? {}) };
    if (resolvedKey !== Key) {
      const resolvedFileName = resolvedKey.split('/').pop() || '';
      if (resolvedFileName) {
        resolvedMetadata['originalFileName'] = resolvedFileName;
      }
    }

    const command = await this.CloudS3Service.Send(
      new CreateMultipartUploadCommand({
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        Key: KeyBuilder([ownerId, resolvedKey]),
        ContentType: ContentType,
        Metadata:
          this.CloudMetadataService.SanitizeMetadataForS3(resolvedMetadata),
      }),
    );

    return plainToInstance(CloudCreateMultipartUploadResponseModel, {
      UploadId: command.UploadId,
      Key: command.Key.replace('' + ownerId + '/', ''),
    });
  }

  async UploadGetMultipartPartUrl(
    { Key, UploadId, PartNumber }: CloudGetMultipartPartUrlRequestModel,
    User: UserContext,
  ): Promise<CloudGetMultipartPartUrlResponseModel> {
    const command = new UploadPartCommand({
      Bucket: this.CloudS3Service.GetBuckets().Storage,
      Key: KeyBuilder([GetStorageOwnerId(User), Key]),
      UploadId: UploadId,
      PartNumber: PartNumber,
    });

    const url = await getSignedUrl(this.CloudS3Service.GetClient(), command, {
      expiresIn: this.CloudS3Service.PresignedUrlExpirySeconds,
    });

    return plainToInstance(CloudGetMultipartPartUrlResponseModel, {
      Url: url,
      Expires: this.CloudS3Service.PresignedUrlExpirySeconds,
    });
  }

  async UploadGetMultipartPartUrlsBatch(
    {
      Key,
      UploadId,
      TotalParts,
      PartNumbers,
    }: CloudGetMultipartPartUrlsBatchRequestModel,
    User: UserContext,
  ): Promise<CloudGetMultipartPartUrlsBatchResponseModel> {
    if (!TotalParts && (!PartNumbers || PartNumbers.length === 0)) {
      throw new HttpException(
        'Either TotalParts or PartNumbers must be provided.',
        HttpStatus.BAD_REQUEST,
      );
    }
    if (TotalParts && PartNumbers && PartNumbers.length > 0) {
      throw new HttpException(
        'TotalParts and PartNumbers are mutually exclusive. Provide only one.',
        HttpStatus.BAD_REQUEST,
      );
    }

    const resolvedPartNumbers: number[] = PartNumbers
      ? PartNumbers
      : Array.from({ length: TotalParts }, (_, i) => i + 1);

    const parts = await Promise.all(
      resolvedPartNumbers.map(async (partNumber) => {
        const command = new UploadPartCommand({
          Bucket: this.CloudS3Service.GetBuckets().Storage,
          Key: KeyBuilder([GetStorageOwnerId(User), Key]),
          UploadId: UploadId,
          PartNumber: partNumber,
        });

        const url = await getSignedUrl(
          this.CloudS3Service.GetClient(),
          command,
          { expiresIn: this.CloudS3Service.PresignedUrlExpirySeconds },
        );

        return {
          PartNumber: partNumber,
          Url: url,
          Expires: this.CloudS3Service.PresignedUrlExpirySeconds,
        };
      }),
    );

    return plainToInstance(CloudGetMultipartPartUrlsBatchResponseModel, {
      Parts: parts,
    });
  }

  async UploadPart(
    {
      Key,
      UploadId,
      PartNumber,
      File,
      ContentMd5,
    }: CloudUploadPartRequestModel,
    User: UserContext,
  ): Promise<CloudUploadPartResponseModel> {
    const command = new UploadPartCommand({
      Bucket: this.CloudS3Service.GetBuckets().Storage,
      Key: KeyBuilder([GetStorageOwnerId(User), Key]),
      UploadId: UploadId,
      PartNumber: PartNumber,
      Body: File.buffer,
      ContentMD5: ContentMd5,
    });

    const result = await this.CloudS3Service.Send(command);

    return plainToInstance(CloudUploadPartResponseModel, {
      ETag: result.ETag,
    });
  }

  async UploadCompleteMultipartUpload(
    { Key, UploadId, Parts }: CloudCompleteMultipartUploadRequestModel,
    User: UserContext,
  ): Promise<CloudCompleteMultipartUploadResponseModel> {
    const command = await this.CloudS3Service.Send(
      new CompleteMultipartUploadCommand({
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        Key: KeyBuilder([GetStorageOwnerId(User), Key]),
        UploadId: UploadId,
        MultipartUpload: {
          Parts: Parts,
        },
      }),
    );

    const metadata = await this.CloudMetadataService.MetadataProcessor(
      KeyBuilder([GetStorageOwnerId(User), Key]),
    );

    return plainToInstance(CloudCompleteMultipartUploadResponseModel, {
      Location: command.Location,
      Key: command.Key.replace('' + GetStorageOwnerId(User) + '/', ''),
      Bucket: command.Bucket,
      ETag: command.ETag,
      Metadata: metadata,
    });
  }

  async UploadAbortMultipartUpload(
    { Key, UploadId }: CloudAbortMultipartUploadRequestModel,
    User: UserContext,
  ): Promise<void> {
    await this.CloudS3Service.Send(
      new AbortMultipartUploadCommand({
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        Key: KeyBuilder([GetStorageOwnerId(User), Key]),
        UploadId: UploadId,
      }),
    );
  }
}
