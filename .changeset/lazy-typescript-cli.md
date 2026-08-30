---
"@apifuse/provider-sdk": patch
---

TypeScript is no longer a production dependency; CLI commands that need it resolve it lazily and fail with a clear message when absent.
