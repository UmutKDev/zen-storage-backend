# nestjs-storage — Claude Code Context

## What This Project Is

A cloud storage SaaS backend built with NestJS 11 and TypeScript 5.9. It provides personal and team-based file storage, upload/download/archive operations, file versioning, duplicate detection, document management with locking, multi-method authentication, subscription management, and real-time notifications via WebSocket.

**Tech stack**: NestJS 11, TypeScript 5.9, Node ≥ 22, PostgreSQL (TypeORM), MongoDB (Mongoose, audit logs), Redis (BullMQ queues, cache), AWS S3 + CloudFront CDN, CASL authorization, Argon2, SimpleWebAuthn.

**Modules**: `cloud`, `authentication`, `user`, `account`, `team`, `subscription`, `api`, `notification`, `document`, `health`, `mail`

---

## Critical Architectural Decisions

### Why `asyncLocalStorage` instead of `REQUEST` scope
NestJS `REQUEST`-scoped providers create a new provider instance per request and propagate that scope to all dependencies, causing significant performance overhead. Instead, this project uses Node's `AsyncLocalStorage` to pass request context imperatively:

```typescript
import { asyncLocalStorage } from '@common/context/context.service';
const request = asyncLocalStorage.getStore()?.get('request');
```

This gives services access to the request object without scope propagation. It's also used to set `request.TotalRowCount` for pagination — the global `TransformInterceptor` reads this value when wrapping array responses.

### Why `CloudService` is a Facade
The cloud module handles ~15 distinct concerns (listing, uploading, downloading, archiving, versioning, duplicate detection, metadata, S3 operations, etc.). Rather than one monolithic service, each concern has its own service class. `CloudService` is the facade that the controller talks to — it delegates to `CloudListService`, `CloudObjectService`, `CloudUploadService`, `CloudDirectoryService`, `CloudArchiveService`, `CloudMetadataService`, `CloudS3Service`, `CloudUsageService`, `CloudVersionService`, `CloudDuplicateService`.

### Why BullMQ Uses Direct IORedis
NestJS BullMQ integrations (like `@nestjs/bullmq`) add abstraction overhead and complexity. Background job services in this project instantiate `IORedis` and BullMQ `Queue`/`Worker` directly in `OnModuleInit`, cleaning up in `OnModuleDestroy`. This gives full control over the connection lifecycle and avoids module coupling.

### Why Two Redis Connections
1. **`cache-manager` connection** (via `RedisModule`): Used for `RedisService.Get/Set/Delete/DeleteByPattern` — standard read/write cache operations
2. **Direct `IORedis` connections**: Created per BullMQ service for queue workers, because BullMQ requires `maxRetriesPerRequest: null` which conflicts with cache-manager's configuration

---

## Naming Conventions — Strict Rules

All entity and model properties use **PascalCase** — this is non-standard for TypeScript but is a deliberate project-wide convention:

```typescript
// ✅ Correct — PascalCase properties
export class UserEntity {
  Id: string;
  Email: string;
  FullName: string;
  CreatedAt: Date;
}

// ❌ Wrong — camelCase is NOT used here
export class UserEntity {
  id: string;
  email: string;
  fullName: string;
  createdAt: Date;
}
```

**DTO suffix vocabulary**: `*ViewModel`, `*ResponseModel`, `*ListResponseModel`, `*PostBodyRequestModel`, `*PutBodyRequestModel`, `*QueryRequestModel`

**Service methods**: PascalCase (`List`, `Find`, `Create`, `Update`, `Delete`, `Move`)

---

## Common Development Tasks

### Adding a New API Endpoint

1. Add a method to the service with PascalCase name, TypeORM `createQueryBuilder`, `plainToInstance` with `{ excludeExtraneousValues: true, exposeDefaultValues: true }`
2. Add a thin controller method that calls the service
3. Add `@ApiOperation`, `@ApiSuccessResponse(Model)` to the controller method
4. Add `@CheckPolicies((a) => a.can(CaslAction.X, CaslSubject.Y))` if not using class-level policy
5. The `TransformInterceptor` wraps the response automatically — don't manually wrap

### Adding a New Entity

1. Create `src/entities/{name}.entity.ts` with PascalCase properties, uuid PK, soft delete columns, partial constructor
2. Register in `src/modules/database/database.datasource.ts` entities array
3. Run `yarn migration:generate src/migrations/Add{Name}Table`
4. Review migration, then `yarn migration:run`

### Adding a New Module

Use `/new-module` or `/scaffold-module` Copilot commands, or follow this order:
entity → models → service → controller → module → register in AppModule → add CASL permissions → generate migration

### Adding a BullMQ Background Job

1. Create service implementing `OnModuleInit, OnModuleDestroy`
2. Initialize `IORedis` (direct, not cache-manager), `Queue`, `Worker` in `onModuleInit`
3. Check `REDIS_ENABLED` env var — no-op if not set
4. Add status/cancel Redis key builders to `redis.keys.ts`
5. Check cancel signal inside the job loop via `redisService.Get(cancelKey)`
6. Emit notifications via `NotificationService.EmitToUser` on completion/failure

