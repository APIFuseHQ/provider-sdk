# Upstream notes

Per-vendor / per-API-family pitfalls proven by live evidence. These are the
highest-value files in this workspace: general principles are knowable, but
"this API silently ignores param X" is only discoverable by getting burned.

- Read EVERY file here before your first upstream call.
- When you discover a new upstream quirk (silently ignored param, unit
  surprise, undocumented value domain, error-shape oddity), ADD it here in
  the same format — evidence line included. Reviewers treat contributed
  upstream notes as part of submission quality.

Format per entry: **Symptom → Cause → Rule → Evidence**.
