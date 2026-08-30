---
"@apifuse/provider-sdk": patch
---

Revert the cause-chain message collapse introduced in 2.2.0-beta.42. Cause frames keep the readable sanitized message contract adopted by the consumer's NOL auth observability work: providers mask credential values they know before errors enter the cause channel, and the frame retains `messageLength` plus `messageFingerprint` for correlation. The unstructured-text placeholder conflicted with that contract by collapsing legitimate readable diagnostics whose wrapper tokens exceeded the classifier's heuristic.
