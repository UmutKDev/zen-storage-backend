---
name: Model Instructions
description: DTO and response model patterns for this project
applyTo: "**/*.model.ts"
---

# DTO / Model Conventions

## The Four Model Types

| Suffix | Usage | Derives From |
|--------|-------|-------------|
| `*ViewModel` | Full internal shape | Class with all properties |
| `*ResponseModel` | API-safe response | `OmitType(ViewModel, ['SensitiveField'])` |
| `*ListResponseModel` | Array item type | `PickType` or extends `*ResponseModel` |
| `*PostBodyRequestModel` | POST input | New class with validators |
| `*PutBodyRequestModel` | PUT input | Often `PartialType(PostBodyRequestModel)` |
| `*QueryRequestModel` | Query params | New class with optional validators |

---

## Required Decorators for Response Models

Every property in a `ViewModel`, `ResponseModel`, or `ListResponseModel` must have **all three**:

```typescript
import { ApiProperty } from '@nestjs/swagger';
import { Expose } from 'class-transformer';
import { IsString, IsUUID, IsOptional } from 'class-validator';

export class ResourceViewModel {
  @Expose()
  @ApiProperty({ example: 'uuid-here' })
  @IsUUID()
  Id: string;

  @Expose()
  @ApiProperty({ example: 'My Resource' })
  @IsString()
  Name: string;

  @Expose()
  @ApiProperty({ example: null, nullable: true })
  @IsOptional()
  @IsString()
  Description: string | null;

  @Expose()
  @ApiProperty()
  CreatedAt: Date;
}
```

Missing `@Expose()` = property excluded from `plainToInstance` output.
Missing `@ApiProperty()` = property hidden from Swagger docs.

---

## ViewModel → ResponseModel Pattern

```typescript
export class ResourceViewModel {
  @Expose() @ApiProperty() Id: string;
  @Expose() @ApiProperty() Name: string;
  @Expose() @ApiProperty() InternalFlag: boolean;   // sensitive
}

export class ResourceResponseModel extends OmitType(ResourceViewModel, [
  'InternalFlag',
] as const) {}

export class ResourceListResponseModel extends ResourceResponseModel {}
```

---

## Request Models

```typescript
export class ResourcePostBodyRequestModel {
  @ApiProperty({ example: 'My Resource' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  Name: string;

  @ApiProperty({ example: 'Optional description', required: false })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  Description?: string;
}

export class ResourceQueryRequestModel {
  @ApiProperty({ example: 0, required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  Skip?: number = 0;

  @ApiProperty({ example: 20, required: false })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  Take?: number = 20;

  @ApiProperty({ example: 'search term', required: false })
  @IsOptional()
  @IsString()
  Search?: string;
}
```

---

## CDN URL Transform

For image or URL properties that come from S3 and need CDN transformation:

```typescript
import { CDNPathResolver } from '@common/helpers/cdn.helper';
import { Transform } from 'class-transformer';

@Expose()
@ApiProperty()
@Transform(({ value }) => CDNPathResolver(value), { toClassOnly: true })
Image: string | null;

@Expose()
@ApiProperty()
@Transform(({ value }) => CDNPathResolver(value), { toClassOnly: true })
ThumbnailUrl: string | null;
```

---

## Nested Object Models

```typescript
import { Type } from 'class-transformer';
import { ValidateNested } from 'class-validator';

export class ParentRequestModel {
  @ApiProperty({ type: () => NestedModel })
  @ValidateNested()
  @Type(() => NestedModel)
  Nested: NestedModel;
}
```

For response models with nested objects:
```typescript
export class ParentResponseModel {
  @Expose()
  @ApiProperty({ type: () => ChildResponseModel })
  @Type(() => ChildResponseModel)
  Child: ChildResponseModel;
}
```

---

## Array Properties

```typescript
@Expose()
@ApiProperty({ type: [String] })
@IsArray()
@IsString({ each: true })
Tags: string[];

@Expose()
@ApiProperty({ type: [ItemResponseModel] })
@Type(() => ItemResponseModel)
Items: ItemResponseModel[];
```

---

## Enum Properties

```typescript
import { Status } from '@common/enums';

@Expose()
@ApiProperty({ enum: Status, example: Status.ACTIVE })
@IsEnum(Status)
Status: Status;
```

---

## PascalCase Rule

**All model properties are PascalCase** — same as entities:
```typescript
// ✅ Correct
Id: string;
UserId: string;
FileName: string;
StorageKey: string;
CreatedAt: Date;

// ❌ Wrong
id: string;
userId: string;
fileName: string;
storageKey: string;
createdAt: Date;
```

---

## Composition via Utility Types

Prefer composition over duplication:
```typescript
// ✅ Reuse ViewModel properties
export class UpdateRequestModel extends PartialType(
  PickType(ResourceViewModel, ['Name', 'Description'] as const)
) {}

// ✅ Omit sensitive fields
export class SafeResponseModel extends OmitType(FullViewModel, ['Password', 'SecretKey'] as const) {}
```

Always import `OmitType`, `PickType`, `PartialType` from `@nestjs/swagger` (not `@nestjs/mapped-types`).
