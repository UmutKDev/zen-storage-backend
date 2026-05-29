# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

NestJS 11 / TypeScript 5.9 backend for a cloud storage SaaS. Personal + team file storage, upload/download/archive, document management with locking, multi-method auth, subscriptions, real-time notifications. PostgreSQL (TypeORM), MongoDB (Mongoose, audit logs), Redis (BullMQ + cache), S3 + CloudFront.

Modules: `cloud`, `authentication`, `user`, `account`, `team`, `subscription`, `api`, `notification`, `document`, `health`, `mail`, `core`.

## Where Conventions Live

Before writing code, consult these — do not re-derive them:

| Concern | File |
|---|---|
| Project-wide rules: naming, response shape, auth, S3 keys, Redis keys, AsyncLocalStorage, BullMQ, Swagger, errors, TypeORM queries, headers | `.github/copilot-instructions.md` |
| File-type patterns (apply by glob) | `.github/instructions/{controller,entity,model,schema,service,test}.instructions.md` |
| Role-based perspectives | `.github/agents/{backend-developer,infrastructure-engineer,security-reviewer}.agent.md` |

If something conflicts between this file and copilot-instructions, copilot-instructions is the source of truth for conventions; this file owns architectural rationale and commands.

## Commands

```bash
# Dev / build
yarn install
yarn start:dev                # watch mode
yarn start:debug              # --debug 0.0.0.0:9229 --watch
yarn build                    # nest build

# Quality
yarn lint                     # eslint --fix
yarn format                   # prettier --write
npx tsc --noEmit              # type-check only (no script alias)

# Tests
yarn test                     # all unit tests
yarn test:watch
yarn test:cov
yarn test:e2e                 # uses test/jest-e2e.json
yarn jest path/to/file.spec.ts -t "test name"   # single test by file + name pattern

# Migrations (TypeORM datasource at src/modules/database/database.datasource.ts)
yarn migration:generate src/migrations/AddSomething   # diff vs entities, emits a new file
yarn migration:run            # builds then applies
yarn migration:revert         # rolls back last batch
```

Jest config: `jest.config.js` (unit) and `test/jest-e2e.json` (e2e). Setup files in `test/`.

## Architectural Decisions (the "why")

These are scattered across files and not obvious from the code alone. Pinned here so they don't get relitigated.

- **`CloudService` is a thin facade**, not a god service. It delegates to ~10 sub-services: `CloudListService`, `CloudObjectService`, `CloudUploadService`, `CloudDirectoryService`, `CloudArchiveService`, `CloudDuplicateService`, `CloudMetadataService`, `CloudS3Service`, `CloudUsageService`, `CloudVersionService`, `CloudScanService`. **New cloud features go into a sub-service, not the facade.** The facade exists so controllers depend on one injection point.

- **`AsyncLocalStorage` instead of NestJS `REQUEST` scope.** `REQUEST` scope creates a new provider instance per request and propagates scope to every dependency, which is expensive. Instead, request context is set via `asyncLocalStorage` (`src/common/context/context.service.ts`) and read imperatively: `asyncLocalStorage.getStore()?.get('request')`. This is also how services set `request.TotalRowCount` for the global `TransformInterceptor` to populate `Options.Count` on array responses.

- **Two Redis connections by design.** `RedisModule` exposes a cache-manager-backed `RedisService` for `Get/Set/Delete/DeleteByPattern`. BullMQ services (scan, archive, duplicate-scan) instantiate their own `IORedis` directly in `OnModuleInit` and clean up in `OnModuleDestroy` — because BullMQ requires `maxRetriesPerRequest: null`, which conflicts with cache-manager's config. Both connections hit the same Redis; they just need different client options.

- **PascalCase properties** are project-wide and deliberate. Entities, models, controllers — everything: `Id`, `Email`, `FullName`, `CreatedAt`. Never `id`, `email`, `createdAt`. This is non-standard for TypeScript but consistent across the entire codebase.

## The `ownerId` vs `userId` Rule

Any variable, parameter, BullMQ job-data field, or interpolation slot holding a value produced by `GetStorageOwnerId(User)` **must** be named `ownerId` — never `userId`.

The value may be:
- `user.Id` — personal context (no `TeamId`)
- `team/${user.TeamId}` — team context

Treating it as a user UUID silently breaks team storage: uploads land at the wrong S3 prefix, or DB lookups like `User.Id = userId` return null and silently no-op. This exact bug existed in `cloud.usage.service.ts` quota warnings (team users never received them) until `ResolveQuotaContext(ownerId)` was introduced — that method is the reference pattern for any code that needs to act on an `ownerId` and resolve back to the real recipient(s).

`GetStorageOwnerId` lives at `src/modules/cloud/cloud.context.ts`. `GetCacheOwnerId` is the parallel for Redis cache keys (returns `team:{id}` not `team/{id}` because Redis convention).

## Module Dependency Map

```
AppModule
├── AuthenticationModule    registers CombinedAuthGuard → TeamContextGuard → PoliciesGuard as APP_GUARD
├── CloudModule             imports RedisModule, owns ~10 sub-services + ArchiveHandlerRegistry
├── UserModule              imports AuthenticationModule (session management)
├── TeamModule              imports CloudModule (team storage prefix)
├── DocumentModule          imports CloudModule, RedisModule (locks/drafts/versions)
├── ApiModule               imports CloudModule, WebhookModule (API-key access to storage)
├── NotificationModule      imports RedisModule (WebSocket gateway + Mongo history)
├── SubscriptionModule      standalone
└── DatabaseModule          TypeORM root + Mongoose root
```

`NotificationService` is a thin event bus — `EmitToUser` / `EmitToUsers` / `EmitToAll` are the only methods. Domain services emit *into* it; it does not call back into them. The one cross-cutting injection is `HttpExceptionFilter` in `CoreModule` (errors → user notifications via `APP_FILTER`).

## Feature Flag Env Vars

Several subsystems are gated; setting these matters for local dev:

| Var | Default | Effect when off |
|---|---|---|
| `REDIS_ENABLED` | `true` | Disables cache + all BullMQ queues |
| `CLOUD_AV_ENABLED` | `false` | Skips ClamAV scan job after upload |
| `CLOUD_DUPLICATE_SCAN_ENABLED` | (check default) | Disables duplicate-scan queue |
| `MONGO_ENABLED` | `true` | Disables audit log writes |

Full env reference: see `.github/copilot-instructions.md` or `.env.example` if present.

## Path Aliases

`@common/*`, `@entities/*`, `@schemas/*`, `@modules/*` — defined in `tsconfig.json`. Prefer these over relative paths.
