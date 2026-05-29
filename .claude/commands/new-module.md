---
description: Scaffold a complete NestJS feature module (entity, models, service, controller, module) following project conventions
argument-hint: <ModuleName>
allowed-tools: Read, Write, Edit, Glob, Grep, Bash(yarn lint), Bash(npx tsc --noEmit)
---

Scaffold a new feature module named `$ARGUMENTS`.

## Pre-flight

1. If `$ARGUMENTS` is empty, ask the user for the `ModuleName` (PascalCase, singular noun — e.g. `Invitation`, not `invitations`). Do not proceed without it.
2. Confirm a module of that name does not already exist: `ls src/modules/` and `ls src/entities/`. If it does, stop and ask whether to extend the existing module instead.

## Authoritative templates — read these before writing

- `.github/prompts/new-module.prompt.md` — file templates and field conventions
- `.github/skills/scaffold-module/SKILL.md` — the question flow (does it need team context? S3? BullMQ? Redis cache?)
- `.github/instructions/entity.instructions.md` — entity field rules
- `.github/instructions/model.instructions.md` — DTO suffix rules
- `.github/instructions/controller.instructions.md` — decorator order, route patterns
- `.github/instructions/service.instructions.md` — TypeORM patterns, AsyncLocalStorage
- `CLAUDE.md` — PascalCase rule, ownerId rule, module dependency map

## Files to create

For module name `Foo` (lowercase `foo` in paths):

- `src/entities/foo.entity.ts` — `FooEntity` with PascalCase columns
- `src/modules/foo/foo.module.ts`
- `src/modules/foo/foo.controller.ts`
- `src/modules/foo/foo.service.ts`
- `src/modules/foo/foo.model.ts` — request/response DTOs
- `src/modules/foo/foo.service.spec.ts` — minimal test scaffold

If the SKILL.md question flow indicates team context, S3, BullMQ, or Redis cache, add the relevant pieces per the corresponding `.github/prompts/*.prompt.md`.

## Post-generation

1. Run `npx tsc --noEmit` to confirm no type errors.
2. Run `yarn lint` (output may be noisy across the whole project — focus on the new files in the output).
3. Print a reminder block:
   - Register the new module in `src/app.module.ts`.
   - If new CaslSubject or CaslAction is needed, suggest invoking `/add-endpoint` next (it wires CASL policies).
   - If cross-module imports were introduced, update the **Module Dependency Map** section of `CLAUDE.md`.
   - If a new entity was added, suggest `/migration Add$ARGUMENTSEntity` to generate the TypeORM migration.

## Do NOT

- Do not run `yarn migration:run` (touches a real DB).
- Do not modify `.github/`, `.claude/`, or `CLAUDE.md` without a specific reminder being triggered above.
- Do not invent abstractions not present in the templates (no base classes, no generic repository wrappers).
