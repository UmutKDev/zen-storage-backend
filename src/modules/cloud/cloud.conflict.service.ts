import { HeadObjectCommand, ListObjectsV2Command } from '@aws-sdk/client-s3';
import { HttpException, HttpStatus, Injectable } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { CloudS3Service } from './cloud.s3.service';
import { ConflictItemInfoModel, ConflictDetailModel } from './cloud.model';
import { EnsureTrailingSlash } from './cloud.utils';

export interface FileExistsInfo {
  Size: number;
  LastModified: string;
  ContentType: string;
}

@Injectable()
export class CloudConflictService {
  private readonly MaxKeepBothIterations = 100;

  constructor(private readonly CloudS3Service: CloudS3Service) {}

  async CheckFileExists(fullKey: string): Promise<FileExistsInfo | null> {
    try {
      const head = await this.CloudS3Service.Send(
        new HeadObjectCommand({
          Bucket: this.CloudS3Service.GetBuckets().Storage,
          Key: fullKey,
        }),
      );
      return {
        Size: head.ContentLength ?? 0,
        LastModified: head.LastModified?.toISOString() ?? '',
        ContentType: head.ContentType ?? 'application/octet-stream',
      };
    } catch (error) {
      if (this.CloudS3Service.IsNotFoundError(error)) {
        return null;
      }
      throw error;
    }
  }

  async CheckDirectoryExists(fullPrefix: string): Promise<boolean> {
    const prefix = EnsureTrailingSlash(fullPrefix);
    const result = await this.CloudS3Service.Send(
      new ListObjectsV2Command({
        Bucket: this.CloudS3Service.GetBuckets().Storage,
        Prefix: prefix,
        MaxKeys: 1,
      }),
    );
    return (result.KeyCount ?? result.Contents?.length ?? 0) > 0;
  }

  async GenerateKeepBothKey(
    fullKey: string,
    isDirectory: boolean,
  ): Promise<string> {
    if (isDirectory) {
      const withoutTrailingSlash = fullKey.replace(/\/+$/, '');
      const parts = withoutTrailingSlash.split('/');
      const baseName = parts.pop();
      const parentPrefix = parts.join('/');

      for (let i = 1; i <= this.MaxKeepBothIterations; i++) {
        const candidateName = `${baseName} (${i})`;
        const candidatePrefix = parentPrefix
          ? `${parentPrefix}/${candidateName}/`
          : `${candidateName}/`;
        const exists = await this.CheckDirectoryExists(candidatePrefix);
        if (!exists) {
          return candidatePrefix;
        }
      }

      throw new HttpException(
        'Cannot auto-rename: too many copies exist',
        HttpStatus.CONFLICT,
      );
    }

    const parts = fullKey.split('/');
    const fileName = parts.pop();
    const parentPrefix = parts.join('/');

    const dotIndex = fileName.lastIndexOf('.');
    let baseName: string;
    let extension: string;

    if (dotIndex > 0) {
      baseName = fileName.substring(0, dotIndex);
      extension = fileName.substring(dotIndex);
    } else {
      baseName = fileName;
      extension = '';
    }

    for (let i = 1; i <= this.MaxKeepBothIterations; i++) {
      const candidateName = `${baseName} (${i})${extension}`;
      const candidateKey = parentPrefix
        ? `${parentPrefix}/${candidateName}`
        : candidateName;
      const exists = await this.CheckFileExists(candidateKey);
      if (!exists) {
        return candidateKey;
      }
    }

    throw new HttpException(
      'Cannot auto-rename: too many copies exist',
      HttpStatus.CONFLICT,
    );
  }

  BuildConflictDetail(
    source: {
      Name: string;
      Key: string;
      Size?: number;
      LastModified?: string;
      IsDirectory: boolean;
    },
    target: {
      Name: string;
      Key: string;
      Size?: number;
      LastModified?: string;
      IsDirectory: boolean;
    },
  ): ConflictDetailModel {
    return plainToInstance(ConflictDetailModel, {
      Source: plainToInstance(ConflictItemInfoModel, source),
      Target: plainToInstance(ConflictItemInfoModel, target),
    });
  }
}
