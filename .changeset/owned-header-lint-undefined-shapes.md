---
"@apifuse/provider-sdk": patch
---

The stealth-owned header lint no longer exempts an `undefined` value in the shapes the runtime does not drop.

`apifuse check` exempted a statically `undefined` value in every header shape because `ctx.stealth` drops undefined entries before the ownership check. That holds only for the record shapes (`{ "sec-fetch-dest": undefined }`, `headers["sec-fetch-dest"] = undefined`): `Headers.set(name, undefined)` / `append(name, undefined)` stringify to `"undefined"`, and a `[name, undefined]` tuple keeps the entry, so both are still rejected at request time with `STEALTH_HEADER_OVERRIDE_UNSUPPORTED`. Those two shapes are now reported.

Docs only, no behaviour change: `src/runtime/stealth-owned-headers.ts` and `isReportedOwnedHeaderName` now state that the lint reports a deliberate subset of what the runtime rejects — `host`, `connection`, `accept-encoding`, and a `user-agent` whose value is not a versioned literal stay silent — so a green `apifuse check` is not proof that no owned header is set.
