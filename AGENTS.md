# Agent Instructions

## Skills

Step-by-step instructions live in skills in `.agents/skills/`, linked as `.claude/skills/` for Claude Code. Any agent can also read them as plain files. Whenever one of these situations applies, follow its skill in the same change:

- **Changing anything database-related** (a file in `prisma/schema/`, a migration, or a model, field, enum, or relation) → `database-changes` (`.agents/skills/database-changes/SKILL.md`): put it in the right schema file, create the migration, regenerate the client, and update the seed. Running the seed wipes local data, so ask first.
- **Adding or changing an image upload, or replacing or removing a stored image** → `image-uploads` (`.agents/skills/image-uploads/SKILL.md`): every upload goes through `StorageService.uploadImage`, sized for where it's shown.
- **Adding or changing content people could look up by name or text** → `search-endpoints` (`.agents/skills/search-endpoints/SKILL.md`): add or update its search endpoint, with the same visibility rules as wherever it's listed.

## Rules

- **Unconfirmed emails are read-only.** Until someone confirms their email, `ConfirmedEmailGuard` (`src/auth/confirmed-email.guard.ts`) refuses every `POST`, `PUT`, `PATCH`, and `DELETE` they send with a 403 whose `code` is `email_unconfirmed`. New endpoints are covered automatically, so keep it that way: only add `@AllowUnconfirmed()` to logging in, signing up, and confirming an email, to the person's own preferences and onboarding progress, to marking their notifications read, and to downloading their data and deleting their own account.
- **Reuse before you build.** Before writing a new service method, query, DTO, guard, or helper, look for one that already does the same job or follows the same pattern, in `src/common/` (for example the `author` and `presenceUser` selects, `cursorPage`, `searchContains`, `isUniqueViolation`, the `IsId` and `IsLinkUrl` validators, and `@UserId()`) and in the module you're working in, and use it. When you'd be writing the same shape a second or third time, move it into a shared helper in `src/common/` or the module that owns it, and switch the existing copies over, as long as behavior stays the same and the shared version is shorter and just as easy to read. Don't add a helper only one place uses.
