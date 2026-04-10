---
name: New Cloud Service
description: Scaffold a new specialized Cloud sub-service (e.g. CloudWatermarkService, CloudThumbnailService)
argument-hint: Service name suffix (e.g. "Watermark", "Thumbnail", "Metadata")
agent: agent
---

Create a new specialized Cloud sub-service following the existing pattern (like CloudListService, CloudObjectService, CloudMetadataService).

# Input
Service name suffix: $input → generates `Cloud{Input}Service` in `src/modules/cloud/cloud.{lower-input}.service.ts`

# File to Generate

## `src/modules/cloud/cloud.{lower-input}.service.ts`

```typescript
import { Injectable, HttpException, HttpStatus } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { plainToInstance } from 'class-transformer';
import { CloudS3Service } from './cloud.s3.service';
import { RedisService } from '@modules/redis/redis.service';
import { CloudKeys } from '@modules/redis/redis.keys';
import { asyncLocalStorage } from '@common/context/context.service';
import { KeyBuilder } from './helpers/key.builder';
import { GetStorageOwnerId } from './helpers/storage-owner.helper';

@Injectable()
export class Cloud{Name}Service {
  constructor(
    private readonly cloudS3Service: CloudS3Service,
    private readonly redisService: RedisService,
    // Add other injections as needed
  ) {}

  // Service methods here
  // All methods PascalCase
  // S3 keys always: KeyBuilder([GetStorageOwnerId(user), relativePath])
  // Cache: CloudKeys namespace from redis.keys.ts
}
```

# Key Patterns to Use

## S3 Key Construction
```typescript
// ALWAYS use this pattern — never raw string concatenation
const s3Key = KeyBuilder([GetStorageOwnerId(user), relativePath]);

// GetStorageOwnerId returns:
//   user.Id          (personal context)
//   `team/${teamId}` (team context when user.TeamId is set)
```

## Redis Caching in Cloud Services
```typescript
// Use CloudKeys namespace for cloud-related cache keys
// Add new key builders to CloudKeys in redis.keys.ts if needed

const cacheKey = CloudKeys.UserCache(GetStorageOwnerId(user), 'operation-name', { param: value });
const cached = await this.redisService.Get<SomeModel>(cacheKey);
if (cached) return cached;

const result = await this.computeResult(user, ...);
await this.redisService.Set(cacheKey, result, CLOUD_CACHE_TTL);
return result;
```

## Cache Invalidation After Mutations
```typescript
// Always invalidate list cache when files/folders change
await this.redisService.DeleteByPattern(CloudKeys.ListAllPattern(GetStorageOwnerId(user)));
```

## S3 Operations via CloudS3Service
```typescript
// Never use AWS SDK directly — always go through CloudS3Service
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';

const response = await this.cloudS3Service.Send(
  new GetObjectCommand({ Bucket: process.env.S3_BUCKET, Key: s3Key }),
);
```

# Post-Generation Checklist

After creating the service file, remind the developer to:

1. **Add to CloudModule providers** in `src/modules/cloud/cloud.module.ts`:
   ```typescript
   providers: [..., Cloud{Name}Service],
   exports: [..., Cloud{Name}Service],
   ```

2. **Inject into CloudService facade** in `src/modules/cloud/cloud.service.ts` if the main service should delegate to it:
   ```typescript
   constructor(
     // ...existing injections
     private readonly cloud{Name}Service: Cloud{Name}Service,
   ) {}
   ```

3. **Add Swagger models** for any new request/response types in a `.model.ts` file following project conventions

4. **Write unit tests** at `src/modules/cloud/cloud.{lower-name}.service.spec.ts` following the mock patterns in the test instructions
