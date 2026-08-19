# bbcom-plugin-repository

Native-only core for G42. It loads one or more strict HTTPS repository indexes,
checks manual update candidates, verifies bounded downloads, extracts packages
into an isolated staging directory, and atomically activates verified versions.
`prepare_install` and `prepare_rollback` persist an fsynced repository journal
and return an opaque descriptor without native paths. `commit_prepared`,
`discard_prepared`, and the active/prepared path resolvers reload that journal,
match the complete descriptor, and derive every path beneath installer-owned
roots. Interrupted commits are idempotently completed from install state.

The crate deliberately has no scheduler, background updater, publisher trust
claim, WebView bridge, or concrete HTTP client. A native caller supplies an
`HttpsTransport`; the core still enforces HTTPS and same-origin redirects.

`PluginInstaller::activate_rollback` is the native commit primitive for a
verified rollback candidate. It restores the candidate's matching bounded data
snapshot and changes the active package pointer under a durable recovery
journal. A process stop between the data-directory exchange and install-state
commit is reconciled from the atomic install state before any later operation.

this crate intentionally does not turn SHA-256 transport integrity into a
publisher-authentication assertion.
