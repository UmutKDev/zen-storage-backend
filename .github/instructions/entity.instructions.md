---
name: Entity Instructions
description: TypeORM entity patterns for this project
applyTo: "src/entities/**/*.entity.ts"
---

# TypeORM Entity Conventions

## Required Structure

Every entity follows this skeleton:

```typescript
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ name: 'ResourceName' })
export class ResourceEntity {
  @PrimaryGeneratedColumn('uuid')
  Id: string;

  @Column()
  UserId: string;

  @Index({ fulltext: true })
  @Column()
  Name: string;

  @Column({ nullable: true })
  Description: string | null;

  @CreateDateColumn()
  CreatedAt: Date;

  @UpdateDateColumn()
  UpdatedAt: Date;

  @DeleteDateColumn()
  DeletedAt: Date | null;

  constructor(partial: Partial<ResourceEntity>) {
    Object.assign(this, partial);
  }
}
```

---

## Naming Rules

- **All properties**: PascalCase — `Id`, `UserId`, `FileName`, `StorageKey`, `CreatedAt`
- **Entity name**: matches the class name minus the `Entity` suffix — `@Entity({ name: 'User' })`
- **Table name convention**: PascalCase singular (`User`, `CloudObject`, `TeamMember`)

---

## Primary Key

Always UUID:
```typescript
@PrimaryGeneratedColumn('uuid')
Id: string;
```

---

## Audit Columns (Required)

All entities must have these three:
```typescript
@CreateDateColumn()
CreatedAt: Date;

@UpdateDateColumn()
UpdatedAt: Date;

@DeleteDateColumn()
DeletedAt: Date | null;
```

`DeletedAt` enables soft-delete via TypeORM's `softDelete()` / `restore()` methods. TypeORM's `find*` methods automatically exclude soft-deleted rows unless `.withDeleted()` is used in a query builder.

---

## Sensitive Column Protection

Columns containing secrets must use `select: false`:
```typescript
@Column({ select: false })
Password: string;

@Column({ select: false })
SecretKey: string;
```

These columns are excluded from all `SELECT *` queries and must be explicitly selected when needed:
```typescript
.addSelect('user.Password')
```

---

## Indexing

```typescript
// Full-text search on string columns users might search by
@Index({ fulltext: true })
@Column()
Name: string;

// Regular index for foreign keys and frequently filtered columns
@Index()
@Column()
UserId: string;

// Composite index
@Index(['UserId', 'Status'])
@Entity()
export class SomeEntity { ... }
```

---

## Relationships

Relationships are NOT eagerly loaded. Always use explicit `leftJoinAndSelect` in query builders:

```typescript
// OneToOne (e.g., User → Subscription)
@OneToOne(() => SubscriptionEntity, (sub) => sub.User)
@JoinColumn({ name: 'SubscriptionId' })
Subscription: SubscriptionEntity;

// OneToMany / ManyToOne
@ManyToOne(() => TeamEntity, (team) => team.Members)
@JoinColumn({ name: 'TeamId' })
Team: TeamEntity;

@OneToMany(() => TeamMemberEntity, (member) => member.Team)
Members: TeamMemberEntity[];
```

Loading in query builder:
```typescript
.leftJoinAndSelect('user.Subscription', 'subscription')
```

---

## Nullable vs Non-Nullable

```typescript
@Column()
RequiredField: string;           // NOT NULL

@Column({ nullable: true })
OptionalField: string | null;    // NULL allowed
```

---

## JSON Columns

```typescript
@Column({ type: 'jsonb', nullable: true })
Metadata: Record<string, unknown> | null;
```

---

## Enum Columns

```typescript
import { Status } from '@common/enums';

@Column({ type: 'enum', enum: Status, default: Status.ACTIVE })
Status: Status;
```

---

## Constructor Requirement

Every entity MUST have this constructor:
```typescript
constructor(partial: Partial<ResourceEntity>) {
  Object.assign(this, partial);
}
```

This enables `new ResourceEntity({ UserId: id, Name: 'file.txt' })` patterns throughout the codebase.

---

## Anti-Patterns

```typescript
// ❌ camelCase properties
id: string;
userId: string;
createdAt: Date;

// ✅ PascalCase always
Id: string;
UserId: string;
CreatedAt: Date;

// ❌ No constructor
export class BadEntity { ... }  // cannot use partial initialization

// ❌ Eager loading
@OneToMany(() => ChildEntity, (c) => c.Parent, { eager: true })
Children: ChildEntity[];

// ✅ Lazy loading via query builder
```
