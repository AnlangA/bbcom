# Security policy

Report vulnerabilities privately to the maintainers rather than opening a
public issue. Do not include serial payloads, API keys, complete paths, or
customer data in a report.

bbcom keeps AI keys in the OS keyring; when that is unavailable it holds a
zeroizing process-memory fallback only. Export and auto-log paths remain in
Rust behind expiring opaque grants. The application has no telemetry or crash
upload feature.

`cargo audit` may report upstream unmaintained GTK/Tauri transitives. These are
warnings, not ignored vulnerabilities. Their owner is `@AnlangA`; the next
quarterly review date is **2026-10-01**. Vulnerable, unsound, and yanked crates
are release blockers.
