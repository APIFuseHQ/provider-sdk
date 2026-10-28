# ADR-0016: Adaptive proxy vendor selection (per-vendor circuit breaker)

- Status: **Proposed**. The owner asked on 2026-10-28 for the vendor fallback to adopt the intelligent selection widely used elsewhere; the method combination, the value bundle, the failure boundary, the state scope and the operator knob are open owner decisions. The change implements the proposed option of each (below); a different choice is applied on the same branch, and this ADR updated, before the change lands.
- Builds on: ADR-0015 (smartproxy gateway sessions), which introduced the vendor selector seam (`ProxyVendorSelector`, `staticOrderProxyVendorSelector`, `PROXY_ATTEMPTS_PER_VENDOR`) on the same branch stack.
- Extends: ADR-0001 consequence "The vendor gateway becomes an availability dependency for native egress. Mitigated by the existing ordered vendor fallback chain" from a fixed order to a learned one.

## Context

A provider policy declares `providers: [...]` as an ordered vendor chain. Until
now the chain was walked in a fixed order on every request: the primary vendor
received its share of the attempt budget (the first six slots of a pool before
the pool removal, three attempts after it) and only then did the fallback
vendor get a turn. When the primary vendor is down, every request pays that
share again. On 2026-10-26 a KR dining provider saw six consecutive
"tunnel closed immediately" failures on the primary vendor in 0.44 to 0.46 s
each before its seventh attempt succeeded on the fallback in under a second;
with a stale primary that cost repeats on every request.

The owner's direction, verbatim: 「provider 폴백도 좀 지능형으로 많이 사용하는
방식을 차용해줘」. The widely used shapes were compared (Envoy outlier
detection and priority levels, resilience4j, Polly, Hystrix and Finagle
circuit breakers, Finagle P2C and peak-EWMA balancing, the AWS SDK and
Google SRE retry budgets, Envoy active health checking, hedged requests from
"The Tail at Scale" and gRPC hedging). Two facts of this runtime decide the
fit: there are two vendors, so statistical outlier detection and
power-of-two-choices degenerate, and the per-provider request rate is about
one per minute, so every rate-over-window trigger (100 calls for
resilience4j and Polly, 20 calls in 10 s for Hystrix) never accumulates
enough calls to fire. A consecutive-failure trigger does fire on the
observed incident shape.

## Decision

1. **A per-vendor circuit breaker is the selection method.** The policy's
   `providers` order stays the preference order and the static even split of
   the attempt budget stays the baseline; the breaker only removes vendors
   from that baseline. A vendor is *opened* after a run of consecutive
   attempts whose failure is attributable to it, is skipped while open, is
   *probed* by exactly one attempt once its open period elapses, and is
   *closed* again when the probe succeeds or opened for longer when it
   fails; only the outcome of the request that carries the probe (its
   `requestId`) settles it. When every vendor is open the selector fails open
   and the declared order is used as is, and an open or probing vendor stays
   at the end of the directive list as a last-resort resolution fallback, so
   a vendor that cannot synthesize a proxy never leaves a request without a
   vendor the static order would have used. Within one request, an attempt whose predecessor
   failed because of its vendor moves to another closed vendor instead of
   repeating that vendor below the threshold (the retry host predicate shape
   of Envoy, which reattempts host selection when an already attempted host
   is selected); its session index is `attemptCap + attempt`, past every
   static share, so it never re-uses a session an earlier attempt of the
   request used. Latency-weighted choice among healthy vendors is not
   adopted: the declared order carries anti-bot and cost meaning that a
   latency comparison would override, and the request rate is too low for a
   moving average to be meaningful. Hedged requests and active health
   checks are not adopted: both add paid requests, hedging cannot be
   expressed by the selector seam (directives are tried one at a time) and
   is unsafe for the non-idempotent operations providers run, and the
   half-open probe already detects recovery from real traffic.

2. **Values follow Envoy outlier detection and Finagle failure accrual.**
   Open after 5 consecutive vendor failures; open for 30 s multiplied by the
   number of consecutive ejections, capped at 300 s; the multiplier decays by
   one every 10 s while the vendor is closed; one probe at a time, with a
   30 s probe timeout so an attempt that never reports cannot block probing.
   Every value is an option of `createAdaptiveProxyVendorSelector`; the
   defaults are `ADAPTIVE_PROXY_VENDOR_SELECTOR_DEFAULTS`.

