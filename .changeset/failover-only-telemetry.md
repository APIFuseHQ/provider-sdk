---
"@apifuse/provider-sdk": minor
---

`ProxyTelemetryLogPayload`를 `kind` 필드로 구분되는 `ProxyTelemetryResolvedPayload`와 `ProxyTelemetryFailoverOnlyPayload` 유니온으로 변경합니다.

프록시 공급자가 자격 증명 검사 등에서 모두 건너뛰어져 resolution 이벤트가 없는 경우에도 failover-only 결정이 `provider_request_completed` 및 `provider_request_failed` 로그와 `X-ApiFuse-Provider-Telemetry` 헤더에 동일한 payload로 전달됩니다.
