---
name: Schema Instructions
description: Mongoose schema patterns for MongoDB collections in this project
applyTo: "src/schemas/**/*.schema.ts"
---

# Mongoose Schema Conventions

MongoDB is used for audit logs, API usage metrics, and notification history — non-critical data that doesn't need strong relational guarantees.

---

## Required Structure

```typescript
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

export type AuditLogDocument = HydratedDocument<AuditLog>;

@Schema({
  collection: 'AuditLog',
  timestamps: { createdAt: 'CreatedAt', updatedAt: false },
  versionKey: false,
})
export class AuditLog {
  @Prop({ required: true })
  UserId: string;

  @Prop({ required: true })
  Action: string;

  @Prop({ type: Object })
  Metadata: Record<string, unknown>;

  CreatedAt: Date;  // populated by timestamps option
}

export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);
```

---

## Schema Decorator Options

Always use these settings:
```typescript
@Schema({
  collection: 'CollectionName',          // PascalCase, singular
  timestamps: { createdAt: 'CreatedAt', updatedAt: false },  // PascalCase timestamp
  versionKey: false,                      // disable __v field
})
```

---

## Naming Rules

All properties are **PascalCase** — consistent with TypeORM entities:
```typescript
UserId: string;     ✅
CreatedAt: Date;    ✅
userId: string;     ❌
createdAt: Date;    ❌
```

---

## Required Exports

Every schema file must export three things:
```typescript
// 1. Document type alias
export type MyCollectionDocument = HydratedDocument<MyCollection>;

// 2. Class (used by SchemaFactory)
export class MyCollection { ... }

// 3. Schema (registered in module)
export const MyCollectionSchema = SchemaFactory.createForClass(MyCollection);
```

---

## Prop Decorator Options

```typescript
// Required string
@Prop({ required: true })
UserId: string;

// Optional with default
@Prop({ default: 0 })
Count: number;

// Nullable
@Prop({ default: null })
TeamId: string | null;

// Enum
@Prop({ enum: ['create', 'update', 'delete'], required: true })
Action: string;

// Nested object
@Prop({ type: Object })
Metadata: Record<string, unknown>;

// Array of strings
@Prop({ type: [String], default: [] })
Tags: string[];
```

---

## Indexes

Add after schema creation:

```typescript
export const AuditLogSchema = SchemaFactory.createForClass(AuditLog);

// Single field index
AuditLogSchema.index({ UserId: 1 });

// Compound index for common query patterns
AuditLogSchema.index({ UserId: 1, CreatedAt: -1 });

// TTL index for auto-expiry
AuditLogSchema.index({ CreatedAt: 1 }, { expireAfterSeconds: 2592000 }); // 30 days
```

---

## Module Registration

Schemas are registered in their feature module:
```typescript
@Module({
  imports: [
    MongooseModule.forFeature([
      { name: AuditLog.name, schema: AuditLogSchema },
    ]),
  ],
  providers: [AuditLogService],
  exports: [AuditLogService],
})
export class AuditLogModule {}
```

Inject in service:
```typescript
constructor(
  @InjectModel(AuditLog.name) private readonly model: Model<AuditLogDocument>,
) {}
```

---

## Query Patterns

```typescript
// Create
await this.model.create({ UserId: id, Action: 'upload', Metadata: { ... } });

// Find recent with limit
await this.model
  .find({ UserId: id })
  .sort({ CreatedAt: -1 })
  .limit(50)
  .lean()
  .exec();

// Count
await this.model.countDocuments({ UserId: id });
```

Use `.lean()` for read-only queries to avoid Mongoose document overhead.
