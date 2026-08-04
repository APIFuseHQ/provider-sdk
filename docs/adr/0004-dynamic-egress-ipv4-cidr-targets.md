# ADR: Explicit IPv4 CIDR targets for dynamic native egress

- Status: accepted
- Date: 2026-08-04
- Deciders: Taehoon (owner), Soju (agent)
- Scope: `@apifuse/provider-sdk` native dynamic TCP egress declarations and grants
- Builds on: `0001-native-socks5-gateway-proxy.md`, `0002-structural-gates-for-contract-integrity.md`, `0003-native-gateway-credential-injection-and-http-connect.md`

## Context

Stateful providers can discover their session endpoint only after contacting a declared bootstrap endpoint. KakaoTalk LOCO is the first concrete case: CHECKIN returns both DNS names and raw IPv4 literals, and later session endpoints can also be IPv4 literals on non-HTTP ports.

Dynamic native egress rules previously selected grant targets only through `targetHostSuffixes`. An IPv4 literal is not a DNS name and therefore cannot safely match a DNS suffix. Providers were left with two bad choices: fail closed and make the discovered session unreachable, or over-declare carrier-wide static ranges that are broader than the vendor-owned destinations the provider actually needs.

## Decision

Add `targetIpv4Cidrs` as an explicit target selector on native dynamic TCP egress rules.

- IPv4-literal grant targets match only `targetIpv4Cidrs`.
- DNS-name grant targets match only `targetHostSuffixes`.
- A dynamic rule must declare at least one non-empty target selector list.
- CIDRs use exact IPv4 `a.b.c.d/nn` syntax with prefix lengths from 0 through 32. Declarations must use the canonical network address; host bits are rejected rather than silently normalized.
- Malformed and duplicate CIDRs invalidate the native egress policy. Validation and matching fail closed.

This keeps address-family authorization explicit. IPv6 can be added later under a distinct selector without changing the meaning of the IPv4 field.

## Consequences

Positive:

- Providers can authorize bootstrap-discovered IPv4 session hosts without pretending they are DNS names.
- IP and DNS selectors cannot accidentally widen one another: literals never fall through to suffix matching, and names never match CIDRs.
- Canonical-network validation exposes declaration typos before a provider attempts a grant.
- Grants remain bounded by the rule's existing source host and source port selectors, target ports, TLS mode, `ttlMs`, and `maxGrants`.

Negative / accepted:

- Providers must pin vendor-owned IPv4 ranges verified against RIR and BGP data, and maintain those declarations as vendor routing changes.
- A valid vendor endpoint outside the maintained ranges fails closed until the provider declaration is updated.
- IPv6-literal endpoints remain unsupported by this selector.

## Rejected alternatives

- **Trust the bootstrap endpoint.** Allow any IP returned through a grant whose `sourceHost` is declared. This is a wider trust delegation: compromise or unexpected behavior at the bootstrap layer could authorize destinations with no provider-pinned ownership boundary. It may be layered later as a separate, explicit decision, but is not implied by this CIDR selector.
