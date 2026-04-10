---
name: Controller Instructions
description: Patterns and rules for NestJS controller files in this project
applyTo: "**/*.controller.ts"
---

# Controller Conventions

## Core Principle: Thin Controllers

Controllers contain **zero business logic**. They:
1. Receive the request (via `@Body()`, `@Query()`, `@Param()`)
2. Call exactly one service method
3. Return the result

All logic lives in the service layer.

---

## Required Decorator Order (Class Level)

```typescript
@ApiTags('ModuleName')
@ApiCookieAuth()
@ApiHeader({ name: 'x-team-id', required: false, description: 'Team context switch' })  // if team-aware
@CheckPolicies((ability) => ability.can(CaslAction.Read, CaslSubject.SomeSubject))
@Controller({ path: 'ResourceName', version: '1' })
export class ResourceController {
```

Import `CaslAction` and `CaslSubject` from `@common/enums`, `CheckPolicies` from the CASL module.

---

## Method Patterns

### GET / Query endpoints
```typescript
@Get()
@ApiOperation({ summary: 'List resources' })
@ApiSuccessArrayResponse(ResourceListResponseModel)
async list(
  @Query() model: ResourceQueryRequestModel,
  @User() user: UserContext,
): Promise<ResourceListResponseModel[]> {
  return this.resourceService.List(model, user);
}
```

### POST endpoints
```typescript
@Post()
@ApiOperation({ summary: 'Create resource' })
@ApiSuccessResponse(ResourceResponseModel)
@CheckPolicies((ability) => ability.can(CaslAction.Create, CaslSubject.SomeSubject))
async create(
  @Body() model: ResourcePostBodyRequestModel,
  @User() user: UserContext,
): Promise<ResourceResponseModel> {
  return this.resourceService.Create(model, user);
}
```

### PUT endpoints
```typescript
@Put(':id')
@ApiOperation({ summary: 'Update resource' })
@ApiSuccessResponse(ResourceResponseModel)
@CheckPolicies((ability) => ability.can(CaslAction.Update, CaslSubject.SomeSubject))
async update(
  @Param('id') id: string,
  @Body() model: ResourcePutBodyRequestModel,
  @User() user: UserContext,
): Promise<ResourceResponseModel> {
  return this.resourceService.Update(id, model, user);
}
```

### DELETE endpoints with idempotency
```typescript
@Delete()
@HttpCode(HttpStatus.OK)
@ApiOperation({ summary: 'Delete resources' })
@ApiSuccessResponse(DeleteResponseModel)
@CheckPolicies((ability) => ability.can(CaslAction.Delete, CaslSubject.SomeSubject))
async delete(
  @Body() model: DeleteRequestModel,
  @Header('idempotency-key') idempotencyKey: string,
  @User() user: UserContext,
): Promise<DeleteResponseModel> {
  return this.resourceService.Delete(model, idempotencyKey, user);
}
```

### Streaming / Download endpoints
```typescript
@Get('Download/:id')
@ApiOperation({ summary: 'Download file' })
@CheckPolicies((ability) => ability.can(CaslAction.Download, CaslSubject.Cloud))
async download(
  @Param('id') id: string,
  @User() user: UserContext,
  @Res() res: Response,
): Promise<void> {
  await this.cloudService.Download(id, user, res);
  // Note: @Res() bypasses TransformInterceptor — service streams directly to res
}
```

---

## Parameter Decorator Rules

- `@User() user: UserContext` always comes **after** the request model parameter
- `@User()` is from `@common/decorators/user.decorator`
- Never access `req.user` directly — always use `@User()`

---

## Rate Limiting

Apply `@Throttle` on upload and other resource-intensive endpoints:

```typescript
@Throttle({ default: { limit: 10, ttl: 60000 } })
@Post('Upload')
```

---

## Method-Level Policy Override

Method-level `@CheckPolicies` overrides the class-level policy for that specific method:

```typescript
@CheckPolicies((a) => a.can(CaslAction.Read, CaslSubject.Cloud))   // class level
export class CloudController {

  @CheckPolicies((a) => a.can(CaslAction.Delete, CaslSubject.Cloud))  // overrides for this method
  @Delete()
  async delete(...) {}
}
```

---

## Anti-Patterns to Avoid

```typescript
// ❌ Business logic in controller
async create(@Body() dto: CreateDto, @User() user: UserContext) {
  const existing = await this.repo.findOne({ where: { Name: dto.Name } });
  if (existing) throw new HttpException('Exists', 400);
  // ... more logic
}

// ✅ Delegate immediately
async create(@Body() dto: CreateDto, @User() user: UserContext) {
  return this.service.Create(dto, user);
}

// ❌ Inject repository in controller
constructor(
  @InjectRepository(SomeEntity) private repo: Repository<SomeEntity>,
) {}

// ✅ Only inject the feature service
constructor(private readonly someService: SomeService) {}
```
