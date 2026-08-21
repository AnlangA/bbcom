# bbcom-plugin-repository

Native package installer. It loads local packages or HTTPS repository indexes,
extracts packages into a staging directory, and activates versions.
`prepare_install` and `prepare_rollback` persist an fsynced repository journal
and return an opaque descriptor without native paths. `commit_prepared`,
`discard_prepared`, and the active/prepared path resolvers reload that journal,
match the descriptor, and derive paths beneath installer-owned roots.
Interrupted commits are completed from install state.

The crate has no scheduler, background updater, publisher trust claim, WebView
bridge, or concrete HTTP client. A native caller supplies an `HttpsTransport`.

`PluginInstaller::activate_rollback` restores a previous package and data
snapshot and changes the active package pointer under a durable recovery
journal. A process stop between the data-directory exchange and install-state
commit is reconciled from the atomic install state before any later operation.

Package and component digests are bookkeeping fields only and are not checked
as installation or publisher trust gates.
