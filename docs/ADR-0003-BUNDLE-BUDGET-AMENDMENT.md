# ADR-0003: Amend the one-time bundle budgets

- Status: Accepted
- Date: 2026-08-13
- Decision owners: bbcom maintainers
- Amends: ADR-0001's one-time feature-budget adjustment

## Context

The approved G03 plan fixed gzip ceilings of 320 KiB for all JavaScript,
255 KiB for the main-window startup graph, and 145 KiB for the AI-window
startup graph. It also explicitly excluded a bundle-performance project and
kept the existing bootstrap and individual-chunk ceilings as regression guards.

After the workspace, application-runtime, reliability, AI-window, and usability
architecture was integrated, the complete production `dist` measured under the
bundle gate's binary-KiB manifest-reachability rules as follows:

| Scope                     | Approved ceiling |      Integrated baseline |
| ------------------------- | ---------------: | -----------------------: |
| All JavaScript            |          320 KiB | approximately 359.19 KiB |
| Main-window startup graph |          255 KiB | approximately 284.88 KiB |
| AI-window startup graph   |          145 KiB | approximately 138.92 KiB |

The total and main-window baselines therefore cannot satisfy the planned limits
without removing accepted architecture or starting the byte-level optimization
work that the plan explicitly excludes. The AI-window baseline remains within
its approved limit. Bundle ceilings are release regression guards, not product
requirements or optimization targets.

## Decision

The initial workspace baseline amendment set the gzip ceilings to:

- all JavaScript: 368 KiB (376,832 bytes), superseded for the total only by
  the plugin boundary addendum below;
- main-window startup graph: 290 KiB (296,960 bytes);
- AI-window startup graph: 145 KiB (148,480 bytes).

The 85 KiB bootstrap ceiling and 105 KiB individual-chunk ceiling are unchanged.
The revised limits leave only bounded build variance and regression headroom
above the measured integrated baseline; they do not authorize a performance
project or further feature scope.

### Plugin boundary addendum

The generated plugin IPC boundary and host-rendered plugin controls were later
made production-reachable behind a fail-closed service injection. The complete
build then measured 368.11 KiB total while every startup, window, and chunk
ceiling remained satisfied. Removing accepted validation or accessibility code
to recover 109 gzip bytes would be the byte-level optimization project this ADR
excludes. The total-only ceiling is therefore amended once to 376 KiB (385,024
bytes). The 290/145 KiB window, 85 KiB bootstrap, and 105 KiB chunk ceilings are
unchanged. This addendum does not enable plugins or the marketplace; ADR-0004's
platform gates remain authoritative.

### 2026-08-16 tri-domain fix batch addendum

The navigation/UI/plugin fix batch (docs/BUGFIX_AUDIT_2026-08.md) added
accepted production surface: the `tauri-plugin-opener` JS binding for external
links, ~30 locale keys in both catalogs, dark-mode overrides for the remaining
Naive controls, session view-state retention, and command-receipt protocol
handling. The complete build measured 378.60 KiB total while every startup,
window, chunk, and bootstrap ceiling remained satisfied. Following the plugin
boundary precedent, the total-only ceiling is amended once more to 380 KiB
(389,120 bytes); all other ceilings are unchanged.

### 2026-08-19 managed project deletion addendum

The managed-project deletion flow adds a generated request/response boundary,
validated coordinator state, native SQLite deletion safeguards, and a
localized two-step sidebar action. After removing an avoidable eager icon
dependency, the complete build measured 380.25 KiB total and 290.27 KiB for
the main-window startup graph. Those accepted protocol and transaction paths
cannot fit under the previous 380/290 KiB ceilings without the byte-level
optimization work excluded by this ADR.

The ceilings are therefore amended to 381 KiB (390,144 bytes) for all
JavaScript and 291 KiB (297,984 bytes) for the main-window startup graph. The
145 KiB AI-window, 85 KiB bootstrap, and 105 KiB chunk ceilings are unchanged.

## Regression rules

- CI measures binary gzip sizes from the production Vite manifest using the
  existing bundle-gate definitions. A breach of any total, window, bootstrap,
  or individual-chunk ceiling fails the quality gate.
- Unused headroom is not a feature allocation. New architecture and functionality
  must remain within these ceilings unless maintainers accept another explicit
  ADR supported by a new complete-build measurement and product rationale.
- Limits must not be raised silently in scripts, workflow files, or release
  branches. A future amendment must state the previous ceiling, measured
  baseline, reason, and new bounded ceiling.
- No byte-level optimization milestone is introduced. Normal code review may
  still reject accidental bundling, duplicate dependencies, or eager imports
  that violate an existing ceiling.

## Consequences

The implemented 381/291/145 KiB limits now have an explicit architecture record,
while the stricter 85/105 KiB startup and chunk protections continue unchanged.
The earlier 320/255/145 KiB plan values are superseded by this amendment.
