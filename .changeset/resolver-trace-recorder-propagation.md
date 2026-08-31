---
"@apifuse/provider-sdk": patch
---

Forward the instrumentation trace recorder through both resolver signal-binding wrappers so `resolver.vendor.*` spans (attempt/create_task/poll_result) reach the configured trace exporter instead of being recorded against a detached recorder and dropped.
