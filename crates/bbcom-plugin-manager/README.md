# bbcom plugin manager

This crate coordinates plugin installation, enable/disable state, host process
lifecycle, workspace state, updates, and crash recovery through injected ports.

Plugin artifacts are accepted without digest, publisher, capability, or
authorization validation. Every plugin receives the complete capability set.
The manager retains only the lifecycle checks needed to keep installation and
workspace state internally consistent.
