import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { Readable } from 'stream';
import {
  CloudKeyRequestModel,
  CloudMoveRequestModel,
  CloudDeleteRequestModel,
  CloudUpdateRequestModel,
  CloudObjectModel,
  CloudPreSignedUrlRequestModel,
  ConflictDetailModel,
  ConflictDetailsResponseModel,
} from './cloud.model';
import { CloudS3Service } from './cloud.s3.service';
import { CloudMetadataService } from './cloud.metadata.service';
import { CloudObjectModelService } from './cloud.object-model.service';
import { CloudConflictService } from './cloud.conflict.service';
import { CloudVersionService } from './cloud.version.service';
import { KeyBuilder } from '@common/helpers/cast.helper';
import { GetStorageOwnerId } from './cloud.context';
import {
  EnsureTrailingSlash,
  NormalizeDirectoryPath,
  GetFileName,
} from './cloud.utils';
import { ConflictResolutionStrategy } from '@common/enums';

@Injectable()
export class CloudObjectService {
  private readonly Logger = new Logger(CloudObjectService.name);

  constructor(
    private readonly CloudS3Service: CloudS3Service,
    private readonly CloudMetadataService: CloudMetadataService,
    private readonly CloudObjectModelService: CloudObjectModelService,
    private readonly CloudConflictService: CloudConflictService,
    private readonly CloudVersionService: CloudVersionService,
  ) {}

  async Find(
    { Key }: CloudKeyRequestModel,
    User: UserContext,
  ): Promise<CloudObjectModel> {
    try {
      const fullKey = KeyBuilder([GetStorageOwnerId(User), Key]);
      const head = await this.CloudS3Service.Send(
        new HeadObjectCommand({
          Bucket: this.CloudS3Service.GetBuckets().Storage,
          Key: fullKey,
        }),
      );

      return plainToInstance(
        CloudObjectModel,
        await this.CloudObjectModelService.BuildObjectModel(
          {
            Key: fullKey,
            Size: head.ContentLength,
            ETag: head.ETag,
            LastModified: head.LastModified,
          },
          User,
          {
            IsSignedUrlProcessing: true,
            Head: head,
          },
        ),
      );
    } catch (error) {
      if (this.CloudS3Service.IsNotFoundError(error)) {
        throw new HttpException(Codes.Error.Cloud.FILE_NOT_FOUND, 404);
      }
      throw error;
    }
  }

  async GetPresignedUrl(
    { Key, ExpiresInSeconds }: CloudPreSignedUrlRequestModel,
    User: UserContext,
  ): Promise<string> {
    try {
      await this.CloudS3Service.Send(
        new HeadObjectCommand({
          Bucket: this.CloudS3Service.GetBuckets().Storage,
          Key: KeyBuilder([GetStorageOwnerId(User), Key]),
        }),
      );

      const command = new GetObjectCommand({
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        Key: KeyBuilder([GetStorageOwnerId(User), Key]),
      });

      const url = await this.CloudS3Service.SignedUrlBuilder(
        { Key: KeyBuilder([GetStorageOwnerId(User), Key]) },
        true,
        this.CloudS3Service,
        ExpiresInSeconds ?? this.CloudS3Service.PresignedUrlExpirySeconds,
      );

      return url;
    } catch (error) {
      if (this.CloudS3Service.IsNotFoundError(error)) {
        throw new HttpException(Codes.Error.Cloud.FILE_NOT_FOUND, 404);
      }
      throw error;
    }
  }

  async GetObjectStream(
    { Key }: CloudKeyRequestModel,
    User: UserContext,
  ): Promise<ReadableStream> {
    try {
      const command = await this.CloudS3Service.Send(
        new GetObjectCommand({
          Bucket: this.CloudS3Service.GetBuckets().Storage,
          Key: KeyBuilder([GetStorageOwnerId(User), Key]),
        }),
      );
      return command.Body.transformToWebStream();
    } catch (error) {
      if (this.CloudS3Service.IsNotFoundError(error)) {
        throw new HttpException(Codes.Error.Cloud.FILE_NOT_FOUND, 404);
      }
      throw error;
    }
  }

