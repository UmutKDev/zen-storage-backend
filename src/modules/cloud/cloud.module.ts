import { S3Client } from '@aws-sdk/client-s3';
import { Module } from '@nestjs/common';
import { AwsSdkModule } from 'aws-sdk-v3-nest';
import { Agent } from 'https';
import { CloudController } from './cloud.controller';
import { CloudUploadController } from './cloud.upload.controller';
import { CloudDirectoryController } from './cloud.directory.controller';
import { CloudArchiveController } from './cloud.archive.controller';
import { CloudService } from './cloud.service';
import { UserSubscriptionEntity } from '@entities/user-subscription.entity';
import { TeamEntity } from '@entities/team.entity';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RedisModule } from '@modules/redis/redis.module';
import { CloudS3Service } from './cloud.s3.service';
import { CloudMetadataService } from './cloud.metadata.service';
import { CloudObjectModelService } from './cloud.object-model.service';
import { CloudListService } from './cloud.list.service';
import { CloudObjectService } from './cloud.object.service';
import { CloudArchiveService } from './cloud.archive.service';
import { ArchiveHandlerRegistry } from './archive/archive-handler.registry';
import { CloudUploadService } from './cloud.upload.service';
import { CloudDirectoryService } from './cloud.directory.service';
import { CloudUsageService } from './cloud.usage.service';
import { CloudConflictService } from './cloud.conflict.service';
import { CloudVersionService } from './cloud.version.service';
import { CloudDuplicateService } from './cloud.duplicate.service';

@Module({
  imports: [
    RedisModule,
    AwsSdkModule.register({
      client: new S3Client({
        forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
        endpoint: process.env.S3_ENDPOINT,
        region: process.env.S3_REGION,
        credentials: {
          accessKeyId: process.env.S3_PROTOCOL_ACCESS_KEY_ID,
          secretAccessKey: process.env.S3_PROTOCOL_ACCESS_KEY_SECRET,
        },
        requestHandler: {
          httpsAgent: new Agent({ keepAlive: true }),
        },
      }),
    }),
    TypeOrmModule.forFeature([UserSubscriptionEntity, TeamEntity]),
  ],
  controllers: [
    CloudController,
    CloudUploadController,
    CloudDirectoryController,
    CloudArchiveController,
  ],
  providers: [
    CloudService,
    CloudS3Service,
    CloudMetadataService,
    CloudObjectModelService,
    CloudListService,
    CloudObjectService,
    CloudArchiveService,
    ArchiveHandlerRegistry,
    CloudUploadService,
    CloudDirectoryService,
    CloudUsageService,
    CloudConflictService,
    CloudVersionService,
    CloudDuplicateService,
  ],
  exports: [
    CloudService,
    CloudS3Service,
    CloudMetadataService,
    CloudListService,
    CloudObjectService,
    CloudArchiveService,
    CloudUploadService,
    CloudDirectoryService,
    CloudUsageService,
    CloudConflictService,
    CloudVersionService,
    CloudDuplicateService,
  ],
})
export class CloudModule {}
