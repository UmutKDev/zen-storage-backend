---
name: Add CASL Policy
description: Wire a new CASL subject through the entire permission system (enum, factory, controller)
argument-hint: New subject name (e.g. "Report", "Invoice") and which roles should have access
agent: agent
---

Add a new CASL authorization subject to the project. This requires touching 3 files in a specific order.

# Input
Subject name: $input

# Step 1 — Add to CaslSubject Enum

File: `src/common/enums/casl.enum.ts`

Add the new subject value to `CaslSubject`:
```typescript
export enum CaslSubject {
  // ... existing values ...
  {SubjectName} = '{SubjectName}',      // Personal context
  Team{SubjectName} = 'Team{SubjectName}',  // Add this only if team context is needed
}
```

Current enum values for reference:
- Personal: `All, User, Subscription, MySubscription, Cloud, CloudDirectory, CloudUpload, CloudArchive, Account, Session, Passkey, TwoFactor, ApiKey, Definition, Team, Webhook, Document`
- Team: `TeamMember, TeamInvitation, TeamCloud, TeamCloudDirectory, TeamCloudUpload, TeamCloudArchive, TeamDocument`

# Step 2 — Add Permissions in CaslAbilityFactory

File: `src/modules/authentication/casl/casl-ability.factory.ts`

Add to `BuildPersonalAbilities()`:
```typescript
// {SubjectName}
can(CaslAction.Read, CaslSubject.{SubjectName});
can(CaslAction.Create, CaslSubject.{SubjectName});
can(CaslAction.Update, CaslSubject.{SubjectName});
can(CaslAction.Delete, CaslSubject.{SubjectName});
```

If team context is needed, add to `BuildTeamAbilities()` for appropriate roles:
```typescript
case TeamRole.OWNER:
  can(CaslAction.Manage, CaslSubject.Team{SubjectName});
  break;

case TeamRole.ADMIN:
  can(CaslAction.Manage, CaslSubject.Team{SubjectName});
  break;

case TeamRole.MEMBER:
  can(CaslAction.Read, CaslSubject.Team{SubjectName});
  can(CaslAction.Create, CaslSubject.Team{SubjectName});
  can(CaslAction.Update, CaslSubject.Team{SubjectName});
  can(CaslAction.Delete, CaslSubject.Team{SubjectName});
  break;

case TeamRole.VIEWER:
  can(CaslAction.Read, CaslSubject.Team{SubjectName});
  break;
```

# Step 3 — Apply @CheckPolicies to Controller

In the target controller file:

**Class level (default read access for all methods):**
```typescript
@CheckPolicies((ability) => ability.can(CaslAction.Read, CaslSubject.{SubjectName}))
@Controller({ path: '{SubjectName}', version: '1' })
export class {SubjectName}Controller {
```

**Method level overrides (for write operations):**
```typescript
@CheckPolicies((ability) => ability.can(CaslAction.Create, CaslSubject.{SubjectName}))
@Post()
async create(...) {}

@CheckPolicies((ability) => ability.can(CaslAction.Update, CaslSubject.{SubjectName}))
@Put(':id')
async update(...) {}

@CheckPolicies((ability) => ability.can(CaslAction.Delete, CaslSubject.{SubjectName}))
@Delete()
async delete(...) {}
```

# Available CaslAction Values

`Manage | Create | Read | Update | Delete | Upload | Download | Extract | Archive | Execute`

- `Manage` = wildcard that covers all other actions (used for ADMIN role)
- Use specific actions (not `Manage`) for regular user permissions

# Reminder

After making these changes:
- `Role.ADMIN` automatically gets `CaslAction.Manage` for `CaslSubject.All` — no explicit addition needed for admins
- The `PoliciesGuard` reads `@CheckPolicies` metadata and calls `ability.can()` at runtime
- If a controller method doesn't have `@CheckPolicies`, the class-level policy applies
