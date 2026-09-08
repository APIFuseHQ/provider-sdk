---
"@apifuse/provider-sdk": minor
---

Add `publicField(schema)` and make `field(schema, { sensitive: false })` emit an explicit `x-apifuse-sensitive: false` on the JSON Schema leaf (previously it emitted nothing; any `x-apifuse-sensitive-kind` is dropped when the flag is false). The platform fixture-privacy ratchet treats a key-based classifier hit (name, phone, address shapes) as declared when the schema at that path carries an explicit boolean: `true` via `sensitive()` / `fields.*()` means personal data, redacted in published artifacts; `false` means reviewed public data such as business names, facility phones, or timezone names, and is not redacted. Declare every classifier hit one way — `false` is a review verdict, not a redaction opt-out. The `sensitive-field-unmarked` lint rule accepts either declaration. Existing `sensitive: false` callers now emit the explicit `false` meta; downstream consumers test `=== true`, so nothing that was redacted stops being redacted.
