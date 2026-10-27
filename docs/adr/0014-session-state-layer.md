# ADR-0014: Provider-declared session state

- Status: **Accepted**. The owner chose the declaration shape (a named top-level `sessionState` map with a per-request name or `false` override) on 2026-10-27, and on the same day corrected the meaning of `qps` and ruled out a declared pool size.
- Extends: ADR-0008 D9 ("the provider declares site knowledge; the SDK owns detection, solving, cookie mutation and refetch") from challenges to upstream session state in general.

## Context

Providers kept upstream session state by hand. A KR travel provider retried a
stay read once on a new proxy slot when the upstream's edge answered with a
block page, and the October 2026 measurements showed that what made the retry
pass was the edge's bot-management cookie the block page had issued, not the
new exit: cookie-less first requests passed 0 of 51 times, requests carrying the
cookie 35 of 42. The SDK's cookie jar lives for one operation request, so every
call paid the block page again. Other providers carry login session cookies and
token headers by hand in every request.

The owner asked for the infrastructure part to move into the SDK, verbatim:

> cf 토큰을 적절히 배분하고 캐싱하는 레이어를 sdk 레벨 기능으로 … 캐시 기간 지정, QPS같은거 세팅하면, 자동으로 쿠키를 적절히 배분하거나 새 쿠키를 발급받아 쓰는 느낌으로 provider의 비즈니스로직을 최대한 집중하고, 인프라적 기능은 sdk가 처리할수 있게

and, after a first design that was tied to one edge vendor:

> 공통레이어로 만들어야하고, cf 뿐만 아니라 다양한 이런 쿠키 유지 행위를 추상화 할 수 있어야함

> sdk가 cf도 알고 있지만 다양한 솔루션 형상에 대해 인터페이스로 제공할 수 있어야한다

## Decision

1. A provider declares `sessionState: Record<name, ProviderSessionState>` on
   `defineProvider`. A declaration has four parts: `acquire` (from the
   responses of in-scope requests, from a declared request or provider
   function, or from the connection credential, with a `capture` rule),
   `carry` (cookies, a cookie, a cookie header, a header, a query parameter),
   `validity` (`ttl`, `idleTtl`, `maxUses`, upstream expiry, an `invalidWhen`
   judge that is a declarative `ResponseMatcher` or a provider function,
   `reacquire`, `replayMethods`) and `distribute` (`hosts`, `operations`,
   `scope`, `qps`, `maxConcurrent`, `egress`). No common type or field names
   a vendor, a cookie or a status code.
2. Vendor knowledge is a value. `sessionStatePresets.cloudflareBlockPage(...)`
   returns a plain `ProviderSessionState`; a hand-written declaration with the
   same values takes the same code path. The SDK keeps no closed set of
   preset names.
3. Requests select declarations with `sessionState: name | names | false`.
   Auth flows are never in scope. A caller-set header, query parameter or
   `cookie` header wins over the layer.
4. `qps` is the throughput assigned to one state, not a rate limit. A request
   takes the oldest state with room in its share; when none has room the SDK
   acquires another state rather than make the request wait. The pool grows
   to about `request rate / qps` states, has no declared size or upper bound,
   and unused states retire on their own lifetime. Without `qps` one state
   carries every request.
5. Re-sending is automatic only for `replayMethods` (default GET, HEAD,
   OPTIONS, the safe set of ADR-0008 D10). Otherwise the response returns
   classified `replay_required` with a fresh state already in the pool.
6. State from the credential is carried and judged only (`credential_invalid`).
   The SDK cannot hand a renewed credential back to the gateway from inside an
   operation, so renewal stays with `auth.flow.refresh`.
7. Captured values are registered as diagnostic values. Telemetry carries
   counts only (`acquired`, `reused`, `expired`, `invalidated`,
   `reacquired`, `waited`) inside the stealth and http payloads.
8. SDK defaults that await owner values (the preset's re-acquisition count,
   the direct declaration's, the connection-pool cap) live in
   `src/runtime/session-state-defaults.ts` only.

## Consequences

- Provider code keeps one fetch and its own error contract; the retry loop,
  the cookie handling and the header assembly leave provider code.
- Pools are per server process (one registry per `createServerApp`). Sharing
  state across replicas would mean storing state values outside the process
  and is out of scope.
- On `ctx.http` the layer judges the final response, so explicit status-code
  retries do not apply to a request in scope; transport retries do.
- Not yet measured: how long one edge cookie stays valid, how many requests it
  carries, and why about one in six requests carrying it was still refused.
  Provider values for `ttl` and `qps` follow those measurements.
