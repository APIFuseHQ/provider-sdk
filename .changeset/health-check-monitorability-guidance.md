---
"@apifuse/provider-sdk": minor
---

Teach and enforce the monitored health-check surface.

The platform health monitor executes a case's serialized `scenario` and nothing
else — a closure cannot cross the registry's serialization boundary. A case
carrying only `assertions` is still published as a probe, but its outcome is
permanently `unknown` / `monitoring_unavailable`, so the operation reads as
monitored while nothing is checked. The SDK's own shipped guidance documented
only the imperative form, so an author following it exactly produced an
unmonitored operation.

- `.agents/skills/health-checks-and-fail-closed/SKILL.md` now teaches `scenario`
  as the monitored surface (with a runnable `defineHealthScenario` example) and
  `assertions` as the provider's self-test only. Run `apifuse sync-assets` to
  pick it up; the scaffold README carries the same correction.
- `apifuse check` gains two warning-level rules:
  `health-check-assertions-not-monitored` (a case declares `assertions` without
  a `scenario`) and `health-check-stale-serve-unguarded` (provider source uses
  `staleIfErrorMs` but no scenario guards the `served_stale_cache` operand, so an
  upstream outage answers a schema-valid 200 and the probe reports `ok` for the
  whole stale window). Both are warnings while the
  fleet migrates; neither fails `apifuse check`.