3. **The vendor-failure boundary is explicit.** `classifyProxyVendorAttemptOutcome`
   counts against the vendor: a resolution failure other than a configuration
   skip (`no_credentials`, `protocol_unsupported`), `proxy_connect_failed`,
   `PROXY_POOL_STALE`, `PROXY_EDGE_AUTH_REJECTED`, `PROXY_EDGE_TLS_REJECTED`,
   `PROXY_AUTH_IP_DENIED` (every endpoint of that vendor refuses the same
   egress IP, so routing around the vendor is right even though the cause is
   configuration) and `transport_network_error` through a proxy (with raw
   CONNECT the socket the transport sees is the proxy's). It never counts
   cancellation, `transport_timeout` (per-attempt timeouts are sized for
   legitimately slow origins) or a delivered upstream status of any value.

4. **State is process-local.** Every library compared keeps breaker state in
   the process; provider deployments run one replica (at most three under
   autoscaling), so the cost of per-process learning is at most two extra
   wasted requests per additional replica. A process starts closed, that is,
   on the declared order.

5. **Served processes run the adaptive selector; the static order is the
   rollback.** `serve()` registers it through
   `installProcessProxyVendorSelector`, one selector per process shared by
   every server and released when the last of them closes.
   `APIFUSE__PROXY__VENDOR_SELECTION` (`ordered` | `adaptive`, parsed by
   `resolveProxyVendorSelectionMode`, default
   `DEFAULT_PROXY_VENDOR_SELECTION_MODE` = `adaptive`) is the operator switch:
   `ordered` keeps the static declaration order. A selector the host
   registered with `setProxyVendorSelector` is never replaced. There is no
   policy field, so no provider policy changes.

6. **Observation is additive.** The selector exposes `snapshot()` and an
   `onTransition` hook. The server logs one `proxy_vendor_state` line per
   state transition (`warn` when a vendor is opened) with the vendor, the
   from and to states, the reason (`failure_threshold`, `open_elapsed`,
   `probe_succeeded`, `probe_failed`, `probe_timed_out`), the failure streak,
   the ejection count, the end of the open period and the error code that
   opened it. Each selection is tied to the request that asked for it
   (`observeProxyVendorSelections`), and the request's proxy telemetry gains
   `selection` (`{ kind, reason }` with reason `chain_order`, `vendor_open`,
   `half_open_probe`, `all_open` or `retry_alternate`), `vendorStates` (`[{ v, s, e }]`: vendor,
   state, consecutive ejections) and the vendor `v` of every attempt sample,
   in the log and in the telemetry header, without changing the envelope
   version. The gateway ignores unknown keys; persisting any of them is a
   separate gateway change.

## Consequences

Positive:

- A dead primary vendor costs each process a bounded number of attempts
  (the threshold) instead of a share of every request's budget, and the
  first attempt of later requests goes straight to the fallback.
- Recovery is detected from real traffic by a single probe; no paid health
  checks.
- The static selector remains in the tree as the default and the rollback,
  so the change is reversible by one environment variable.

Negative / accepted risks:

- Attribution is heuristic for `transport_network_error`: an origin that
  resets connections could open a healthy vendor. The breaker fails open
  when every vendor is open, so the worst case is the declared order, that
  is, today's behaviour.
- Per-process state means replicas learn separately and a restart forgets.
- A single vendor failure below the threshold still costs the request one
  attempt before it moves to the next vendor, and the alternation reads only
  the request's previous attempt.

## Rejected alternatives

- **Rate-over-window triggers (resilience4j, Polly, Hystrix defaults)**: never
  reach their minimum call counts at one request per minute.
- **Latency-weighted or P2C choice among healthy vendors**: overrides the
  declared preference; degenerates with two vendors and no concurrent load.
- **Hedged requests**: duplicate non-idempotent operations at anti-bot
  origins, add paid traffic, and need a transport that issues attempts in
  parallel.
- **Active health checks**: paid probe traffic from every pod with no free
  endpoint to probe; passive detection plus the half-open probe suffices.
- **Shared (Redis) breaker state**: reintroduces an external dependency the
  gateway-session change just removed, for a gain bounded by the replica
  count.
