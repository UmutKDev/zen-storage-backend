# Copilot Instructions — nestjs-storage

## What This Repo Is

A cloud storage SaaS backend built with NestJS 11 and TypeScript 5.9. It provides multi-tenant file storage (personal + team), upload/download/archive operations, document management, multi-method authentication, subscription management, and real-time notifications.

**Modules**: `cloud`, `authentication`, `user`, `account`, `team`, `subscription`, `api`, `notification`, `document`, `health`, `mail`

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Framework | NestJS 11, TypeScript 5.9, Node ≥ 22 |
| Primary DB | PostgreSQL via TypeORM 0.3 |
| Log/Audit DB | MongoDB via Mongoose 9 |
| Cache/Queue | Redis via ioredis + BullMQ |
| Storage | AWS S3 SDK v3 + CloudFront CDN |
| Auth | Argon2, SimpleWebAuthn, CASL, otplib |
| API Docs | Swagger/OpenAPI + Scalar |
| Validation | class-validator + class-transformer |
| Error Tracking | Sentry |

---

## Naming Rules — CRITICAL

### Properties and Fields
- **Entity properties**: PascalCase — `Id`, `Email`, `FullName`, `CreatedAt` ✅
- **Model properties**: PascalCase — `UserId`, `FileName`, `StorageKey` ✅
- `id`, `email`, `fullName` in entities or models is **wrong** ❌

### Classes
- Entities: `UserEntity`, `CloudObjectEntity`
- Models: `UserViewModel`, `UserResponseModel`, `UserListResponseModel`, `UserPostBodyRequestModel`
- Services: `UserService`, `CloudListService`
- Controllers: `UserController`, `CloudDirectoryController`

### Methods
- Service methods: PascalCase — `List`, `Find`, `Create`, `Update`, `Delete`, `Move`
- Controller methods: camelCase — `list`, `find`, `create`, `update`, `delete`

### DTO Suffix Vocabulary
| Suffix | Purpose |
|--------|---------|
| `*ViewModel` | Full shape of the resource, internal use |
| `*ResponseModel` | API-safe subset (OmitType of ViewModel) |
| `*ListResponseModel` | Item type for array responses |
| `*PostBodyRequestModel` | POST body input validation |
| `*PutBodyRequestModel` | PUT body input validation |
| `*QueryRequestModel` | Query params input validation |

---

## Response Shape

`TransformInterceptor` wraps **every non-streaming response** automatically:

```typescript
// Single object response
{ Result: T, Status: { Messages: string[], Code: number, Timestamp: string, Path: string } }

// Array response (when service returns an array)
{ Result: { Items: T[], Options: { Skip, Take, Count, Search } }, Status: { ... } }
```

**Rules:**
- Never manually construct `{ Result, Status }` in services or controllers — the interceptor does it
- When returning an array, set `request.TotalRowCount` before returning so the interceptor populates `Options.Count`
- Streaming endpoints (file downloads) must bypass the interceptor with `@Res({ passthrough: false })`

---

## Authentication & Authorization

### Guard Chain (registered globally as APP_GUARD in AuthenticationModule)
1. `CombinedAuthGuard` — validates session cookie/header OR `x-api-key`/`x-api-secret` headers
2. `TeamContextGuard` — reads `x-team-id` header, validates team membership, populates `user.TeamId` / `user.TeamRole`
3. `PoliciesGuard` — evaluates `@CheckPolicies` metadata using CASL

### Decorators
```typescript
@Public()                          // Skip auth entirely
@CheckPolicies((a) => a.can(CaslAction.Read, CaslSubject.Cloud))  // Require permission
@User() user: UserContext          // Extract user from request (param decorator)
```

### UserContext Shape
```typescript
interface UserContext {
  Id: string;
  Email: string;
  FullName: string;
  Role: Role;
  Status: Status;
  Image?: string;
  TeamId?: string;
  TeamRole?: TeamRole;
}
```

### CaslAction Values
`Manage | Create | Read | Update | Delete | Upload | Download | Extract | Archive | Execute`

### CaslSubject Values
**Personal**: `All | User | Subscription | MySubscription | Cloud | CloudDirectory | CloudUpload | CloudArchive | Account | Session | Passkey | TwoFactor | ApiKey | Definition | Team | Webhook | Document`

**Team**: `TeamMember | TeamInvitation | TeamCloud | TeamCloudDirectory | TeamCloudUpload | TeamCloudArchive | TeamDocument`

---

## S3 Storage Key Conventions

```typescript
// Always build keys like this:
const key = KeyBuilder([GetStorageOwnerId(user), relativePath]);

// GetStorageOwnerId returns:
// - user.Id            (personal context, no TeamId)
// - `team/${teamId}`   (team context, user.TeamId is set)

// Never construct raw S3 keys — always use KeyBuilder
```

---

## Redis Key Namespaces

