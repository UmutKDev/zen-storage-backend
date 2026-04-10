---
name: Service Instructions
description: Patterns and rules for NestJS service files in this project
applyTo: "**/*.service.ts"
---

# Service Conventions

## Core Principle: Single Responsibility

Each service owns one concern. The `CloudService` is the only intentional facade — it delegates to specialized sub-services (`CloudListService`, `CloudObjectService`, `CloudUploadService`, etc.). For all other modules, one service per module.

---

## Method Naming

Service methods use PascalCase matching the CRUD vocabulary:

```typescript
List(model: QueryRequestModel, user: UserContext): Promise<ResponseModel[]>
Find(id: string, user: UserContext): Promise<ResponseModel>
Create(model: PostBodyRequestModel, user: UserContext): Promise<ResponseModel>
Update(id: string, model: PutBodyRequestModel, user: UserContext): Promise<ResponseModel>
Delete(model: DeleteRequestModel, idempotencyKey: string, user: UserContext): Promise<void>
```

---

## TypeORM Patterns

### Paginated List with Search
```typescript
async List(model: QueryRequestModel, user: UserContext): Promise<SomeListResponseModel[]> {
  const { skip = 0, take = 20, search } = model;

  const [items, total] = await this.repo
    .createQueryBuilder('item')
    .where('item.UserId = :userId', { userId: user.Id })
    .andWhere(search ? 'item.Name ILIKE :search' : '1=1', { search: `%${search}%` })
    .orderBy('item.CreatedAt', 'DESC')
    .skip(skip)
    .take(take)
    .getManyAndCount();

  // Set count for TransformInterceptor to populate Options.Count
  const request = asyncLocalStorage.getStore()?.get('request');
  if (request) request.TotalRowCount = total;

  return plainToInstance(SomeListResponseModel, items, {
    excludeExtraneousValues: true,
    exposeDefaultValues: true,
  });
}
```

### Find or Throw
```typescript
async Find(id: string, user: UserContext): Promise<SomeResponseModel> {
  const item = await this.repo
    .createQueryBuilder('item')
    .where('item.Id = :id AND item.UserId = :userId', { id, userId: user.Id })
    .getOne();

  if (!item) throw new HttpException('Not found', HttpStatus.NOT_FOUND);

  return plainToInstance(SomeResponseModel, item, {
    excludeExtraneousValues: true,
    exposeDefaultValues: true,
  });
}
```

### Admin Queries (include soft-deleted)
```typescript
const item = await this.repo
  .createQueryBuilder('item')
  .withDeleted()
  .where('item.Id = :id', { id })
  .getOne();
```

---

## plainToInstance Rules

Always pass both options:
```typescript
plainToInstance(TargetModel, source, {
  excludeExtraneousValues: true,   // only @Expose() properties
  exposeDefaultValues: true,        // include properties with default values
});
```

---

## Error Handling

Always use `HttpException` — never throw raw `Error`:

```typescript
throw new HttpException('Resource not found', HttpStatus.NOT_FOUND);
throw new HttpException('Permission denied', HttpStatus.FORBIDDEN);
throw new HttpException('Already exists', HttpStatus.CONFLICT);
throw new HttpException('Invalid input', HttpStatus.BAD_REQUEST);
throw new HttpException('Internal error', HttpStatus.INTERNAL_SERVER_ERROR);
```

---

## AsyncLocalStorage

Access request context without `REQUEST` scope injection:

```typescript
import { asyncLocalStorage } from '@common/context/context.service';

const request = asyncLocalStorage.getStore()?.get('request');
if (request) {
  request.TotalRowCount = total;   // for paginated array responses
}
```

---

## Redis Caching Pattern

```typescript
import { RedisService } from '@modules/redis/redis.service';
import { SomeKeys } from '@modules/redis/redis.keys';
import { SOME_CACHE_TTL } from '@modules/redis/redis.ttl';

// Read-through cache
async GetSomething(userId: string): Promise<SomeModel> {
  const cacheKey = SomeKeys.Something(userId);
  const cached = await this.redisService.Get<SomeModel>(cacheKey);
  if (cached) return cached;

  const result = await this.computeExpensiveThing(userId);
  await this.redisService.Set(cacheKey, result, SOME_CACHE_TTL);
  return result;
}

// Cache invalidation after mutations
async UpdateSomething(id: string, model: UpdateModel, user: UserContext) {
  await this.repo.update(id, { ...model });
  await this.redisService.DeleteByPattern(SomeKeys.SomePattern(user.Id));
}
```

---

## BullMQ Job Services

Long-running tasks follow `OnModuleInit` / `OnModuleDestroy` lifecycle:

```typescript
import { Injectable, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { Queue, Worker } from 'bullmq';
import IORedis from 'ioredis';

@Injectable()
export class MyJobService implements OnModuleInit, OnModuleDestroy {
  private queue: Queue<MyJobData>;
  private worker: Worker<MyJobData>;
  private redis: IORedis;

  async onModuleInit() {
    this.redis = new IORedis({
      host: process.env.REDIS_HOST,
      port: Number(process.env.REDIS_PORT),
      password: process.env.REDIS_PASSWORD,
      maxRetriesPerRequest: null,
    });
    this.queue = new Queue<MyJobData>('my-job', { connection: this.redis });
    this.worker = new Worker<MyJobData>(
      'my-job',
      async (job) => await this.ProcessJob(job),
      { connection: this.redis },
    );
  }

  async onModuleDestroy() {
    await this.worker.close();
    await this.queue.close();
    await this.redis.quit();
  }

  async Enqueue(data: MyJobData): Promise<string> {
    const job = await this.queue.add('process', data);
    return job.id;
  }

  private async ProcessJob(job: Job<MyJobData>): Promise<void> {
    const { jobId, userId } = job.data;
    // Check cancel signal
    const cancel = await this.redisService.Get(CloudKeys.SomeCancel(jobId));
    if (cancel) return;
    // ... do work
    await this.notificationService.EmitToUser(userId, 'job.complete', { jobId });
  }
}
```

- Use the **direct IORedis connection** (not cache-manager) for BullMQ Queue and Worker
- Always implement the cancel signal check inside the worker loop
- Notify users of completion/error via `NotificationService.EmitToUser`

---

## S3 Operations

```typescript
// Always use KeyBuilder + GetStorageOwnerId — never raw string concatenation
import { KeyBuilder } from '@modules/cloud/helpers/key.builder';
import { GetStorageOwnerId } from '@modules/cloud/helpers/storage-owner.helper';

const s3Key = KeyBuilder([GetStorageOwnerId(user), relativePath]);
await this.cloudS3Service.Send(new GetObjectCommand({ Bucket: ..., Key: s3Key }));
```

---

## Subscription Limit Checks

Before any upload or storage-increasing operation, check limits:

```typescript
await this.cloudUsageService.CheckStorageLimit(user, sizeInBytes);
// This throws HttpException if over quota
```

---

## Dependency Injection Style

```typescript
@Injectable()
export class MyService {
  constructor(
    @InjectRepository(MyEntity)
    private readonly repo: Repository<MyEntity>,
    private readonly redisService: RedisService,
    private readonly notificationService: NotificationService,
  ) {}
}
```

All injected dependencies are `private readonly`.
