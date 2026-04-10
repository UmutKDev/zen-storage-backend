---
name: scaffold-module
description: Scaffold a complete NestJS feature module with entity, models, service, controller, and module file. Asks about team context, S3 storage, and BullMQ needs before generating.
user-invocable: true
---

# Scaffold Module Skill

Generates a complete, production-ready feature module following all project conventions.

## Usage

Invoke with: `/scaffold-module <ModuleName>`

Example: `/scaffold-module Report`

## Information Needed Before Generating

Before generating code, ask the user:
1. **Module name** (PascalCase, e.g. "Report", "Tag", "Invoice")
2. **Key properties** — what columns should the entity have?
3. **Team context?** — should resources be scoped to teams (using `GetStorageOwnerId`)?
4. **S3 storage?** — does this module need to store files in S3?
5. **BullMQ?** — does this module need background job processing?

## What Gets Generated

### Entity (`src/entities/{lower-name}.entity.ts`)

Full TypeORM entity with:
- `Id: string` via `@PrimaryGeneratedColumn('uuid')`
- `UserId: string` scoping to owner (+ `TeamId: string` if team context enabled)
- User-specified columns with correct TypeORM decorators
- `@Index({ fulltext: true })` on searchable text columns
- `CreatedAt`, `UpdatedAt`, `DeletedAt` (soft delete)
- `constructor(partial: Partial<EntityName>) { Object.assign(this, partial); }`

### Models (`src/modules/{lower-name}/{lower-name}.model.ts`)

Six model classes:
- `{Name}ViewModel` — all fields with `@Expose()` + `@ApiProperty()` + validators
- `{Name}ResponseModel extends OmitType({Name}ViewModel, [...])` — API-safe
- `{Name}ListResponseModel extends {Name}ResponseModel` — array item type
- `{Name}PostBodyRequestModel` — create input with validation
- `{Name}PutBodyRequestModel extends PartialType(PostBodyRequestModel)` — update input
- `{Name}QueryRequestModel` — Skip, Take, Search params

### Service (`src/modules/{lower-name}/{lower-name}.service.ts`)

Five PascalCase methods:
- `List(model, user)` — paginated with asyncLocalStorage TotalRowCount
- `Find(id, user)` — single item with ownership check
- `Create(model, user)` — save + cache invalidate
- `Update(id, model, user)` — find + update + cache invalidate
- `Delete(model, user)` — soft delete + cache invalidate

If **team context** enabled: uses `GetStorageOwnerId(user)` for scoping
If **S3 storage** enabled: adds `CloudS3Service` injection and S3 key pattern
If **BullMQ** enabled: generates `{Name}JobService` implementing `OnModuleInit/OnModuleDestroy`

### Controller (`src/modules/{lower-name}/{lower-name}.controller.ts`)

Thin controller with:
- `@ApiTags('{Name}')`, `@ApiCookieAuth()`
- `@ApiHeader({ name: 'x-team-id' })` if team context enabled
- `@CheckPolicies` at class and method level
- `@ApiOperation`, `@ApiSuccessResponse`/`@ApiSuccessArrayResponse` on each method
- `@User() user: UserContext` as last param on every method

### Module (`src/modules/{lower-name}/{lower-name}.module.ts`)

```typescript
@Module({
  imports: [TypeOrmModule.forFeature([{Name}Entity])],
  controllers: [{Name}Controller],
  providers: [{Name}Service],
  exports: [{Name}Service],
})
```

## Post-Generation Checklist (Output to User)

After generating all files, output this checklist:

```
Post-generation steps required:

1. Register entity in datasource:
   src/modules/database/database.datasource.ts
   → Add {Name}Entity to the entities array

2. Register module in app:
   src/app.module.ts
   → Add {Name}Module to imports

3. Add CASL permissions:
   src/common/enums/casl.enum.ts
   → Add {Name} = '{Name}' to CaslSubject enum
   
   src/modules/authentication/casl/casl-ability.factory.ts
   → Add can(CaslAction.Read/Create/Update/Delete, CaslSubject.{Name}) in BuildPersonalAbilities()
   → If team context: add to BuildTeamAbilities() for each TeamRole

4. Generate and run migration:
   yarn migration:generate src/migrations/{Name}Init
   yarn migration:run

5. Write unit tests:
   src/modules/{lower-name}/{lower-name}.service.spec.ts
   (Use /write-unit-test {Name}Service to generate)
```

## Key Patterns Applied

Every generated file applies these patterns:
- PascalCase all entity/model properties (never camelCase)
- `plainToInstance` always with `{ excludeExtraneousValues: true, exposeDefaultValues: true }`
- `asyncLocalStorage.getStore()?.get('request').TotalRowCount = total` for paginated arrays
- `HttpException` for all errors (never raw Error)
- `@Expose() + @ApiProperty() + validator` on every response model property
- `OmitType/PickType/PartialType` from `@nestjs/swagger` (not `@nestjs/mapped-types`)
