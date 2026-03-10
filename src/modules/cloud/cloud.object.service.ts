import {
  CopyObjectCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { HttpException, Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { Readable } from 'stream';
import {
  CloudKeyRequestModel,
  CloudMoveRequestModel,
  CloudDeleteRequestModel,
  CloudUpdateRequestModel,
  CloudObjectModel,
  CloudPreSignedUrlRequestModel,
} from './cloud.model';
import { CloudS3Service } from './cloud.s3.service';
import { CloudMetadataService } from './cloud.metadata.service';
import { KeyBuilder } from '@common/helpers/cast.helper';
import { GetStorageOwnerId } from './cloud.context';
import { EnsureTrailingSlash } from './cloud.utils';

@Injectable()
export class CloudObjectService {
  private readonly Logger = new Logger(CloudObjectService.name);
  private readonly PresignedUrlExpirySeconds = 3600; // 1 hour

  constructor(
    private readonly CloudS3Service: CloudS3Service,
    private readonly CloudMetadataService: CloudMetadataService,
  ) {}

  async Find(
    { Key }: CloudKeyRequestModel,
    User: UserContext,
  ): Promise<CloudObjectModel> {
    try {
      const command = await this.CloudS3Service.Send(
        new HeadObjectCommand({
          Bucket: this.CloudS3Service.GetBuckets().Storage,
          Key: KeyBuilder([GetStorageOwnerId(User), Key]),
        }),
      );

      return plainToInstance(CloudObjectModel, {
        Name: Key?.split('/').pop(),
        Extension: Key?.includes('.') ? Key.split('.').pop() : undefined,
        MimeType: command.ContentType,
        Path: {
          Host: this.CloudS3Service.GetPublicHostname(),
          Key: Key.replace('' + GetStorageOwnerId(User) + '/', ''),
          Url: Key,
        },
        Metadata: this.CloudMetadataService.DecodeMetadataFromS3(
          command.Metadata,
        ),
        Size: command.ContentLength,
        ETag: command.ETag,
        LastModified: command.LastModified
          ? command.LastModified.toISOString()
          : '',
      });
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

      const url = await getSignedUrl(this.CloudS3Service.GetClient(), command, {
        expiresIn: ExpiresInSeconds || this.PresignedUrlExpirySeconds,
      });

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
    { Items, DestinationKey }: CloudMoveRequestModel,
    User: UserContext,
  ): Promise<boolean> {
    const bucket = this.CloudS3Service.GetBuckets().Storage;
    try {
      for (const item of Items) {
        if (item.IsDirectory) {
          await this.MoveDirectory(item.Key, DestinationKey, User);
        } else {
          const sourceFullKey = KeyBuilder([GetStorageOwnerId(User), item.Key]);
          const targetFullKey = KeyBuilder([
            GetStorageOwnerId(User),
            DestinationKey,
            item.Key.split('/').pop() || '',
          ]);

          await this.CloudS3Service.Send(
            new CopyObjectCommand({
              Bucket: bucket,
              CopySource: `${bucket}/${sourceFullKey}`,
              Key: targetFullKey,
            }),
          );

          await this.CloudS3Service.Send(
            new DeleteObjectCommand({
              Bucket: bucket,
              Key: sourceFullKey,
            }),
          );
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
  ): Promise<void> {
    const bucket = this.CloudS3Service.GetBuckets().Storage;
    const sourcePrefixFull = EnsureTrailingSlash(
      KeyBuilder([GetStorageOwnerId(User), sourceKey]),
    );
    const dirName = sourceKey.split('/').filter(Boolean).pop() || '';
    const targetPrefixFull = EnsureTrailingSlash(
      KeyBuilder([GetStorageOwnerId(User), destinationKey, dirName]),
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

        await this.CloudS3Service.Send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: content.Key,
          }),
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
      for await (const item of Items) {
        if (item.IsDirectory) {
          continue;
        }
        await this.CloudS3Service.Send(
          new DeleteObjectCommand({
            Bucket: this.CloudS3Service.GetBuckets().Storage,
            Key: KeyBuilder([GetStorageOwnerId(User), item.Key]),
          }),
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
    { Key, Name, Metadata }: CloudUpdateRequestModel,
    User: UserContext,
  ): Promise<CloudObjectModel> {
    try {
      const bucket = this.CloudS3Service.GetBuckets().Storage;

      const sourceKey = KeyBuilder([GetStorageOwnerId(User), Key]);

      let targetRelative = Key;
      let targetKey = sourceKey;

      if (Name) {
        const parts = Key.split('/');
        parts[parts.length - 1] = Name;
        targetRelative = parts.join('/');
        targetKey = KeyBuilder([GetStorageOwnerId(User), targetRelative]);
      }

      const sanitizedProvidedMetadata =
        this.CloudMetadataService.SanitizeMetadataForS3(Metadata);

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

        await this.CloudS3Service.Send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: sourceKey,
          }),
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
