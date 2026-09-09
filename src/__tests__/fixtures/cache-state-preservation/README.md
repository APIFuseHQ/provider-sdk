These byte fixtures were captured from the branch base `beafbf7` during review round 3.

- `http-base.jsonl` is the original 968-byte successful HTTP cache/retry capture.
- `cache-base.jsonl` is the original 4975-byte cache method/response metadata capture.
- `shared-{caught,reject,resolve}-base.jsonl` are the three reviewer `server-probe.ts`
  scenarios. Each keeps the mode, response status and tenant `meta.cache`, direct
  `responseMeta()`, and error identity from the base probe. Only telemetry header/log
  fields are omitted. Missing tenant cache metadata is represented by `null`.

`cache-state-telemetry-preservation.test.ts` reruns the existing HTTP/cache suites
in isolated child processes with `cache-state-capture-preload.ts`, then compares the
resulting bytes with the first two fixtures. The same test reproduces each shared
loader scenario and compares its serialized tenant fields with the other fixtures.
