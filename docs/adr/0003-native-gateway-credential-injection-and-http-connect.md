# ADR: Native gateway vendors take injected credentials and support HTTP CONNECT

- Status: accepted
- Date: 2026-07-31
- Deciders: Taehoon (owner), Soju (agent)
- Scope: `@apifuse/provider-sdk` native network transport — gateway vendor resolution and tunnelling protocol
- Builds on: `0001-native-socks5-gateway-proxy.md`, `0002-structural-gates-for-contract-integrity.md`

## Context

The native transport landed with a single vendor adapter and a single tunnelling protocol:

```ts
const DEFAULT_GATEWAY_SYNTHESIZERS: readonly NativeGatewayProxySynthesizer[] = [
	synthesizeNodemavenGateway,
];

function synthesizeNodemavenGateway(input: NativeGatewayProxySynthesisInput) {
	if (input.vendor !== "nodemaven" || !hasNodemavenCredentials()) return undefined;
	// ... protocol: "socks5"
}
```

`NativeGatewayProxySynthesisInput` is `{ vendor, policy, affinityKey?, now }` — it declares no credential input, yet `hasNodemavenCredentials()` reads `process.env` directly (`src/runtime/proxy-nodemaven.ts`). Two facts measured against a live KakaoTalk account on 2026-07-31 turned these choices from acceptable defaults into blockers.

### Fact 1 — SOCKS5 cannot reach the destination ports this transport exists to reach

Kakao's own `GETCONF` response advertises the CHECKIN port list (identical for `wifi` and `3g`):

```
ports: [995, 8080, 5223, 5228, 9282, 5242, 10009]
```

Measured through the vendors, with fake-success filtering (see Fact 3):

| destination | nodemaven SOCKS5 | nodemaven HTTP CONNECT | smartproxy HTTP CONNECT |
| --- | --- | --- | --- |
| `booking-loco.kakao.com:443` | `0x00` + TLSv1.3 handshake | 200 + TLSv1.3 handshake | 200 + TLSv1.3 handshake |
| CHECKIN `:995` | `0x0a` | timeout | 614 fake-OK, closed |
| CHECKIN `:8080` | `0x0a` | **usable** | **usable** |
| CHECKIN `:5223` | `0x0a` | timeout | **usable** |
| CHECKIN `:5228` | `0x0a` | **usable** | **usable** |
| CHECKIN `:9282`, `:5242`, `:10009` | `0x0a` | timeout | 614 fake-OK, closed |

The comment at `synthesizeNodemavenGateway` reads: *"Native LOCO ... must reach arbitrary destination ports, so SOCKS5 is mandatory here."* The measurement inverts it: SOCKS5 reaches **none** of the seven advertised CHECKIN ports, while HTTP CONNECT reaches two on nodemaven and three on smartproxy. The premise was reasonable (SOCKS5 is the more general tunnel) but is false for these vendors' actual rulesets.

### Fact 2 — a declared vendor chain is silently ignored for native

`resolveNativeGatewayProxy` iterates the policy's vendor chain, but the only default synthesizer returns `undefined` for every vendor except `nodemaven`. A provider declaring `providers: ["smartproxy", "nodemaven"]` therefore gets nodemaven with no diagnostic — the declaration is accepted, type-checks, and does nothing. This is the ADR-0002 failure class (a green surface that does not do what it says) reappearing one layer up.

### Fact 3 — vendors can report success for a connection they refused

smartproxy answered `HTTP/1.1 614 OK` for CONNECT to CHECKIN `:995` **and** to `example.com:9` (discard). `614` is not an HTTP status code and `OK` was false: both tunnels reported `closed_by_peer` when byte flow was tested, while genuinely working ports returned `200` and completed a TLSv1.3 handshake with `peer_cn=*.kakao.com`. Any vendor adapter that treats a proxy's self-reported status as success will report a working tunnel that carries no traffic.

### Fact 4 — the ambient-env dependency has a concrete cost

The same SDK already injects environment access where it validates provider secrets:

```ts
listMissingRequiredSecrets(provider: ProviderDefinition, env: EnvContext)
```

Native proxy synthesis is the outlier. Consequences observed or structurally implied:

