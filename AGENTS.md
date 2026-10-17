# Shiny project rules

- Never commit production credentials, OAuth auth-files, R2 settings, database dumps, user/order data or raw support logs. `maintenance/` is private ignored working data, not a source tree.
- Canonical New API source is `new-api/`; do not implement features in historical copies under `maintenance/`.
- Respect `new-api/AGENTS.md`, frontend conventions and billing rules. Keep new-api's current audit features and expression billing.
- New API, CPA, CPA Manager Plus and the independent portal have separate version and deployment lifecycles. No blanket production updates.
- Portal file bytes upload directly to R2. Preserve existing resource URLs and compatibility for immutable old frontend assets.
- Use feature branches, run meaningful tests and secret scanning, verify candidate deployment before production. Never push binaries/runtime state as source backups.
- Record grants, actual cash payments and quota separately. Historical wallet provenance may be incomplete; do not invent a refundable paid balance from aggregate quota.
