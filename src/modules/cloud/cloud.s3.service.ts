import { _Object, GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { InjectAws } from 'aws-sdk-v3-nest';
import { Injectable } from '@nestjs/common';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

@Injectable()
export class CloudS3Service {
  public readonly Buckets = {
    Storage: 'storage-1',
    Photos: 'Photos',
  };
  public readonly PresignedUrlExpirySeconds = 3600;

  public readonly PublicEndpoint = process.env.S3_PUBLIC_ENDPOINT;

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

  BuildPath(
    relativeKey: string,
    fullKey: string,
  ): {
    Host: string;
    Key: string;
    Url: string;
  } {
    return {
      Host: this.GetPublicHostname(),
      Key: relativeKey,
      Url: this.GetUrl(fullKey),
    };
  }

  private ReplaceSignedUrlHost(url: string): string {
    const publicEndpoint = process.env.S3_PUBLIC_ENDPOINT;
    if (!publicEndpoint) {
      return url;
    }

    try {
      const signedUrl = new URL(url);
      const endpointUrl = new URL(publicEndpoint);
      signedUrl.protocol = endpointUrl.protocol;
      signedUrl.host = endpointUrl.host;
      return signedUrl.toString();
    } catch {
      return url;
    }
  }

  async SignedUrlBuilder(
    content: _Object,
    IsSignedUrlProcessing: boolean,
    CloudS3Service: CloudS3Service,
    PresignedUrlExpirySeconds: number,
  ): Promise<string> {
    const ObjectCommand = new GetObjectCommand({
      Bucket: CloudS3Service.GetBuckets().Storage,
      Key: content.Key,
    });

    if (IsSignedUrlProcessing) {
      return this.ReplaceSignedUrlHost(
        await getSignedUrl(CloudS3Service.GetClient(), ObjectCommand, {
          expiresIn: PresignedUrlExpirySeconds,
        }),
      );
    }

    return CloudS3Service.GetUrl(content.Key!);
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
