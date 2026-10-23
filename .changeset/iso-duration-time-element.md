---
"@apifuse/provider-sdk": patch
---

Reject ISO 8601 durations whose time part is empty, such as `P0DT` or `P1DT`.

The shared duration check behind `defineProvider`, `defineSmsOtpMatcher`, and `every()` accepted a trailing `T` with no hour, minute, or second element. ISO 8601 requires at least one time element after `T`, so these values now fail with the existing `must be an ISO 8601 duration` error. Every complete duration that passed before, such as `PT15M`, `P1DT2H`, `PT0S`, and `P1D`, still passes. This applies to `smsOtpMatchers` (`maxAge`, `waitTimeout`, `clockSkew`), `healthJourneys` (`schedule.interval`, `schedule.jitter`, `schedule.randomize`, `manualTrigger.minManualInterval`, `timeout`, `cooldown`), and `healthAccounts` (`wait.timeout`, `wait.rationale.measuredOtpValidity`, `otp[].maxAge`).
