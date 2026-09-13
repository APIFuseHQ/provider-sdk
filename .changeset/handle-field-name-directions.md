---
"@apifuse/provider-sdk": minor
---

`defineCursor` / `defineDraft` accept a direction-specific `fieldName`, so a
handle can be named differently on input and output (additive).

```ts
defineCursor({
  name: "page",
  fieldName: { input: "cursor", output: "next_cursor" },
  // …
});
```

The platform canon asks list operations to accept `cursor` and return
`next_cursor`, but `handle-field-name` (error) required one property key across
both sides, so the canon item was unsatisfiable for any operation paginating
with `defineCursor`. It has blocked `korea-bid-notice`, `korea-culture-event`,
`japan-diet-minutes`, and `korea-camping`.

The rule is now about the handle's **identity**, not about a single spelling,
and is no weaker for it:

- Each side must use the key declared for *that* side. A third name still fails,
  and the two keys are not interchangeable — `next_cursor` on an input or
  `cursor` on an output still fails, so the round trip keeps exactly one
  direction (read `output`, send back under `input`) and validity is still
  decided by the kind (`HANDLE_KIND_MISMATCH`).
- Both keys must be declared together; declaring one throws, because the other
  would silently fall back to `${name}_token`.

`kind.field()` is unchanged and still serves both sides: the meta carries both
names and lint checks the key against the side the field appears on.
`handle-field-parity` and `handle-issued-by` now quote the output key when they
talk about an output. Error text names both keys when they differ ("Call
`search` again and pass the new `next_cursor` back as `cursor`, exactly as
returned.").

No fleet churn: a string `fieldName` keeps its meaning and emits byte-identical
`x-apifuse-handle` meta — `outputFieldName` is present only when the two keys
actually differ.

New exports on the root and `/provider` entry points: `handleFieldNameFor`,
`handleHasDirectionalFieldNames`, and the types `HandleFieldNames` and
`HandleFieldDirection`. `HandleFieldMeta` and `HandleKindDeclaration` gain an
optional `outputFieldName`.
