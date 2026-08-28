---
"@apifuse/provider-sdk": minor
---

`ProxyTelemetryLogPayload`를 `kind` 필드로 구분되는 `ProxyTelemetryResolvedPayload`와 `ProxyTelemetryUnresolvedPayload` 유니온으로 변경합니다. 내부 resolution 이벤트의 optional `outcome` marker는 값이 없을 때 `"ok"`로 처리되며, allocator 실패는 `"error"`로 기록됩니다.

성공한 resolution 이벤트가 하나라도 있으면 마지막 성공 공급자를 `kind: "resolved"`의 serving `provider`로 사용하고 모든 이벤트의 집계값을 유지합니다. 성공 이벤트 없이 공급자가 건너뛰어졌거나 allocator가 실패한 경우에는 `kind: "unresolved"`가 failover trail과 실패 진단 정보를 담아 `provider_request_completed` 및 `provider_request_failed` 로그와 `X-ApiFuse-Provider-Telemetry` 헤더에 동일한 payload로 전달됩니다. 따라서 direct egress로 계속 진행하거나 요청이 실패한 경우에도 실패한 공급자가 요청을 처리한 것처럼 표시되지 않습니다.
