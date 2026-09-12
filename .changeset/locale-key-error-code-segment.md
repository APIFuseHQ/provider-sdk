---
"@apifuse/provider-sdk": patch
---

Accept the error code itself as a locale key segment under `errors`, so the
`messageKey`/`fixKey` spelling AUTHORING documents stops being reported as
malformed.

`errors.<code>.<field>` is the derived catalog path, and the registered codes
authors are pointed at — `UPSTREAM_AUTH_ERROR`, `UPSTREAM_SCHEMA_ERROR`,
`INVALID_REQUEST` — are SCREAMING_SNAKE. The locale-key grammar only spelled
camelCase, so an author who wrote `messageKey: "errors.UPSTREAM_SCHEMA_ERROR.message"`
got an `error-locale-key-malformed` error from `apifuse check` even though the
served text was correct (the derived candidate resolved the same path), and the
explicit key itself was silently skipped at serve time — a key pointing at
another code's entry missed outright.

The grammar now reads: dot-separated segments, each camelCase or an array
index, first segment always camelCase; the segment **directly under `errors`**
may additionally be an error code — a single-case underscore identifier
starting with a letter (`UPSTREAM_SCHEMA_ERROR`, `BLOCKED`, `reauth_required`).
Nothing else is loosened. Spaces, dots inside a segment, empty segments,
mixed-case (`Upstream_Error`) and hyphenated codes, leading/trailing/doubled
underscores, and a code in the root position are all still rejected, and no
error code can be spelled as an all-digit segment, so the array-index form
stays disjoint. `errors.upstreamSchema.message` keeps working; no previously
valid key becomes invalid.

A test asserts that every code the SDK registers derives a legal locale key, so
registering a future code with an unspellable shape fails CI instead of
producing a misleading diagnostic in the fleet.
