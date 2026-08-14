# ADR-0002: Derive the workspace catalog from managed projects

- Status: Accepted
- Date: 2026-08-13
- Decision owners: bbcom maintainers
- Supersedes: ADR-0001's separate global catalog database

## Context

Each managed `.bbcom` file already contains its authoritative UUID, title,
revision, save health, active session, and update time. Copying those fields into
a second SQLite catalog would create a second transaction boundary and require a
reconciliation protocol after import, rename, crash recovery, or manual file
damage.

## Decision

- The managed library is the catalog authority. Catalog refresh enumerates only
  canonical `<workspace-uuid>.bbcom` names, opens each project read-only, and
  derives its summary from the validated workspace header.
- A corrupt non-active project is isolated and omitted from that refresh; it
  cannot prevent healthy projects from opening.
- The last-active UUID is the only mutable cross-project pointer. Rust writes it
  through a private same-directory temporary file, file sync, atomic replacement,
  and parent-directory sync. Missing, malformed, non-UTF-8, stale, or unreadable
  pointers degrade to “no active project” and never block startup.
- No renderer or secondary database may cache authoritative catalog metadata.
  Search, recent-project, and pagination views are projections of the current
  verified catalog response.

## Consequences

- Project metadata has one writer and one durable transaction boundary.
- Catalog refresh cost is proportional to the managed project count; this is an
  accepted usability architecture trade-off, not a performance project.
- Future indexing may add a disposable cache only if every entry can be rebuilt
  from managed projects and cache loss cannot affect correctness.