### Adding a Redis Cache Key

1. Add key builder function to appropriate namespace in `src/modules/redis/redis.keys.ts`
2. Add TTL constant (seconds) to `src/modules/redis/redis.ttl.ts`
3. Implement read-through pattern: `Get → miss → compute → Set`
4. Add `DeleteByPattern` invalidation to all mutation methods

---

## Auth & Permissions

Three global guards run on every request (registered in `AuthenticationModule`):
1. `CombinedAuthGuard` — validates session or API key
2. `TeamContextGuard` — switches user to team context if `x-team-id` header present
3. `PoliciesGuard` — enforces `@CheckPolicies` CASL metadata

**CaslAction enum**: `Manage, Create, Read, Update, Delete, Upload, Download, Extract, Archive, Execute`

**CaslSubject enum** (personal): `All, User, Subscription, MySubscription, Cloud, CloudDirectory, CloudUpload, CloudArchive, Account, Session, Passkey, TwoFactor, ApiKey, Definition, Team, Webhook, Document`

**CaslSubject enum** (team): `TeamMember, TeamInvitation, TeamCloud, TeamCloudDirectory, TeamCloudUpload, TeamCloudArchive, TeamDocument`

```typescript
// Public route
@Public()

// Require permission
@CheckPolicies((ability) => ability.can(CaslAction.Read, CaslSubject.Cloud))

// Extract user
@User() user: UserContext
// UserContext: { Id, Email, FullName, Role, Status, Image?, TeamId?, TeamRole? }
```

---

## Response Shape

`TransformInterceptor` (registered globally in `main.ts`) wraps all non-streaming responses:

```typescript
// Single object
{ Result: T, Status: { Messages: ['OK'], Code: 200, Timestamp: '...', Path: '...' } }

// Array (when service returns T[])
{ Result: { Items: T[], Options: { Skip, Take, Count, Search } }, Status: { ... } }
```

For array responses, set `Count` via asyncLocalStorage:
```typescript
const request = asyncLocalStorage.getStore()?.get('request');
if (request) request.TotalRowCount = total;
return plainToInstance(SomeListResponseModel, items, ...);
```

---

## S3 Storage Keys

```typescript
// ALWAYS use this — never raw string concatenation
import { KeyBuilder } from './helpers/key.builder';
import { GetStorageOwnerId } from './helpers/storage-owner.helper';

const s3Key = KeyBuilder([GetStorageOwnerId(user), relativePath]);
// Personal: userId/path/to/file.ext
// Team:     team/teamId/path/to/file.ext
```

---

## Running Tests

```bash
yarn test           # unit tests (Jest)
yarn test:watch     # watch mode
yarn test:e2e       # end-to-end (Supertest)
yarn test:cov       # coverage report
```

Unit test mock pattern (matches existing `*.spec.ts` files):
```typescript
const mockService = {
  List: jest.fn(),
  Find: jest.fn(),
  // ...all methods
};
{ provide: SomeService, useValue: mockService }
```

---

## Module Dependency Map

```
AppModule
├── AuthenticationModule    → registers CombinedAuthGuard, TeamContextGuard, PoliciesGuard as APP_GUARD
├── CloudModule             → imports RedisModule, depends on CloudS3Service, CloudUsageService
├── UserModule              → imports AuthenticationModule (for session management)
├── TeamModule              → imports CloudModule (for team storage)
├── SubscriptionModule      → standalone
├── ApiModule               → imports CloudModule, WebhookModule
├── DocumentModule          → imports CloudModule, RedisModule
├── NotificationModule      → imports RedisModule
└── DatabaseModule          → TypeORM root configuration
```

---

## Environment Variables Reference

```bash
# App
NODE_ENV=development|production
PORT=8080
PAYLOAD_LIMIT=100mb

# Database
DATABASE_URL=postgresql://user:pass@localhost:5432/db

# Redis
REDIS_ENABLED=true
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# MongoDB (audit logs)
MONGO_ENABLED=true
MONGO_URL=mongodb://localhost:27017/storage

# S3 / CloudFront
S3_ENDPOINT=
S3_REGION=us-east-1
S3_BUCKET=
S3_ACCESS_KEY_ID=
S3_SECRET_ACCESS_KEY=
S3_PUBLIC_ENDPOINT=           # CloudFront CDN URL
S3_FORCE_PATH_STYLE=false     # true for MinIO
S3_PROTOCOL_SIGNED_URL_PROCESSING=true

# Auth
SESSION_SECRET=
SESSION_TTL_SECONDS=604800
CORS_ORIGINS_DEV=http://localhost:3000

# Feature Flags
CLOUD_AV_ENABLED=false         # Antivirus scanning
CLOUD_AV_URL=http://clamav:3310
CLOUD_AV_MAX_BYTES=104857600   # 100MB

# Monitoring
SENTRY_DSN=
SWAGGER_USERNAME=admin
SWAGGER_PASSWORD=
```
