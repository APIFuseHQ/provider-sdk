---
"@apifuse/provider-sdk": minor
---

Add request-scoped OCR and speech-to-text capability telemetry contributors and instrumentation spans.
`OcrContext` and `SttContext` are now reachable through the top-level `bindOcrTelemetry` and `bindSttTelemetry` function signatures, so consumers may see those type names in their own API reports.
- Fixes the shared telemetry observer guard used by the P5a `http` observer and the later `stealth`, `native`, and `browser` observers: a rejected promise whose own `then` was shadowed by a non-function was previously ignored and surfaced as an unhandled rejection; it is now absorbed and recorded as a telemetry failure.
- Long base64-shaped runs in upstream error bodies are replaced by `[BASE64_STRIPPED]` as a defence-in-depth payload safeguard.
