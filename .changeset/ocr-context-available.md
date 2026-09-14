---
"@apifuse/provider-sdk": minor
---

Add `OcrContext.available: boolean`, the SDK's own verdict on whether a
configured OCR backend is wired in. Clients built by `createOcrClientFromEnv`
for a configured backend report `true`; `createUnsupportedOcrClient` and the
other error clients report `false`. Providers that branch on OCR presence (for
example, to decide whether a CAPTCHA field is required) read `ctx.ocr.available`
instead of probing the engine-owned `APIFUSE__OCR__*` /
`APIFUSE__CLOUDFLARE__ACCOUNT_ID` names through `process.env`, which the
runtime-boundary lint reports.

`available` is an own enumerable data property on every SDK-built client and is
preserved by `bindOcrTelemetry` and `wrapWithInstrumentation`. `true` means a
backend is configured, not that a call will succeed; the `OCR_UNAVAILABLE` /
`UNSUPPORTED_OCR_BACKEND` error path is unchanged.

Custom `OcrContext` overrides (`serve({ ocr })`, `createFlowContext({ ocr })`,
`createTestContext`-style doubles) must now set `available` explicitly; the
required member is a compile-time change only for code that implements the
interface by hand.
