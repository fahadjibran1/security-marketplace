# S4 Automated UAT

Baseline: `release/v1.0.0-rc1`

This branch starts automated RC1 validation using the existing GitHub release gates against isolated CI infrastructure.

Initial automated scope:
- backend compile
- release smoke tests
- clean PostgreSQL migration run
- migration idempotence
- migration state check
- schema drift check
- dependency audit
- mobile build/typecheck and regression gates

No production data mutations are performed by these CI gates.
