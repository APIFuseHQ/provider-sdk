---
"@apifuse/provider-sdk": patch
---

`apifuse migrate-shape`: when adding the derived `ProviderContext` alias,
drop a conflicting `ProviderContext` named import (the deprecated SDK-root
context type legacy sources import). Leaving both produced TS2440 in the
migrated output; siblings in the import list are preserved. Measured on the
fleet: recovers ohouse and naver-flight end to end (load + tsc green).
