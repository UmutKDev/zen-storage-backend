---
description: Generate a TypeORM migration file from entity diff; never runs the migration
argument-hint: <PascalCaseDescription>  e.g. AddTeamInvitationTtl
allowed-tools: Bash(yarn migration:generate:*), Read, Glob, Bash(ls:*)
---

Generate a TypeORM migration named `$ARGUMENTS`.

## Pre-flight

1. If `$ARGUMENTS` is empty, ask the user for a PascalCase description (e.g. `AddTeamInvitationTtl`, `BackfillUserStorageQuota`). Do not proceed without it.
2. Sanity-check the description is PascalCase (starts with uppercase, no spaces or underscores). If not, suggest a corrected form and ask for confirmation.

## Generate

Run:

```
yarn migration:generate src/migrations/$ARGUMENTS
```

This builds the project first (via the `migration:generate` script in `package.json`), then diffs entities against the configured data source.

## Review (mandatory)

1. Identify the newest file under `src/migrations/`:
   ```
   ls -t src/migrations/*.ts | head -1
   ```
2. Read the generated file. Walk through the review checklist from `.github/skills/migrate-typeorm/SKILL.md`:
   - `up` and `down` are symmetric (every `up` op has a matching `down` rollback)
   - No `DROP COLUMN` or `RENAME COLUMN` on a column with production data without an explicit data-migration step
   - No silent `NOT NULL` additions on existing columns without a default or backfill
   - Index/constraint names are stable (not random hashes that would re-create on every diff)
   - Enum changes use `ALTER TYPE ... ADD VALUE` (Postgres) not full-table rewrites
3. If anything looks off, flag it and suggest an edit before the user runs the migration.

## Do NOT

- Do not run `yarn migration:run` — it's on the project's `ask` permission list and requires real DB approval.
- Do not run `yarn migration:revert`.
- Do not delete the generated file even if it looks empty — an empty migration usually means there's no entity drift, which itself is useful information.

## Next step (print this verbatim at the end)

```
Migration generated. Next:
1. Review the file above (or open in your editor).
2. When ready, run:  yarn migration:run
3. To roll back the most recent batch:  yarn migration:revert
```
