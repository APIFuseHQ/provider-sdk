# ADR: Native TCP/TLS egress through a SOCKS5 gateway proxy

- Status: accepted
- Date: 2026-07-30
- Deciders: Taehoon (owner), Soju (agent)
- Scope: `@apifuse/provider-sdk` native network capability (`ctx.native.network`), first consumer `APIFuseHQ/apifuse-provider-kakaotalk`

> **Status note (2026-07-31):** ADR 0003 supersedes the SOCKS5-only and
> gateway-only parts of this decision. Native transport now selects HTTP CONNECT
> or SOCKS5 per vendor, and smartproxy participates through its allocation API.
> The affinity, expiry, drain, No-MITM, and provider-owned port-selection
> decisions here remain in force.

## Context

`ctx.native.network.connectTcp/connectTls` opens raw sockets straight from the provider pod (`node:net` / `node:tls`). Unlike `ctx.http` and `ctx.stealth`, the native contract has no proxy concept at all: `NativeNetworkConnectInput` carries only `host`, `port`, `serverName`, `rejectUnauthorized`, `timeoutMs`, `signal`.

Consequence in production: every stateful KakaoTalk LOCO session leaves through the single cluster NAT egress IP. One external IP for all accounts is a rate-limit and reputation bottleneck as account count grows.

Constraints discovered while deciding:

- Vendor `smartproxy` (api.smartproxy.org — our vendor, NOT the smartproxy.com company that rebranded to Decodo) supports both an IP-extraction API and a username-authenticated gateway, over HTTP **and SOCKS5**.
- Vendor `nodemaven` is gateway-only with sticky sessions up to 24h, sid encoded in the username. The SDK already implements exactly this shape in `src/runtime/proxy-nodemaven.ts` (deterministic sid derived from the affinity key).
- LOCO treats session relocation as a normal event: `protocol/session.ts` already models `{ status: "reconnect_required", reason: "changesvr" }`, and connection setup is a 3-step BOOKING → CHECKIN → LOGINLIST dance where CHECKIN hands back a fresh session host/port every time.
- The existing extraction path is slow and wasteful by design: `SMARTPROXY_EXTRACTION_CACHE_TTL_MS = 15_000` discards a 20-IP batch after 15s (because a raw `ip:port` is not a real lease), and cold paths serialize behind a distributed lock (`SMARTPROXY_LOCK_POLL_MAX_MS = 9_000`) plus up to 3 allocator attempts.

## Decision

1. **Add SOCKS5 proxy support to the native network contract.** Native connects resolve a proxy per the provider's existing `ProviderProxyPolicy`, perform a SOCKS5 handshake, and return a socket; TLS is negotiated on top of the tunnelled socket. SOCKS5 (not HTTP CONNECT) because arbitrary destination ports are native to the protocol and LOCO ports are not fixed to 443.

2. **Use the gateway vendor path, not IP extraction.** Compose `socks5://<user-with-session-params>:<pass>@<gateway>:<port>` and let the vendor own the session→IP mapping. This removes the allocator round trip, the 15s cache, the distributed lock, and the discarded-IP waste; it also maximizes the chance that a reconnect lands on the same IP, because the sid is deterministic.

3. **Sticky affinity is keyed on the credential (account), derived automatically.** `affinity: "connection"` semantics: one account maps to one sticky sid, so an account keeps one residential IP across reconnects. Providers may override the key explicitly for special cases.

4. **Rotating residential + sticky sessions is the product tier.** IP changes are acceptable for LOCO: the protocol itself relocates sessions (`changesvr`), and real KakaoTalk clients change IP on every LTE↔WiFi switch. What must be avoided is a mid-connection IP switch, not a clean reconnect on a new IP. A policy switch to static/long-acting IPs stays available if observed `kicked_out` or auth-failure rates rise after reconnects.

5. **Graceful reconnect is a first-class contract: SDK signals, provider drains.** The SDK knows the sticky expiry (it composed the session), the provider knows when it is safe to cut (in-flight packets, write-ledger state). Therefore the SDK emits an `expiring` event a provider-declared lead time before hard expiry, awaits the provider's `drain()`, and force-closes at hard expiry as a fail-safe. Lead time is declared by the provider in its proxy policy, not hardcoded in the SDK.

6. **Scope is the native path only.** `ctx.http` / `ctx.stealth` keep using the extraction allocator. Their performance debt is real but migrating them would require redesigning proxy-aware retry and pool-rotation semantics; that is a separate change.

## Consequences

Positive:

- Per-account residential egress IPs; the single-NAT rate-limit ceiling is removed for native providers.
- No allocator round trip, no lock serialization, no discarded IPs on the native path.
- Reconnect-on-expiry becomes an explicit, testable contract instead of an unhandled socket death.
- The gateway model already has a working reference in the SDK (`proxy-nodemaven.ts`), so the vendor abstraction stays uniform and a vendor fallback chain still works.

Negative / accepted risks:

- The vendor gateway becomes an availability dependency for native egress. Mitigated by the existing ordered vendor fallback chain and by LOCO's tolerance for reconnects.
- Sticky duration is bounded by the upstream ISP; a long-lived session WILL be interrupted eventually. This is exactly what the drain contract exists to absorb.
- KakaoTalk's actual tolerance for IP changes is not documented by the vendor; it is inferred from protocol behavior and real-client patterns. Observability on post-reconnect `kicked_out` / auth failures is required, and decision 4's fallback exists for that reason.
- Two proxy resolution models now coexist in the SDK (extraction for http/stealth, gateway for native) until the separate migration happens.

## Rejected alternatives

- **HTTP CONNECT tunnel instead of SOCKS5** — gateways commonly restrict CONNECT to 443, and LOCO ports vary. SOCKS5 removes the uncertainty.
- **IP-extraction API for the native path** — reuses existing code but keeps the 15s TTL, the lock, and random IP reassignment on refresh, which breaks account↔IP stability.
- **Pod-level transparent proxy (sidecar + iptables)** — zero SDK change, but adds infra complexity and entangles the sidecar lifecycle with stateful owner fencing and session IP stability.
- **Provider-owned expiry timers** — duplicated in every native provider, and the expiry instant is SDK-side knowledge.
- **A hard cap on concurrent sticky sessions** — considered while mistakenly reading `SMARTPROXY_MAX_POOL_SIZE = 20` as a vendor limit. It is only the `num=` batch size of the extraction request; real limits are the plan's concurrency tier. Cap dropped.
