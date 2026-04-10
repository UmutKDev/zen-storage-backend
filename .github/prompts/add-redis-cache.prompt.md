---
name: Add Redis Cache
description: Add Redis read-through caching to a service method with proper key, TTL, and cache invalidation
argument-hint: Service name and method to cache (e.g. "TeamService.GetTeamDetails")
agent: agent
---

Add Redis read-through caching to the specified service method.

# Input
Target: $input (format: "ServiceName.MethodName")

# Step 1 — Add Cache Key Builder to `redis.keys.ts`

File: `src/modules/redis/redis.keys.ts`

Add a new key function to the appropriate namespace. If no suitable namespace exists, add to the module's own namespace or create a new one:

```typescript
export namespace {Module}Keys {
  // ... existing keys ...

  /** {module}:{feature}:{paramDescription} — description of what this caches */
  export const {FeatureName} = (
    userId: string,
    // add other discriminating params as needed
    extraParam?: string,
  ) =>
    `{module}:{feature}:${userId}${extraParam ? ':' + encodeURIComponent(extraParam) : ''}`;

  /** {module}:{feature}:{userId}:* — pattern to invalidate all {feature} caches for a user */
  export const {FeatureName}Pattern = (userId: string) =>
    `{module}:{feature}:${userId}:*`;
}
```

Key naming convention: `{module}:{feature}:{scope}:{params}`

# Step 2 — Add TTL Constant to `redis.ttl.ts`

File: `src/modules/redis/redis.ttl.ts`

Add a TTL constant (in seconds):
```typescript
/** {description} */
export const {MODULE}_{FEATURE}_TTL = {seconds}; // {human-readable duration}
```

Common TTL values:
- `60` — 1 minute (frequently changing data)
- `300` — 5 minutes (semi-static data)
- `3600` — 1 hour (mostly static data)
- `86400` — 24 hours (very static reference data)

# Step 3 — Add Cache Logic to Service Method

In the target service, wrap the existing logic with cache check/set:

```typescript
import { {Module}Keys } from '@modules/redis/redis.keys';
import { {MODULE}_{FEATURE}_TTL } from '@modules/redis/redis.ttl';

// Before (no cache):
async {MethodName}(param: string, user: UserContext): Promise<SomeModel> {
  const item = await this.repo.createQueryBuilder('item')
    .where('item.Id = :id', { id: param })
    .getOne();
  return plainToInstance(SomeModel, item, { excludeExtraneousValues: true });
}

// After (with cache):
async {MethodName}(param: string, user: UserContext): Promise<SomeModel> {
  const cacheKey = {Module}Keys.{FeatureName}(user.Id, param);

  const cached = await this.redisService.Get<SomeModel>(cacheKey);
  if (cached) return cached;

  const item = await this.repo.createQueryBuilder('item')
    .where('item.Id = :id', { id: param })
    .getOne();

  if (!item) throw new HttpException('Not found', HttpStatus.NOT_FOUND);

  const result = plainToInstance(SomeModel, item, {
    excludeExtraneousValues: true,
    exposeDefaultValues: true,
  });

  await this.redisService.Set(cacheKey, result, {MODULE}_{FEATURE}_TTL);
  return result;
}
```

# Step 4 — Add Cache Invalidation to Mutation Methods

Find all methods in the same service that modify this data (Create, Update, Delete) and add invalidation:

```typescript
async Update(id: string, model: UpdateModel, user: UserContext): Promise<SomeModel> {
  // ... existing update logic ...

  // Invalidate specific key
  await this.redisService.Delete({Module}Keys.{FeatureName}(user.Id, id));

  // Or invalidate all related keys with pattern
  await this.redisService.DeleteByPattern({Module}Keys.{FeatureName}Pattern(user.Id));
  
  // ...
}
```

# Checklist

After implementing:
- [ ] Key builder added to `redis.keys.ts` in appropriate namespace
- [ ] TTL constant added to `redis.ttl.ts`
- [ ] Read method checks cache before querying DB
- [ ] Read method sets cache after DB query
- [ ] All mutation methods (Create/Update/Delete) invalidate the cache
- [ ] `RedisService` is injected in the service constructor
- [ ] Unit tests updated to verify cache miss → DB → cache set flow
- [ ] Unit tests mock `mockRedisService.Get.mockResolvedValue(null)` for cache miss tests