1. **Hidden input.** The type says the function is a pure mapping from `(vendor, policy, affinityKey, now)`; the behaviour depends on process-global state.
2. **Cause loss.** "No credentials" and "wrong vendor" both return `undefined`, collapsing into one `PROXY_REQUIRED` with no indication of which env names were missing. This is the same diagnostic defect `native_connection_failed` had (fixed in #99), one layer up.
3. **No per-tenant credentials.** A process has one environment. The transport's whole purpose is per-account egress identity via `affinityKey`, yet vendor credentials are necessarily global — the isolation model is half-implemented.
4. **Rotation requires a restart.** With Proton Pass / Doppler as the secret source of truth, an ambient-env requirement means a rotated credential does not reach an already-running process.
5. **Delegated execution is blocked.** During this session a subprocess could not read the vendor secrets from Doppler, so the live verification could not run at all. With credentials as an explicit argument, any caller that can obtain them by any means could have supplied them.

## Decision

### 1. Vendor credentials become an injected, explicit input

Extend `NativeGatewayProxySynthesisInput` with a credential resolver rather than reading `process.env` inside adapters:

```ts
type VendorCredentialLookup =
	| { readonly kind: "present"; readonly values: Readonly<Record<string, string>> }
	| { readonly kind: "absent"; readonly missing: readonly string[] };

type NativeGatewayProxySynthesisInput = {
	readonly vendor: ProviderProxyProvider;
	readonly policy: ProviderProxyPolicy;
	readonly affinityKey?: string;
	readonly now: number;
	readonly credentials: (vendor: ProviderProxyProvider) => VendorCredentialLookup;
};
```

- The SDK ships a default resolver backed by the existing `EnvContext` path, so current behaviour is preserved for every caller that supplies nothing.
- `absent` carries the missing variable names, so `PROXY_REQUIRED` can state which vendor was skipped and why instead of reporting an empty outcome.
- Adapters become deterministic functions of their inputs, which makes them testable without mutating `process.env` and makes per-tenant credentials expressible.

### 2. Native gains an HTTP CONNECT tunnel alongside SOCKS5

Implement HTTP CONNECT tunnelling for native TCP/TLS connects and select the protocol per vendor rather than hardcoding SOCKS5. Requirements:

- A `2xx` CONNECT response is **not** sufficient. The adapter must not treat a non-200 status as success, and the transport must surface the CONNECT status/SOCKS reply code in the error cause (the mechanism added in #99) so a refused port is diagnosable.
- The No-MITM invariant still holds: `assertTunnelingScheme` already restricts resolved URLs to `http` (CONNECT) or `socks5`, both of which pass bytes end-to-end, so the client TLS handshake continues to terminate at the origin. This decision does not introduce interception.
- SOCKS5 remains supported and remains correct for destinations where a vendor permits it. This is protocol *selection*, not replacement.

### 3. smartproxy becomes a first-class native vendor, and the chain becomes real

Add a smartproxy native adapter and register it in the default chain, so a declared `providers: [...]` order is honoured for native connects. A vendor that cannot serve a request (absent credentials, unsupported protocol, allocation failure) must be skipped **with a recorded reason**, and when the whole chain is exhausted the resulting `PROXY_REQUIRED` must name each vendor and why it was skipped.

### 4. Port selection stays with the provider

The SDK does not learn Kakao's port list. Walking `GETCONF`-advertised ports is provider logic (kakaotalk PR #9); the SDK's obligation is to make each attempt possible and each failure legible. Declared-egress enforcement (#93) continues to gate every attempt and is not loosened.

## Consequences

Positive:

- The only measured working native path (HTTP CONNECT to `:8080` / `:5228`, and `:5223` on smartproxy) becomes reachable; today it is not.
- A declared vendor chain does what it says, and its failures name the vendor and reason.
- Vendor credentials can come from any source the caller can reach — Proton Pass, Doppler, a vault, a test fixture — which unblocks delegated and CI verification.
- Adapters become unit-testable without process-global mutation, and per-tenant vendor credentials become possible.

Negative / accepted:

- `NativeGatewayProxySynthesisInput` and `gatewaySynthesizers` are public, so adding a required field is a breaking change for any external adapter author. Mitigation: land this together with the smartproxy adapter (which requires touching the same surface) so implementors absorb one break rather than two, and default the resolver so callers who pass no synthesizers see no change.
- Two tunnelling protocols mean two code paths for connect, cancellation, and idle semantics. Mitigation: this is exactly what ADR 0002 §3's conformance suite is for — both paths must pass one shared behavioural suite.
- The ADR-0001 title ("native SOCKS5 gateway proxy") becomes partly inaccurate. It should be annotated to point here rather than silently left as the apparent contract.

## Rejected alternatives

- **Keep SOCKS5 only and ask vendors to open the ports.** Depends on two third parties, with no timeline, while a working transport already exists on ports both vendors permit.
- **Keep reading `process.env` and add a smartproxy adapter that also reads it.** Cheapest, and reproduces every defect in Fact 4 in a second place — including the diagnostic gap that cost multiple hours of manual isolation this session.
- **Move port selection into the SDK.** The port list is upstream-specific and arrives in a provider-specific response; encoding it in the SDK would put Kakao knowledge in a vendor-neutral layer.
