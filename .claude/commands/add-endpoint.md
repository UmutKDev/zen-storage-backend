---
description: Add a new endpoint to an existing controller with correct CASL policy, models, and service method
argument-hint: <ControllerPath> <HttpMethod> <Route>
allowed-tools: Read, Edit, Glob, Grep, Bash(npx tsc --noEmit), Bash(yarn lint)
---

Add a new endpoint to an existing controller. Arguments: `$ARGUMENTS` should be `<ControllerPath> <HttpMethod> <Route>`.

## Pre-flight

Parse `$ARGUMENTS` into three pieces:
1. `ControllerPath` — e.g. `src/modules/cloud/cloud.controller.ts` (must exist; if not, suggest `/new-module` first)
2. `HttpMethod` — one of `GET | POST | PUT | PATCH | DELETE`
3. `Route` — the path fragment after the controller's base path (e.g. `:id/lock`)

If any piece is missing or invalid, ask the user.

## Authoritative templates — read these before editing

- `.github/instructions/controller.instructions.md` — decorator order, route patterns, return types
- `.github/instructions/service.instructions.md` — service method shape, repository usage
- `.github/instructions/model.instructions.md` — DTO suffix rules
- `.github/prompts/add-casl-policy.prompt.md` — only if a new `CaslSubject` is needed
- `src/common/enums/casl.enum.ts` — current `CaslAction` and `CaslSubject` enum values
- `CLAUDE.md` — ownerId rule, PascalCase rule, response shape

## Enforce on the generated code

| Concern | Rule |
|---|---|
| Service method casing | PascalCase (e.g. `LockDocument`) |
| Controller method casing | camelCase (e.g. `lockDocument`) |
| Policy decorator | `@CheckPolicies` with `CaslAction` matching the HTTP method (Create↔POST, Update↔PUT/PATCH, Delete↔DELETE, Read↔GET) |
| Swagger | `@ApiOperation({ summary })` + `@ApiResponse({ status, type })` |
| Body DTO | `*PostBodyRequestModel` / `*PutBodyRequestModel` / `*PatchBodyRequestModel` |
| Query DTO | `*QueryRequestModel` |
| Param DTO (if multi-field) | `*ParamRequestModel` |
| Response DTO | `*ResponseModel` (single) or `Array<*ResponseModel>` (list — `TransformInterceptor` will wrap and populate `Options.Count`) |
| User injection | `@User() user: UserContext` when user-aware |
| Storage owner | If any S3 path is built, use `KeyBuilder([GetStorageOwnerId(user), ...])` and name the variable `ownerId` |
| Team context | If route is team-scoped, ensure `@CheckPolicies` uses the team-scoped subject (e.g. `TeamCloud`, not `Cloud`) |

## Post-edit

1. Run `npx tsc --noEmit` — must pass clean.
2. Run `yarn lint` — focus on the touched files in the output.
3. Hand off to the `casl-permission-reviewer` subagent for an authorization audit on the new method.

## Do NOT

- Do not add new providers, repositories, or modules — this command extends an existing controller only. Use `/new-module` for greenfield.
- Do not add new error-handling abstractions — the global `HttpExceptionFilter` already converts `HttpException` to the standard response shape.
