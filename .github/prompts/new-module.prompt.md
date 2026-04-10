---
name: New Module
description: Scaffold a complete NestJS feature module with entity, models, service, controller, and module file
argument-hint: Module name (e.g. "Report", "Tag", "Invoice")
agent: agent
---

Create a complete feature module for the name provided as input. Follow all project conventions exactly.

# Input
Module name: $input

# Files to Generate

## 1. `src/entities/{lower-name}.entity.ts`

```typescript
@Entity({ name: '{ModuleName}' })
export class {ModuleName}Entity {
  @PrimaryGeneratedColumn('uuid')
  Id: string;

  @Column()
  UserId: string;

  // Add domain-specific columns here
  // All properties PascalCase

  @CreateDateColumn()
  CreatedAt: Date;

  @UpdateDateColumn()
  UpdatedAt: Date;

  @DeleteDateColumn()
  DeletedAt: Date | null;

  constructor(partial: Partial<{ModuleName}Entity>) {
    Object.assign(this, partial);
  }
}
```

## 2. `src/modules/{lower-name}/{lower-name}.model.ts`

Generate all four model types:
- `{ModuleName}ViewModel` — all exposed fields with @Expose, @ApiProperty, validators
- `{ModuleName}ResponseModel extends OmitType({ModuleName}ViewModel, [...] as const)`
- `{ModuleName}ListResponseModel extends {ModuleName}ResponseModel`
- `{ModuleName}PostBodyRequestModel` — create input with validation
- `{ModuleName}PutBodyRequestModel extends PartialType({ModuleName}PostBodyRequestModel)` — update input
- `{ModuleName}QueryRequestModel` — optional Skip, Take, Search fields

All properties are PascalCase. Every ViewModel property must have @Expose() + @ApiProperty() + validator.

## 3. `src/modules/{lower-name}/{lower-name}.service.ts`

Generate these methods with full implementations:

**List**: QueryBuilder with UserId filter, optional search via ILIKE, skip/take pagination, set `request.TotalRowCount` via asyncLocalStorage, return `plainToInstance({ModuleName}ListResponseModel, items, { excludeExtraneousValues: true, exposeDefaultValues: true })`

**Find**: QueryBuilder with Id + UserId filter, throw `HttpException('Not found', HttpStatus.NOT_FOUND)` if null

**Create**: Save new entity via `this.repo.save(new {ModuleName}Entity({ UserId: user.Id, ...model }))`, invalidate list cache, return ResponseModel

**Update**: Find entity (throw if not found or not owned), update fields, save, invalidate cache

**Delete**: Find entity (throw if not found or not owned), soft delete via `this.repo.softDelete(id)`, invalidate cache

All methods take `user: UserContext` as last argument. All errors use `HttpException`. All repo access via `createQueryBuilder`.

## 4. `src/modules/{lower-name}/{lower-name}.controller.ts`

Thin controller:
- `@ApiTags('{ModuleName}')`
- `@ApiCookieAuth()`
- `@CheckPolicies((a) => a.can(CaslAction.Read, CaslSubject.{CaslSubjectName}))`
- `@Controller({ path: '{ModuleName}', version: '1' })`
- Methods: `list`, `find`, `create`, `update`, `delete`
- Each method has `@ApiOperation`, `@ApiSuccessResponse` or `@ApiSuccessArrayResponse`
- `@User() user: UserContext` always last param

## 5. `src/modules/{lower-name}/{lower-name}.module.ts`

```typescript
@Module({
  imports: [TypeOrmModule.forFeature([{ModuleName}Entity])],
  controllers: [{ModuleName}Controller],
  providers: [{ModuleName}Service],
  exports: [{ModuleName}Service],
})
export class {ModuleName}Module {}
```

# Post-Generation Checklist

After generating files, remind the developer to:

1. **Register entity** in `src/modules/database/database.datasource.ts` entities array
2. **Register module** in `src/app.module.ts` imports
3. **Add CASL permissions** in `src/modules/authentication/casl/casl-ability.factory.ts`:
   - Add `{ModuleName}` to `CaslSubject` enum in `src/common/enums/casl.enum.ts`
   - Add `can(CaslAction.Read, CaslSubject.{ModuleName})` etc. in `BuildPersonalAbilities()`
4. **Generate TypeORM migration**: `yarn migration:generate src/migrations/{ModuleName}Init`
5. **Run migration**: `yarn migration:run`

# Conventions Reminder

- PascalCase all entity/model properties
- All service methods PascalCase
- Constructor in entity: `constructor(partial: Partial<{Entity}>) { Object.assign(this, partial); }`
- `plainToInstance` always with `{ excludeExtraneousValues: true, exposeDefaultValues: true }`
- Errors: `throw new HttpException(msg, HttpStatus.CODE)` — never raw Error
