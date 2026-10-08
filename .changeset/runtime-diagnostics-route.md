---
"@apifuse/provider-sdk": minor
---

Serve `GET /__apifuse/diagnostics/runtime` on the primary listener: process CPU over a short sampling window, memory, the Node event-loop and active-resource APIs (flagged when the runtime stubs them, as Bun 1.2/1.3 do), and on Linux per-thread CPU, context switches and file-descriptor counts from `/proc/self`. Read-only and secret-free, behind the same cluster-network boundary as `/health` and `/readyz`.
