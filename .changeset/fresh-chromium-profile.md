---
"@apifuse/provider-sdk": major
---

Move the exported stealth default from the version-pinned `chrome-146` profile to the stable `chrome-desktop` alias. The alias and `generic-desktop` now use the newest Chromium profile supported by wreq-js, with a test guard against becoming stale again. Public profile discovery now returns only intent-based desktop/mobile aliases, while registered versioned names remain runtime-compatible and emit a deprecation warning through the existing stealth warning channel.

`apifuse check` now blocks browser-version profile strings, versioned User-Agent literals, and versioned `sec-ch-ua` literals in provider source. Tests, recorded fixture trees, and comments are excluded, and diagnostics point authors to intent aliases and registry-derived User-Agents.
