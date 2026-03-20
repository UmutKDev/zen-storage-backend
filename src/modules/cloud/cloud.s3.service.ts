import { S3Client } from '@aws-sdk/client-s3';
import { InjectAws } from 'aws-sdk-v3-nest';
import { Injectable } from '@nestjs/common';

@Injectable()
export class CloudS3Service {
  private readonly Buckets = {
    Storage: 'storage-1',
    Photos: 'Photos',
  };

  private readonly PublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;

  private readonly NotFoundErrorCodes = ['NoSuchKey', 'NotFound'];

  @InjectAws(S3Client) private readonly S3: S3Client;

  GetBuckets(): { Storage: string; Photos: string } {
    return this.Buckets;
  }

  GetPublicEndpoint(): string {
    return this.PublicEndpoint + '/' + this.Buckets.Storage;
  }

  GetPublicHostname(): string {
    const url = new URL(this.PublicEndpoint);
    return url.hostname;
  }

  GetKey(key: string, userId: string): string {
    return key.replace('' + userId + '/', '');
  }

  GetUrl(key: string): string {
    return `${this.PublicEndpoint}/${this.Buckets.Storage}/${key}`;
  }

  IsNotFoundError(error: { name?: string } | undefined): boolean {
    const code = error?.name;
    return !!code && this.NotFoundErrorCodes.includes(code);
  }

  GetClient(): S3Client {
    return this.S3;
  }

  async Send(command: unknown): Promise<any> {
    return this.S3.send(command as never);
  }
}
