---
"@apifuse/provider-sdk": patch
---

Reject zero-length ISO 8601 durations, such as `PT0S` or `P0D`.

The shared duration check behind `defineProvider`, `defineSmsOtpMatcher`, `every()`, `centered()`, and `delayed()` accepted a duration whose every component is zero, while the shorthand path of the same helpers already rejected `0h`. A duration whose every component is zero, such as `PT0S`, `P0D`, `PT0M`, `P0DT0H0M0S`, or `PT0.0S`, now fails with a `must be a positive duration` error. Zero is decided on the written components, so fractions such as `PT0.5S` and `PT0.0001S` still pass, and every nonzero duration that passed before still passes. This applies to `smsOtpMatchers` (`maxAge`, `waitTimeout`, `clockSkew`), `healthJourneys` (`schedule.interval`, `schedule.jitter`, `timeout`, `cooldown`), and `healthAccounts` (`wait.timeout`, `wait.rationale.measuredOtpValidity`, `otp[].maxAge`). `schedule.randomize` and `manualTrigger.minManualInterval` already rejected zero; their zero values now fail in the shared check with the same `must be a positive duration` wording. To declare no jitter or no cooldown, omit the optional field.