  async GetObjectReadable(
    { Key }: CloudKeyRequestModel,
    User: UserContext,
  ): Promise<Readable> {
    try {
      const command = await this.CloudS3Service.Send(
        new GetObjectCommand({
          Bucket: this.CloudS3Service.GetBuckets().Storage,
          Key: KeyBuilder([GetStorageOwnerId(User), Key]),
        }),
      );

      const body = command.Body as unknown as Readable;
      return body;
    } catch (error) {
      if (this.CloudS3Service.IsNotFoundError(error)) {
        throw new HttpException(Codes.Error.Cloud.FILE_NOT_FOUND, 404);
      }
      throw error;
    }
  }

  async Move(
    { Items, DestinationKey, ConflictResolution }: CloudMoveRequestModel,
    User: UserContext,
  ): Promise<boolean> {
    const bucket = this.CloudS3Service.GetBuckets().Storage;
    const ownerId = GetStorageOwnerId(User);

    try {
      // Prevent moving a directory into itself
      for (const item of Items) {
        if (item.IsDirectory) {
          const sourceNorm = NormalizeDirectoryPath(item.Key);
          const destNorm = NormalizeDirectoryPath(DestinationKey);
          if (
            destNorm === sourceNorm ||
            destNorm.startsWith(sourceNorm + '/')
          ) {
            throw new HttpException(
              'Cannot move a directory into itself or its subdirectory',
              HttpStatus.BAD_REQUEST,
            );
          }
        }
      }

      const globalStrategy =
        ConflictResolution?.Strategy ?? ConflictResolutionStrategy.FAIL;
      const perItemMap = new Map<string, ConflictResolutionStrategy>();
      if (ConflictResolution?.Items) {
        for (const ri of ConflictResolution.Items) {
          perItemMap.set(ri.Key, ri.Strategy);
        }
      }

      // Detect conflicts
      const conflicts: ConflictDetailModel[] = [];
      const conflictedKeys = new Set<string>();

      for (const item of Items) {
        if (item.IsDirectory) {
          const dirName = item.Key.split('/').filter(Boolean).pop() || '';
          const targetPrefixFull = EnsureTrailingSlash(
            KeyBuilder([ownerId, DestinationKey, dirName]),
          );
          const exists =
            await this.CloudConflictService.CheckDirectoryExists(
              targetPrefixFull,
            );
          if (exists) {
            conflicts.push(
              this.CloudConflictService.BuildConflictDetail(
                {
                  Name: dirName,
                  Key: item.Key,
                  IsDirectory: true,
                },
                {
                  Name: dirName,
                  Key: KeyBuilder([DestinationKey, dirName]),
                  IsDirectory: true,
                },
              ),
            );
            conflictedKeys.add(item.Key);
          }
        } else {
          const fileName = GetFileName(item.Key);
          const targetFullKey = KeyBuilder([ownerId, DestinationKey, fileName]);
          const targetInfo =
            await this.CloudConflictService.CheckFileExists(targetFullKey);
          if (targetInfo) {
            const sourceFullKey = KeyBuilder([ownerId, item.Key]);
            let sourceSize: number | undefined;
            let sourceLastModified: string | undefined;
            try {
              const sourceHead = await this.CloudS3Service.Send(
                new HeadObjectCommand({
                  Bucket: bucket,
                  Key: sourceFullKey,
                }),
              );
              sourceSize = sourceHead.ContentLength;
              sourceLastModified = sourceHead.LastModified?.toISOString();
            } catch {
              // Source info is optional for conflict display
            }

            conflicts.push(
              this.CloudConflictService.BuildConflictDetail(
                {
                  Name: fileName,
                  Key: item.Key,
                  Size: sourceSize,
                  LastModified: sourceLastModified,
                  IsDirectory: false,
                },
                {
                  Name: fileName,
                  Key: KeyBuilder([DestinationKey, fileName]),
                  Size: targetInfo.Size,
                  LastModified: targetInfo.LastModified,
                  IsDirectory: false,
                },
              ),
            );
            conflictedKeys.add(item.Key);
          }
        }
      }

      // If conflicts exist and no resolution provided, return 409
      if (conflicts.length > 0) {
        const hasResolution =
          globalStrategy !== ConflictResolutionStrategy.FAIL ||
          perItemMap.size > 0;
        if (!hasResolution) {
          throw new HttpException(
            plainToInstance(ConflictDetailsResponseModel, {
              Conflicts: conflicts,
              TotalItems: Items.length,
              ConflictCount: conflicts.length,
            }),
            HttpStatus.CONFLICT,
          );
        }
      }

      // Execute moves with conflict resolution
      for (const item of Items) {
        const itemStrategy = perItemMap.get(item.Key) ?? globalStrategy;
        const hasConflict = conflictedKeys.has(item.Key);

        if (hasConflict && itemStrategy === ConflictResolutionStrategy.SKIP) {
          continue;
        }

        if (item.IsDirectory) {
          let resolvedTargetPrefix: string | undefined;
          if (
            hasConflict &&
            itemStrategy === ConflictResolutionStrategy.KEEP_BOTH
          ) {
            const dirName = item.Key.split('/').filter(Boolean).pop() || '';
            const originalTargetFull = EnsureTrailingSlash(
              KeyBuilder([ownerId, DestinationKey, dirName]),
            );
            resolvedTargetPrefix =
              await this.CloudConflictService.GenerateKeepBothKey(
                originalTargetFull,
                true,
              );
          }
          await this.MoveDirectory(
            item.Key,
            DestinationKey,
            User,
            resolvedTargetPrefix,
          );
        } else {
          const sourceFullKey = KeyBuilder([ownerId, item.Key]);
          const fileName = GetFileName(item.Key);
          let targetFullKey = KeyBuilder([ownerId, DestinationKey, fileName]);

          if (
            hasConflict &&
            itemStrategy === ConflictResolutionStrategy.KEEP_BOTH
          ) {
            const resolvedKey =
              await this.CloudConflictService.GenerateKeepBothKey(
                targetFullKey,
                false,
              );
            targetFullKey = resolvedKey;

            // Update originalfilename metadata to reflect the renamed file
            const resolvedFileName = GetFileName(targetFullKey) || fileName;
            const head = await this.CloudS3Service.Send(
              new HeadObjectCommand({
                Bucket: bucket,
                Key: sourceFullKey,
              }),
            );
            const updatedMetadata = {
              ...(head.Metadata || {}),
              originalfilename: resolvedFileName,
            };
            await this.CloudS3Service.Send(
              new CopyObjectCommand({
                Bucket: bucket,
                CopySource: `${bucket}/${sourceFullKey}`,
                Key: targetFullKey,
                Metadata: updatedMetadata,
                MetadataDirective: 'REPLACE',
                ContentType: head.ContentType || undefined,
              }),
            );

            await this.CloudVersionService.PermanentlyDeleteAllVersions(
              bucket,
              sourceFullKey,
            );
          } else {
            await this.CloudS3Service.Send(
              new CopyObjectCommand({
                Bucket: bucket,
                CopySource: `${bucket}/${sourceFullKey}`,
                Key: targetFullKey,
              }),
            );

            // Enforce version limit on target after Replace overwrites
            if (
              hasConflict &&
              itemStrategy === ConflictResolutionStrategy.REPLACE
            ) {
              await this.CloudVersionService.CleanupOldVersions(
                bucket,
                targetFullKey,
              );
            }

            await this.CloudVersionService.PermanentlyDeleteAllVersions(
              bucket,
              sourceFullKey,
            );
          }
        }
      }
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      if (this.CloudS3Service.IsNotFoundError(error)) {
        throw new HttpException(Codes.Error.Cloud.FILE_NOT_FOUND, 404);
      }
      throw error;
    }
    return true;
  }

