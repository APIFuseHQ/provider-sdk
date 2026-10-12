---
"@apifuse/provider-sdk": minor
---

Allow backward relativeDate offsets. `relativeDate.offsetDays` now admits integers from -365 to 365: a negative offset is that many Asia/Seoul calendar days before the anchor date and `0` is the anchor date, so a read whose window ends today (`start_date` -N, `end_date` 0) can be declared. Every node of one operation is evaluated from the same anchor instant, so a two-node window is well-formed exactly when the start offset is at or below the end offset. The self-test and `fixtures.request` date token gains the same range with a mandatory sign (`-30d`, `+0d`, `-182d:YYYYMMDD`); unsigned or out-of-range strings stay literals. Scenarios that use an offset of 0 or below need a health monitor that admits them (apifuse openspec change `allow-backward-relative-date-offsets`).
