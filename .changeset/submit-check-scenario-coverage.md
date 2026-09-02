---
"@apifuse/provider-sdk": patch
---

`apifuse submit-check` now recognises a declarative health-check case (`scenario`) as real health coverage instead of scoring it as an empty assertion. A scenario counts when at least one `assert` step reads the probe response beyond the transport envelope; scenario-only suites whose asserts are transport-only (`status_2xx`, bare `data` envelope pins, literal tautologies) or that carry no assert step at all are still blocked, and the imperative empty-assertions judgement is unchanged. Patch bump: scoring/tooling fix only — no authoring surface, schema, or runtime behavior changes.
