---
"@apifuse/provider-sdk": patch
---

`apifuse record` and `submit-check --smoke` can exercise a provider whose auth
mode needs a gateway-injected credential.

The gateway resolves the credential a provider needs and attaches it to every
request envelope as `connection: { id, mode, secrets, metadata, externalRef }`;
`serve` builds `ctx.credential` from `connection.secrets` and nothing else. For
`auth.mode: "platform-managed"` those secrets are the platform-owned key the
caller never holds — which is why a health probe reaches one only by going back
through the gateway (`ctx.gateway.execute(...)` inside a case's `prepareInput`).

Nothing that ran outside the gateway could supply it. `apifuse record`
hard-coded `credential: { mode: "none" }`, so `ctx.credential.get(...)` returned
`undefined` and every platform-managed provider died on its own
`MISSING_SECRET` — a message that reads like a bad key or an upstream outage,
not like a recorder that cannot run this class of provider at all.
`submit-check --smoke` POSTed an envelope with no `connection`, so the same
providers answered `MISSING_SECRET` for every operation and scored as "runtime
verified, no live upstream success": a capability gap wearing the costume of an
ordinary miss.

- New `src/cli/local-connection.ts` resolves the local stand-in for the
  gateway's connection, producing the exact envelope shape the gateway injects
  so provider code takes its production branch.
- `apifuse record` accepts `--credential <key>=<value>` (repeatable) and
  `APIFUSE__LOCAL_CONNECTION__SECRETS='{"<key>":"<value>"}'`. A single JSON
  value rather than one variable per key, because `platform-managed` forbids
  declaring `credential.keys`, so the key names live only in the provider's own
  source and no env-name derivation would be right for every provider.
- When the provider needs a credential and none is configured, `record` now
  fails up front with a message naming both ways to supply it, instead of
  letting the failure surface from inside a handler. `--no-credential` keeps the
  old behaviour, explicitly.
- `submit-check --smoke` attaches the same connection, and when one is needed
  but absent it says so in the check message, evidence and remediation rather
  than reporting a missing live success.
- The injected credential is seeded into the recorder's redaction sets before
  anything executes, so an upstream error that echoes the key, and any fixture
  that captured it, are redacted by the machinery that already covers declared
  query secrets.
- A smoke run whose credential was never supplied can no longer earn full
  points from an unauthenticated operation's success: it never exercised the
  credentialed path.
- Malformed `--credential` and `APIFUSE__LOCAL_CONNECTION__SECRETS` diagnostics
  never echo the offending value: the argument that is malformed is often the
  credential itself, and the parser runs before any redaction context exists.
- Credential **values** are registered for redaction; their key names are not.
  `sensitiveParamNames` means "declared query-key position", and `redactFixture`
  skips common-field sanitization for a key listed there — seeding
  `access_token` would have written a newly issued upstream `access_token` to
  `raw.json` in plaintext.
- A smoke run whose credential is configured but invalid reports the
  configuration error instead of a generic absence.