All key builder functions live in `src/modules/redis/redis.keys.ts`. Use these namespaces — never hardcode key strings:

| Namespace | Usage |
|-----------|-------|
| `SessionKeys` | User sessions |
| `ApiKeyKeys` | API key entity cache + rate limits |
| `AuthKeys` | 2FA enabled, passkey flags |
| `CloudKeys` | Listing cache, AV scan, idempotency, duplicate scan, encrypted/hidden folders |
| `TeamKeys` | Membership, team details, invitations |
| `SubscriptionKeys` | Subscription plan cache |
| `DocumentKeys` | Draft, lock, save-throttle |
| `ApiUsageKeys` | Monthly/daily counters |
| `WebhookKeys` | User webhooks |

```typescript
// Cache invalidation example
await this.redisService.DeleteByPattern(CloudKeys.ListAllPattern(userId));
```

---

## AsyncLocalStorage Pattern

Request context is available in services via `asyncLocalStorage` — never inject `REQUEST` scope:

```typescript
import { asyncLocalStorage } from '@common/context/context.service';

// In service methods:
const request = asyncLocalStorage.getStore()?.get('request');
request.TotalRowCount = totalCount;   // Set before returning array
```

---

## BullMQ Background Jobs

Long-running jobs (AV scan, archive extract/create, duplicate scan) follow this pattern:

```typescript
@Injectable()
export class MyJobService implements OnModuleInit, OnModuleDestroy {
  private queue: Queue;
  private worker: Worker;
  private redis: IORedis;

  async onModuleInit() {
    this.redis = new IORedis({ host: ..., port: ..., password: ... });
    this.queue = new Queue('my-job', { connection: this.redis });
    this.worker = new Worker('my-job', async (job) => { ... }, { connection: this.redis });
  }

  async onModuleDestroy() {
    await this.worker.close();
    await this.queue.close();
    await this.redis.quit();
  }
}
```

- Use `IORedis` direct connection (NOT the cache-manager Redis) for queues
- Check cancel signal: `await this.redisService.Get(CloudKeys.SomeCancel(jobId))`
- Emit progress/completion via `NotificationService.EmitToUser(userId, event, data)`

---

## Module Structure

```typescript
@Module({
  imports: [TypeOrmModule.forFeature([SomeEntity]), RedisModule],
  controllers: [SomeController],
  providers: [SomeService],
  exports: [SomeService],   // required if used by other modules
})
export class SomeModule {}
```

- Barrel `index.ts` exports for `@common/*` path aliases
- Path aliases: `@common/*`, `@entities/*`, `@schemas/*`

---

## Swagger Documentation

Every controller class must have:
```typescript
@ApiTags('ModuleName')
@ApiCookieAuth()
```

Every method must have:
```typescript
@ApiOperation({ summary: 'Brief description' })
@ApiSuccessResponse(SomeResponseModel)        // single object
@ApiSuccessArrayResponse(SomeListResponseModel) // array
```

Use `@ApiHeader({ name: 'x-team-id', required: false })` at class level when the endpoint supports team context.

---

## Error Handling

```typescript
// Always use HttpException — never throw raw Error
throw new HttpException('Message', HttpStatus.NOT_FOUND);
throw new HttpException('Message', HttpStatus.FORBIDDEN);
throw new HttpException('Message', HttpStatus.BAD_REQUEST);
throw new HttpException('Message', HttpStatus.CONFLICT);
```

Global `HttpExceptionFilter` handles formatting. Sentry captures 5xx in production.

---

## TypeORM Query Patterns

```typescript
// Paginated list with search
const [items, total] = await this.repo.createQueryBuilder('obj')
  .where('obj.UserId = :userId', { userId: user.Id })
  .andWhere(search ? 'obj.Name ILIKE :search' : '1=1', { search: `%${search}%` })
  .skip(skip)
  .take(take)
  .getManyAndCount();

// Set count for interceptor
const request = asyncLocalStorage.getStore()?.get('request');
if (request) request.TotalRowCount = total;

return plainToInstance(SomeListResponseModel, items, {
  excludeExtraneousValues: true,
  exposeDefaultValues: true,
});
```

- Always use `createQueryBuilder` for filtered/paginated queries
- Use `.withDeleted()` for admin queries that should include soft-deleted rows
- Relations are NOT eager — use explicit `leftJoinAndSelect` in query builders

---

## Special Headers

| Header | Constant | Purpose |
|--------|----------|---------|
| `x-api-key` | — | API key public key |
| `x-api-secret` | — | API key secret |
| `x-team-id` | `TEAM_ID_HEADER` | Switch to team storage context |
| `x-folder-session` | `FOLDER_SESSION_HEADER` | Encrypted folder access token |
| `x-hidden-session` | `HIDDEN_SESSION_HEADER` | Hidden folder access token |
| `idempotency-key` | — | Dedup key for move/delete operations |
