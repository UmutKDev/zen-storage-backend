---
name: migrate-typeorm
description: Guide for TypeORM migration workflow in this project — generate, run, revert, and troubleshoot migrations
user-invocable: true
---

# TypeORM Migration Skill

Guide for working with TypeORM migrations in this project.

## Migration Commands

```bash
# Generate migration from entity changes
yarn migration:generate src/migrations/MigrationName

# Run all pending migrations
yarn migration:run

# Revert the last migration
yarn migration:revert

# Show migration status (pending vs applied)
yarn migration:show
```

## Datasource Configuration

Migrations use the datasource at: `src/modules/database/database.datasource.ts`

This datasource is used for migration generation — it must include the entity in its `entities` array before you can generate a migration for it.

## Workflow for Adding a New Entity

1. **Create the entity** in `src/entities/{name}.entity.ts`
2. **Register in datasource** — add to entities array in `database.datasource.ts`
3. **Generate migration**:
   ```bash
   yarn migration:generate src/migrations/Add{EntityName}Table
   ```
4. **Review the generated migration** — check column types, nullable, defaults
5. **Run migration**:
   ```bash
   yarn migration:run
   ```

## Workflow for Modifying an Existing Entity

1. **Modify the entity** (add column, change type, add index, etc.)
2. **Generate migration** with a descriptive name:
   ```bash
   yarn migration:generate src/migrations/Add{Column}To{EntityName}
   ```
3. **Review the diff** in the generated migration
4. **Run migration**
5. **Revert if needed**: `yarn migration:revert`

## Important Notes

### Soft Delete Columns
If an entity has `@DeleteDateColumn() DeletedAt: Date | null`, TypeORM queries automatically exclude soft-deleted rows. To include them:
```typescript
.withDeleted()  // in createQueryBuilder
```

### Nullable Defaults
TypeORM generates different SQL for:
```typescript
@Column()           → NOT NULL (migration adds NOT NULL constraint)
@Column({ nullable: true }) → NULL allowed
```

Always check the generated migration to confirm the constraint matches your intent.

### Index Generation
`@Index({ fulltext: true })` generates `GIN` index on PostgreSQL. These are safe to add/drop without downtime on small tables, but for large tables consider whether to use a concurrent index build.

### Column Type Mapping
| TypeScript / TypeORM | PostgreSQL |
|---------------------|------------|
| `varchar` / `string` | `character varying` |
| `text` | `text` |
| `int` | `integer` |
| `bigint` | `bigint` |
| `decimal` | `numeric` |
| `boolean` | `boolean` |
| `jsonb` | `jsonb` |
| `timestamp` | `timestamp without time zone` |
| `uuid` | `uuid` |
| `enum` | `enum type` |

### Enum Migrations
When adding or modifying a PostgreSQL enum column, TypeORM generates an `ALTER TYPE` statement. Review these carefully — removing enum values can fail if existing rows use the removed value.

## Troubleshooting

### "No changes in database schema were found"
TypeORM found no difference between current entity definitions and the last migration state. Check:
- Did you save the entity file?
- Is the entity registered in `database.datasource.ts`?
- Did you mean to add to an existing entity (check the entity file)?

### Migration fails on `yarn migration:run`
1. Check the error message — usually a constraint violation or type mismatch
2. Fix the migration file if the auto-generated SQL is wrong
3. Or fix the entity and regenerate

### "Table already exists" after revert + re-run
The migration tracking table (`typeorm_migrations`) may be out of sync. Check:
```bash
# In psql/db client
SELECT * FROM typeorm_migrations ORDER BY timestamp DESC LIMIT 5;
```

### Development vs Production
- Development: `yarn migration:run` directly
- Production: migrations should run as part of deploy (CI/CD pipeline)
- Never run `synchronize: true` in production — this project uses explicit migrations
