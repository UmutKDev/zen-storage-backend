---
description: Scan entities, models, and schemas for camelCase property violations of the PascalCase rule
argument-hint: [path]  defaults to src/entities, src/modules, src/schemas
allowed-tools: Read, Grep, Glob, Bash(rg:*)
---

Read-only audit for camelCase property violations of the project's PascalCase rule.

## Targets

If `$ARGUMENTS` is non-empty, scan that path. Otherwise default to:

- `src/entities/`
- `src/modules/**/*.model.ts`
- `src/schemas/**/*.schema.ts`

## Patterns to grep (read-only)

Run each pattern with ripgrep, multi-line mode (`-U`), printing `file:line` for every hit:

1. TypeORM column on a lowercase property:
   ```
   rg -nU '@Column\([^)]*\)\s*\n\s*[a-z]\w*\s*[:=]' <path>
   ```
2. `class-transformer` expose on a lowercase property:
   ```
   rg -nU '@Expose\([^)]*\)\s*\n\s*[a-z]\w*\s*[:=]' <path>
   ```
3. TypeORM primary key on a lowercase property:
   ```
   rg -nU '@PrimaryGeneratedColumn\([^)]*\)\s*\n\s*[a-z]\w*' <path>
   ```
4. Mongoose schema prop on a lowercase property:
   ```
   rg -nU '@Prop\([^)]*\)\s*\n\s*[a-z]\w*\s*[:=]' <path>
   ```
5. Swagger ApiProperty on a lowercase property:
   ```
   rg -nU '@ApiProperty\([^)]*\)\s*\n\s*[a-z]\w*\s*[:=]' <path>
   ```

## Output

If zero hits across all five patterns:

```
check-pascal-case: no violations.
```

Otherwise, print a Markdown table:

| File | Line | Offending | Suggested |
|---|---|---|---|
| `src/entities/foo.entity.ts` | 23 | `email: string` | `Email: string` |

After the table, quote the rule citation from `.github/copilot-instructions.md` Naming Rules section so the user has the source-of-truth handy.

## Do NOT

- Do not edit any file. This is a read-only audit.
- Do not flag method/function names — the rule is for **properties** on entities, models, and schemas only.
- Do not flag constructor parameters or local variables — they may legitimately be camelCase.
- Do not flag external library types (anything under `node_modules/`).
