---
name: New BullMQ Job
description: Scaffold a new BullMQ background job service following project patterns (OnModuleInit/Destroy, IORedis direct, cancel signal, notifications)
argument-hint: Job name (e.g. "ImageResize", "ReportGenerate", "FileConvert")
agent: agent
---

Create a new BullMQ background job service following the established pattern used by CloudDuplicateService and CloudArchiveService.

# Input
Job name: $input → generates `Cloud{Input}Service` or `{Module}{Input}Service`

# File to Generate

## `src/modules/{module}/cloud.{lower-name}.service.ts`

```typescript
import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { Queue, Worker, Job } from 'bullmq';
import IORedis from 'ioredis';
import { RedisService } from '@modules/redis/redis.service';
import { NotificationService } from '@modules/notification/notification.service';
import { CloudKeys } from '@modules/redis/redis.keys'; // or appropriate Keys namespace

export interface {JobName}JobData {
  jobId: string;
  userId: string;
  // Add job-specific payload fields here
}

export interface {JobName}JobStatus {
  Status: 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  Progress: number;         // 0-100
  Message?: string;
  Result?: unknown;         // populated on COMPLETED
  Error?: string;           // populated on FAILED
}

const QUEUE_NAME = '{lower-name}-job';

@Injectable()
export class {JobName}Service implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger({JobName}Service.name);
  private queue: Queue<{JobName}JobData>;
  private worker: Worker<{JobName}JobData>;
  private redis: IORedis;

  constructor(
    private readonly redisService: RedisService,
    private readonly notificationService: NotificationService,
  ) {}

  async onModuleInit() {
    if (process.env.REDIS_ENABLED !== 'true') return;

    this.redis = new IORedis({
      host: process.env.REDIS_HOST ?? 'localhost',
      port: Number(process.env.REDIS_PORT ?? 6379),
      password: process.env.REDIS_PASSWORD,
      maxRetriesPerRequest: null,
    });

    this.queue = new Queue<{JobName}JobData>(QUEUE_NAME, {
      connection: this.redis,
    });

    this.worker = new Worker<{JobName}JobData>(
      QUEUE_NAME,
      async (job) => this.ProcessJob(job),
      { connection: this.redis },
    );

    this.worker.on('failed', (job, err) => {
      this.logger.error(`Job ${job?.id} failed: ${err.message}`);
    });
  }

  async onModuleDestroy() {
    await this.worker?.close();
    await this.queue?.close();
    await this.redis?.quit();
  }

  async Enqueue(data: Omit<{JobName}JobData, 'jobId'>): Promise<string> {
    const jobId = crypto.randomUUID();
    const jobData: {JobName}JobData = { ...data, jobId };

    // Initialize status
    await this.SetStatus(jobId, { Status: 'PENDING', Progress: 0 });

    await this.queue.add('process', jobData, { jobId });
    return jobId;
  }

  async GetStatus(jobId: string): Promise<{JobName}JobStatus | null> {
    return this.redisService.Get<{JobName}JobStatus>(
      // Use appropriate Redis key — add to redis.keys.ts if needed
      `{lower-name}:status:${jobId}`,
    );
  }

  async Cancel(jobId: string, userId: string): Promise<void> {
    // Set cancel signal — worker checks this during processing
    await this.redisService.Set(
      // Use appropriate Redis key for cancel signal
      `{lower-name}:cancel:${jobId}`,
      true,
      300, // 5 min TTL — worker will pick it up
    );
    await this.SetStatus(jobId, { Status: 'CANCELLED', Progress: 0 });
    await this.notificationService.EmitToUser(userId, '{lower-name}.cancelled', { jobId });
  }

  private async ProcessJob(job: Job<{JobName}JobData>): Promise<void> {
    const { jobId, userId } = job.data;

    await this.SetStatus(jobId, { Status: 'RUNNING', Progress: 0, Message: 'Starting...' });

    try {
      // ── Check cancel before starting ────────────────────────────────────────
      if (await this.IsCancelled(jobId)) return;

      // ── Main processing logic ────────────────────────────────────────────────
      // TODO: Implement job-specific logic here
      // Periodically check IsCancelled() inside loops
      
      for (let i = 0; i < totalItems; i++) {
        if (await this.IsCancelled(jobId)) return;

        // Process item[i]
        
        const progress = Math.round(((i + 1) / totalItems) * 100);
        await this.SetStatus(jobId, { Status: 'RUNNING', Progress: progress });
      }

      // ── Store result ─────────────────────────────────────────────────────────
      const result = { /* completed result */ };
      await this.SetStatus(jobId, { Status: 'COMPLETED', Progress: 100, Result: result });

      // ── Notify user ──────────────────────────────────────────────────────────
      await this.notificationService.EmitToUser(userId, '{lower-name}.completed', {
        jobId,
        result,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      this.logger.error(`{JobName} job ${jobId} failed: ${message}`);
      
      await this.SetStatus(jobId, { Status: 'FAILED', Progress: 0, Error: message });
      await this.notificationService.EmitToUser(userId, '{lower-name}.failed', {
        jobId,
        error: message,
      });
    }
  }

  private async IsCancelled(jobId: string): Promise<boolean> {
    const signal = await this.redisService.Get(`{lower-name}:cancel:${jobId}`);
    return !!signal;
  }

  private async SetStatus(jobId: string, status: {JobName}JobStatus): Promise<void> {
    await this.redisService.Set(
      `{lower-name}:status:${jobId}`,
      status,
      3600, // 1 hour TTL for status
    );
  }
}
```

# Post-Generation Checklist

1. **Add status/cancel key builders** to the appropriate namespace in `src/modules/redis/redis.keys.ts`

2. **Register in module**:
   ```typescript
   providers: [..., {JobName}Service],
   exports: [..., {JobName}Service],
   ```

3. **Add Enqueue method call** from the controller or parent service that triggers the job

4. **Add GET status endpoint** in the controller:
   ```typescript
   @Get('{lower-name}/Status/:jobId')
   async getStatus(@Param('jobId') jobId: string, @User() user: UserContext) {
     return this.{jobName}Service.GetStatus(jobId);
   }
   ```

5. **Add Cancel endpoint** in the controller if needed

6. **Guard with REDIS_ENABLED** — the service no-ops if Redis is not enabled (`onModuleInit` early return)

7. **Frontend notification events** to document: `{lower-name}.completed`, `{lower-name}.failed`, `{lower-name}.cancelled`
