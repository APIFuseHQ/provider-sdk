---
"@apifuse/provider-sdk": major
---

Move the exported stealth default from a version-pinned profile to explicit structured Chrome/macOS selection. Structured Chrome profiles use the newest Chromium profile supported by wreq-js, with a test guard against becoming stale again. Public profile discovery returns supported browser/OS descriptors, and versioned or alias-shaped strings are rejected with structured replacement guidance.

`apifuse check` now blocks browser-version profile strings, versioned User-Agent literals, and versioned `sec-ch-ua` literals in provider source. Tests, recorded fixture trees, and comments are excluded, and diagnostics point authors to structured browser/OS selection and accessor-derived User-Agents.
