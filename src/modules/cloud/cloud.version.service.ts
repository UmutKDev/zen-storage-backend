import {
  CopyObjectCommand,
  DeleteObjectCommand,
  HeadObjectCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import { HttpException, HttpStatus, Injectable, Logger } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { CloudS3Service } from './cloud.s3.service';
import { CloudVersionModel } from './cloud.model';

@Injectable()
export class CloudVersionService {
  private readonly Logger = new Logger(CloudVersionService.name);
  private readonly MaxOldVersions = 5;

  constructor(private readonly CloudS3Service: CloudS3Service) {}

  async ListVersions(
    bucket: string,
    key: string,
  ): Promise<CloudVersionModel[]> {
    const versions: CloudVersionModel[] = [];
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const resp = await this.CloudS3Service.Send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: key,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
          MaxKeys: 50,
        }),
      );

      for (const v of resp.Versions || []) {
        // Only include exact key matches (not prefix matches)
        if (v.Key !== key) continue;
        // Skip current version — we only list old versions
        if (v.IsLatest) continue;

        versions.push(
          plainToInstance(CloudVersionModel, {
            VersionId: v.VersionId,
            Key: v.Key,
            Size: v.Size ?? 0,
            LastModified: v.LastModified?.toISOString() ?? '',
            IsLatest: false,
            ETag: v.ETag ?? '',
          }),
        );
      }

      if (resp.IsTruncated) {
        keyMarker = resp.NextKeyMarker;
        versionIdMarker = resp.NextVersionIdMarker;
      } else {
        hasMore = false;
      }
    }

    // Sort newest first
    versions.sort(
      (a, b) =>
        new Date(b.LastModified).getTime() - new Date(a.LastModified).getTime(),
    );

    return versions;
  }

  async RestoreVersion(
    bucket: string,
    key: string,
    versionId: string,
  ): Promise<void> {
    // Verify the version exists and is not the latest
    const versions = await this.ListAllVersions(bucket, key);
    const target = versions.find((v) => v.VersionId === versionId);
    if (!target) {
      throw new HttpException('Version not found', HttpStatus.NOT_FOUND);
    }
    if (target.IsLatest) {
      throw new HttpException(
        'Cannot restore the current version — it is already active',
        HttpStatus.BAD_REQUEST,
      );
    }

    // Get metadata from the version being restored
    const head = await this.CloudS3Service.Send(
      new HeadObjectCommand({
        Bucket: bucket,
        Key: key,
        VersionId: versionId,
      }),
    );

    // Copy the old version as the new current version
    // MetadataDirective REPLACE is required when source and destination key are the same
    await this.CloudS3Service.Send(
      new CopyObjectCommand({
        Bucket: bucket,
        CopySource: `${bucket}/${key}?versionId=${versionId}`,
        Key: key,
        MetadataDirective: 'REPLACE',
        Metadata: head.Metadata || {},
        ContentType: head.ContentType || undefined,
      }),
    );

    // Enforce version limit after restore
    await this.CleanupOldVersions(bucket, key);
  }

  async DeleteVersion(
    bucket: string,
    key: string,
    versionId: string,
  ): Promise<void> {
    // Verify the version exists and is not the latest
    const versions = await this.ListAllVersions(bucket, key);
    const target = versions.find((v) => v.VersionId === versionId);
    if (!target) {
      throw new HttpException('Version not found', HttpStatus.NOT_FOUND);
    }
    if (target.IsLatest) {
      throw new HttpException(
        'Cannot delete the current version',
        HttpStatus.BAD_REQUEST,
      );
    }

    await this.CloudS3Service.Send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: key,
        VersionId: versionId,
      }),
    );
  }

  async CleanupOldVersions(
    bucket: string,
    key: string,
    maxVersions: number = this.MaxOldVersions,
  ): Promise<void> {
    const allVersions = await this.ListAllVersions(bucket, key);

    // Filter to non-current versions only
    const oldVersions = allVersions
      .filter((v) => !v.IsLatest)
      .sort(
        (a, b) =>
          new Date(b.LastModified).getTime() -
          new Date(a.LastModified).getTime(),
      );

    if (oldVersions.length <= maxVersions) {
      return;
    }

    // Delete excess old versions (keep newest maxVersions)
    const toDelete = oldVersions.slice(maxVersions);
    for (const version of toDelete) {
      await this.CloudS3Service.Send(
        new DeleteObjectCommand({
          Bucket: bucket,
          Key: key,
          VersionId: version.VersionId,
        }),
      );
    }

    this.Logger.debug(
      `CleanupOldVersions: deleted ${toDelete.length} old version(s) for key="${key}"`,
    );
  }

  async PermanentlyDeleteAllVersions(
    bucket: string,
    key: string,
  ): Promise<void> {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const resp = await this.CloudS3Service.Send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: key,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
          MaxKeys: 1000,
        }),
      );

      // Delete all versions for this exact key
      for (const v of resp.Versions || []) {
        if (v.Key !== key) continue;
        await this.CloudS3Service.Send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
            VersionId: v.VersionId,
          }),
        );
      }

      // Delete all delete markers for this exact key
      for (const dm of resp.DeleteMarkers || []) {
        if (dm.Key !== key) continue;
        await this.CloudS3Service.Send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
            VersionId: dm.VersionId,
          }),
        );
      }

      if (resp.IsTruncated) {
        keyMarker = resp.NextKeyMarker;
        versionIdMarker = resp.NextVersionIdMarker;
      } else {
        hasMore = false;
      }
    }
  }

  async PermanentlyDeleteAllVersionsByPrefix(
    bucket: string,
    prefix: string,
  ): Promise<void> {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const resp = await this.CloudS3Service.Send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: prefix,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
          MaxKeys: 1000,
        }),
      );

      for (const v of resp.Versions || []) {
        await this.CloudS3Service.Send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: v.Key,
            VersionId: v.VersionId,
          }),
        );
      }

      for (const dm of resp.DeleteMarkers || []) {
        await this.CloudS3Service.Send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: dm.Key,
            VersionId: dm.VersionId,
          }),
        );
      }

      if (resp.IsTruncated) {
        keyMarker = resp.NextKeyMarker;
        versionIdMarker = resp.NextVersionIdMarker;
      } else {
        hasMore = false;
      }
    }
  }

  private async ListAllVersions(
    bucket: string,
    key: string,
  ): Promise<
    Array<{
      VersionId: string;
      IsLatest: boolean;
      LastModified: string;
      Size: number;
    }>
  > {
    const versions: Array<{
      VersionId: string;
      IsLatest: boolean;
      LastModified: string;
      Size: number;
    }> = [];

    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;
    let hasMore = true;

    while (hasMore) {
      const resp = await this.CloudS3Service.Send(
        new ListObjectVersionsCommand({
          Bucket: bucket,
          Prefix: key,
          KeyMarker: keyMarker,
          VersionIdMarker: versionIdMarker,
          MaxKeys: 1000,
        }),
      );

      for (const v of resp.Versions || []) {
        if (v.Key !== key) continue;
        versions.push({
          VersionId: v.VersionId ?? '',
          IsLatest: v.IsLatest ?? false,
          LastModified: v.LastModified?.toISOString() ?? '',
          Size: v.Size ?? 0,
        });
      }

      if (resp.IsTruncated) {
        keyMarker = resp.NextKeyMarker;
        versionIdMarker = resp.NextVersionIdMarker;
      } else {
        hasMore = false;
      }
    }

    return versions;
  }
}