  private async MoveDirectory(
    sourceKey: string,
    destinationKey: string,
    User: UserContext,
    resolvedTargetPrefix?: string,
  ): Promise<void> {
    const bucket = this.CloudS3Service.GetBuckets().Storage;
    const sourcePrefixFull = EnsureTrailingSlash(
      KeyBuilder([GetStorageOwnerId(User), sourceKey]),
    );
    const targetPrefixFull = resolvedTargetPrefix
      ? resolvedTargetPrefix
      : EnsureTrailingSlash(
          KeyBuilder([
            GetStorageOwnerId(User),
            destinationKey,
            sourceKey.split('/').filter(Boolean).pop() || '',
          ]),
        );

    let continuationToken: string | undefined = undefined;
    let movedObjects = 0;

    do {
      const listResp = await this.CloudS3Service.Send(
        new ListObjectsV2Command({
          Bucket: bucket,
          Prefix: sourcePrefixFull,
          ContinuationToken: continuationToken,
          MaxKeys: 1000,
        }),
      );

      const contents = listResp.Contents || [];
      if (!contents.length && !listResp.IsTruncated && movedObjects === 0) {
        throw new HttpException(Codes.Error.Cloud.FILE_NOT_FOUND, 404);
      }

      for (const content of contents) {
        if (!content.Key) {
          continue;
        }

        const suffix = content.Key.startsWith(sourcePrefixFull)
          ? content.Key.slice(sourcePrefixFull.length)
          : '';
        const targetKey = suffix
          ? targetPrefixFull + suffix
          : targetPrefixFull.slice(0, -1);

        await this.CloudS3Service.Send(
          new CopyObjectCommand({
            Bucket: bucket,
            CopySource: `${bucket}/${content.Key}`,
            Key: targetKey,
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
  }

  async Delete(
    { Items }: CloudDeleteRequestModel,
    User: UserContext,
  ): Promise<boolean> {
    try {
      const bucket = this.CloudS3Service.GetBuckets().Storage;
      for await (const item of Items) {
        if (item.IsDirectory) {
          continue;
        }
        const fullKey = KeyBuilder([GetStorageOwnerId(User), item.Key]);
        await this.CloudVersionService.PermanentlyDeleteAllVersions(
          bucket,
          fullKey,
        );
      }
    } catch (error) {
      if (this.CloudS3Service.IsNotFoundError(error)) {
        throw new HttpException(Codes.Error.Cloud.FILE_NOT_FOUND, 404);
      }
      throw error;
    }
    return true;
  }

  async Update(
    { Key, Name, Metadata, ConflictStrategy }: CloudUpdateRequestModel,
    User: UserContext,
  ): Promise<CloudObjectModel> {
    try {
      const bucket = this.CloudS3Service.GetBuckets().Storage;

      const sourceKey = KeyBuilder([GetStorageOwnerId(User), Key]);

      let targetRelative = Key;
      let targetKey = sourceKey;
      let wasReplace = false;

      if (Name) {
        const parts = Key.split('/');
        parts[parts.length - 1] = Name;
        targetRelative = parts.join('/');
        targetKey = KeyBuilder([GetStorageOwnerId(User), targetRelative]);
      }

      // Conflict detection for rename
      if (targetKey !== sourceKey) {
        const targetInfo =
          await this.CloudConflictService.CheckFileExists(targetKey);
        if (targetInfo) {
          const strategy = ConflictStrategy ?? ConflictResolutionStrategy.FAIL;

          if (strategy === ConflictResolutionStrategy.FAIL) {
            const fileName = GetFileName(Key);
            const targetFileName = Name || fileName;
            throw new HttpException(
              plainToInstance(ConflictDetailsResponseModel, {
                Conflicts: [
                  this.CloudConflictService.BuildConflictDetail(
                    {
                      Name: fileName,
                      Key: Key,
                      IsDirectory: false,
                    },
                    {
                      Name: targetFileName,
                      Key: targetRelative,
                      Size: targetInfo.Size,
                      LastModified: targetInfo.LastModified,
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
            return this.Find({ Key }, User);
          }

          if (strategy === ConflictResolutionStrategy.KEEP_BOTH) {
            const resolvedKey =
              await this.CloudConflictService.GenerateKeepBothKey(
                targetKey,
                false,
              );
            // Extract the user-relative path from the resolved full key
            const ownerPrefix = GetStorageOwnerId(User) + '/';
            targetRelative = resolvedKey.startsWith(ownerPrefix)
              ? resolvedKey.slice(ownerPrefix.length)
              : resolvedKey;
            targetKey = resolvedKey;
          }

          // REPLACE: continue with overwrite (existing behavior)
          wasReplace = true;
        }
      }

      const sanitizedProvidedMetadata =
        this.CloudMetadataService.SanitizeMetadataForS3(Metadata);

      // Update originalfilename metadata if the key was changed by KEEP_BOTH
      if (targetKey !== sourceKey) {
        const resolvedFileName = GetFileName(targetRelative);
        if (resolvedFileName) {
          sanitizedProvidedMetadata['originalfilename'] = resolvedFileName;
        }
      }

      let finalMetadataForS3: Record<string, string> = {};
      let sourceContentType: string | undefined = undefined;
      if (Object.keys(sanitizedProvidedMetadata).length) {
        const head = await this.CloudS3Service.Send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: sourceKey,
          }),
        );
        const existingMetadata = head.Metadata || {};
        sourceContentType = head.ContentType as string | undefined;
        finalMetadataForS3 = {
          ...existingMetadata,
          ...sanitizedProvidedMetadata,
        };
        this.Logger.debug(
          `CloudObjectService.Update finalMetadata keys: ${Object.keys(
            finalMetadataForS3,
          ).join(',')}`,
        );
      }

      if (targetKey !== sourceKey) {
        await this.CloudS3Service.Send(
          new CopyObjectCommand({
            Bucket: bucket,
            CopySource: `${bucket}/${sourceKey}`,
            Key: targetKey,
            Metadata: Object.keys(finalMetadataForS3).length
              ? finalMetadataForS3
              : undefined,
            MetadataDirective: Object.keys(finalMetadataForS3).length
              ? 'REPLACE'
              : 'COPY',
            ContentType:
              Object.keys(finalMetadataForS3).length && sourceContentType
                ? sourceContentType
                : undefined,
          }),
        );

        if (Object.keys(sanitizedProvidedMetadata).length) {
          const headAfterCopy = await this.CloudS3Service.Send(
            new HeadObjectCommand({
              Bucket: bucket,
              Key: targetKey,
            }),
          );

          const missingKeys = Object.keys(sanitizedProvidedMetadata).filter(
            (k) => !headAfterCopy.Metadata || !(k in headAfterCopy.Metadata),
          );

          if (missingKeys.length) {
            const getResp = await this.CloudS3Service.Send(
              new GetObjectCommand({
                Bucket: bucket,
                Key: targetKey,
              }),
            );

            const stream = getResp.Body as Readable;

            await this.CloudS3Service.Send(
              new PutObjectCommand({
                Bucket: bucket,
                Key: targetKey,
                Body: stream,
                ContentType: sourceContentType,
                Metadata: finalMetadataForS3,
              }),
            );
          }
        }

        // Enforce version limit on target after Replace overwrites
        if (wasReplace) {
          await this.CloudVersionService.CleanupOldVersions(bucket, targetKey);
        }

        await this.CloudVersionService.PermanentlyDeleteAllVersions(
          bucket,
          sourceKey,
        );
      } else if (Object.keys(finalMetadataForS3).length) {
        await this.CloudS3Service.Send(
          new CopyObjectCommand({
            Bucket: bucket,
            CopySource: `${bucket}/${sourceKey}`,
            Key: sourceKey,
            Metadata: finalMetadataForS3,
            MetadataDirective: 'REPLACE',
            ContentType: sourceContentType ? sourceContentType : undefined,
          }),
        );

        const headAfterReplace = await this.CloudS3Service.Send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: sourceKey,
          }),
        );

        const missingKeys2 = Object.keys(sanitizedProvidedMetadata).filter(
          (k) =>
            !headAfterReplace.Metadata || !(k in headAfterReplace.Metadata),
        );

        if (missingKeys2.length) {
          const getResp = await this.CloudS3Service.Send(
            new GetObjectCommand({
              Bucket: bucket,
              Key: sourceKey,
            }),
          );
          const stream = getResp.Body as Readable;

          await this.CloudS3Service.Send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: sourceKey,
              Body: stream,
              ContentType: sourceContentType,
              Metadata: finalMetadataForS3,
            }),
          );
        }
      }

      return this.Find({ Key: targetRelative }, User);
    } catch (error) {
      if (this.CloudS3Service.IsNotFoundError(error)) {
        throw new HttpException(Codes.Error.Cloud.FILE_NOT_FOUND, 404);
      }
      throw error;
    }
  }
}
