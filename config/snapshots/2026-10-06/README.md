# WACRM Production Configuration Snapshot

Snapshot date: 2026-10-06

Source:
- branch: feature/wacrm-smart-lists
- production HEAD: 35c5f56d22fc4ba70413697f6463a0b9e3bc90d7

Included:
- automations
- automation_steps
- flows
- flow_nodes
- AI configuration without credentials

Security:
- raw production export is stored only under backups/ and is Git-ignored
- API keys, tokens, authorization headers, passwords and secrets are redacted
- this snapshot is intended as a versioned reference for migration, diff and idempotent seed/import work

Important:
This snapshot is not a database backup and must not be used as a blind destructive restore.
