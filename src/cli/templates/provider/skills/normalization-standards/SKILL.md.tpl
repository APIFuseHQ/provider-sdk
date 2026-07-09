---
name: normalization-standards
description: Public output contract rules — field naming, timestamps, enums, units, nullability. Load before writing or editing any output schema or mapper.
---

# Normalization standards

Public output is the product. Apply these to every schema + mapper pair.

## Field naming
- `snake_case`, English, semantic. `emergency_phone`, not `dutyTel3`.
- Never expose vendor key vocabularies (`hv1`..`hv12`, `MKioskTy*`, `duty*`)
  as public field names OR as dynamic record keys. A
  `z.record(z.string(), ...)` keyed by vendor codes is still a vendor leak —
  map codes to a stable public vocabulary (enum keys or an array of
  `{ code, label, status }` objects with normalized status).

## Timestamps and dates
- Public: ISO 8601 (`2026-07-07T22:28:55+09:00`, dates `2026-07-07`,
  clock times `HH:MM`). Include the upstream's timezone offset; Korean public
  APIs are KST (+09:00) — verify, then encode it.
- Vendor formats (`YYYYMMDDHHmmss`, `HHmm`, unpadded `900`) are parsed inside
  the mapper. Unparseable → `null`, plus a test for that row shape.
- Never emit a raw vendor timestamp string in public output, including
  fixtures.

## Enums
- Vendor status values (codes, `Y`/`N`, Korean labels like `불가능`,
  `정보미제공`) → declared `z.enum`. Unknown value → explicit `unknown` member
  or fail closed; never pass raw text through.
- Map from the OFFICIAL code table, not from guessing what live samples mean.
  Add a regression test per enum member.

## Numbers and units
- Field name states the unit: `distance_meters`, `radius_meters`,
  `price_krw`. Mapper proves the conversion (upstream km → `* 1000`).
- Verify the upstream unit from spec or live-data sanity check (a "distance"
  of `1.2` from a nearby search is km, not meters). Sibling endpoints of the
  same vendor may differ — verify each one.
- Value-domain constraints (`nonnegative`, `min`, `max`) must reflect the
  upstream's REAL domain observed in live data, not what seems sensible.
  A wrong `nonnegative()` turns real negative values into `null`/errors
  silently.

## Nullability
- `null` means "upstream did not provide it" — never "parsing failed" and
  never a placeholder for invented data.
- Required-for-identity fields (ids, names) missing → throw
  `UPSTREAM_SCHEMA_ERROR`; do not emit partial rows.

## Checklist before submitting a schema/mapper change
- [ ] No vendor key visible in any public field name or record key
- [ ] All timestamps ISO 8601 with timezone; parsing tested for real vendor
      shapes (padded/unpadded, string/number)
- [ ] All status-like strings are declared enums with official-table mapping
- [ ] Every numeric field's unit is in its name and conversion is tested
- [ ] Constraints checked against live data, not intuition
