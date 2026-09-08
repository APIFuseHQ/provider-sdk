---
"@apifuse/provider-sdk": minor
---

ADR-0012 follow-ups from the first fleet wave (additive):

- `issuedBy` on `defineCursor` / `defineDraft` accepts a list of operation keys
  (`HandleIssuedBy = string | readonly string[]`). The field description and every
  recovery sentence name all issuers ("Call `search-address` or `reverse-geocode`
  again…"); lint `handle-issued-by` validates each entry and requires at least
  one to output the field. `pick({ issuedBy })` accepts the same shape.
- `defineDraft` gains `access: "public"` (default `"bound"`) and, for public
  drafts, `strength`. Public drafts live in provider scope, use the public word
  count (4, or 5 when `ttl.max > 1h` or `strength: "high"`), require
  `maxEntries`, and collapse every lookup failure to `HANDLE_INVALID` like public
  cursors. `DraftKind.access` is now `HandleAccess`; `DraftKind.strength` added.
- `ctx.handle.createRecord(kind, data)` returns the full `HandleRecord`
  (`handle`, `status`, `data`, `createdAt`, `expiresAt`); `create` remains the
  string-returning shortcut.
- Root and `/provider` entry points export `APIFUSE_HANDLE_META_KEY`,
  `handleFieldDescription`, `isHandleFieldMeta`, `HANDLE_KIND_NAME_PATTERN`,
  `createMemoryProviderRuntimeState`, and `createUnsupportedProviderRuntimeState`.
- Migration guide corrections: `normalizeHandle` return shape, the
  "side effect must never re-run" commit pattern, connectionless providers,
  `field()` instance reuse, and `pick` string comparison. ADR-0012 D1/D2/D3/D7 and
  Pitfall 1 amended.
