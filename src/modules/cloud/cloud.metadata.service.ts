import {
  CopyObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
} from '@aws-sdk/client-s3';
import { Injectable, Logger } from '@nestjs/common';
import { Readable } from 'stream';
import sharp from 'sharp';
import { CloudS3Service } from './cloud.s3.service';
import {
  EncodeCopySource,
  IsImageFile,
  PascalizeKeys,
} from '@common/helpers/cast.helper';

@Injectable()
export class CloudMetadataService {
  private readonly Logger = new Logger(CloudMetadataService.name);

  constructor(private readonly CloudS3Service: CloudS3Service) {}

  async MetadataProcessor(key: string): Promise<Record<string, string>> {
    if (IsImageFile(key)) {
      return this.ProcessImageMetadata(key);
    }
    return {};
  }

  async ProcessFileMetadata(key: string): Promise<Record<string, string>> {
    try {
      const headObjectCommand = new HeadObjectCommand({
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        Key: key,
      });
      const object = await this.CloudS3Service.Send(headObjectCommand);
      const existingMetadata = object.Metadata || {};

      return this.DecodeMetadataFromS3(existingMetadata);
    } catch (error) {
      this.Logger.error(
        `Failed to process file metadata for key ${key}:`,
        error,
      );
      return {};
    }
  }

  async ProcessImageMetadata(key: string): Promise<Record<string, string>> {
    try {
      const getObjectCommand = new GetObjectCommand({
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        Key: key,
      });
      const object = await this.CloudS3Service.Send(getObjectCommand);

      const existingMetadata = object.Metadata || {};

      const stream = object.Body as Readable;
      const chunks: Buffer[] = [];

      for await (const chunk of stream) {
        chunks.push(Buffer.from(chunk));
      }
      const buffer = Buffer.concat(chunks);

      const metadata = await sharp(buffer).metadata();

      if (metadata.width && metadata.height) {
        const newMetadataRaw = {
          ...existingMetadata,
          width: metadata.width.toString(),
          height: metadata.height.toString(),
        };

        const newMetadata = this.SanitizeMetadataForS3(newMetadataRaw);

        const copySource = EncodeCopySource(
          this.CloudS3Service.GetBuckets().Storage,
          key,
        );

        await this.CloudS3Service.Send(
          new PutObjectCommand({
            Bucket: this.CloudS3Service.GetBuckets().Storage,
            Key: key,
            Body: buffer,
            ContentType: object.ContentType,
            Metadata: newMetadata,
          }),
        );

        await this.CloudS3Service.Send(
          new CopyObjectCommand({
            Bucket: this.CloudS3Service.GetBuckets().Storage,
            CopySource: copySource,
            Key: key,
            Metadata: newMetadata,
            MetadataDirective: 'REPLACE',
            ContentType: object.ContentType,
          }),
        );

        return this.DecodeMetadataFromS3(newMetadata);
      }
      return existingMetadata;
    } catch (error) {
      this.Logger.error(
        `Failed to process image metadata for key ${key}:`,
        error,
      );
      return {};
    }
  }

  SanitizeMetadataForS3(
    metadata?: Record<string, string>,
  ): Record<string, string> {
    if (!metadata) return {};
    const sanitized: Record<string, string> = {};
    for (const [rawKey, rawVal] of Object.entries(metadata)) {
      const key = String(rawKey)
        .toLowerCase()
        .replace(/[^a-z0-9-_]/g, '-');
      let value = rawVal == null ? '' : String(rawVal);
      value = value.replace(/(\r\n|\r|\n)/g, ' ').trim();
      if (/[^\x20-\x7e]/.test(value)) {
        value = 'b64:' + Buffer.from(value, 'utf8').toString('base64');
      }
      sanitized[key] = value;
    }
    return sanitized;
  }

  DecodeMetadataFromS3(
    metadata?: Record<string, string>,
  ): Record<string, string> {
    if (!metadata) return {};
    const decoded: Record<string, string> = {};
    for (const [key, value] of Object.entries(metadata)) {
      if (typeof value === 'string' && value.startsWith('b64:')) {
        const b64 = value.slice(4);
        try {
          decoded[key] = Buffer.from(b64, 'base64').toString('utf8');
          // eslint-disable-next-line @typescript-eslint/no-unused-vars
        } catch (err) {
          decoded[key] = value;
        }
      } else {
        decoded[key] = value as string;
      }
    }
    return PascalizeKeys(decoded);
  }
}
