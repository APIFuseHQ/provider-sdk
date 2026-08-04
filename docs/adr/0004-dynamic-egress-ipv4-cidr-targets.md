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

## Resolver-numeric host forms

Hosts that are not canonical dotted-quad IPv4 but that a resolver may interpret as numeric addresses are rejected outright. They match neither `targetIpv4Cidrs` nor `targetHostSuffixes`; IPv6 literals are likewise rejected until an explicit IPv6 selector exists. Mixed DNS names with non-numeric labels remain DNS names.

This fail-closed classification is based on measured Node `dns.lookup(host, { family: 4 })` behavior on the development host:

| Supplied host | Resolved IPv4 address |
| --- | --- |
| `0211.183.211.10` | `137.183.211.10` |
| `0177.0.0.1` | `127.0.0.1` |
| `011.183.208.5` | `9.183.208.5` |
| `1.2.3.04` | `1.2.3.4` |
| `127.1` | `127.0.0.1` |
| `2130706433` | `127.0.0.1` |
| `0x7f.0.0.1` | `127.0.0.1` |

IPv4 address and CIDR parsing lives in the shared internal `src/native-ipv4.ts` module. Policy validation and runtime authorization therefore use one grammar and one 32-bit conversion implementation and cannot drift independently.

## Resolver-aligned host canonicalization

Egress hosts are canonicalized with Node's `domainToASCII` before policy matching, target classification, and grant storage. This applies the same IDNA/UTS-46 processing used by the resolver, so Unicode spellings cannot be authorized as DNS names and then resolved as numeric addresses. Inputs that cannot be processed as domains fail closed; colon-bearing literals are retained only long enough to be classified and rejected as unsupported numeric targets. Hosts already recognized as resolver-numeric ASCII forms retain that classification instead of being widened into canonical IPv4 CIDR matches by `domainToASCII`.

Measurements on the development host show why normalization must precede classification: `０177.0.0.1`, `１２７.0.0.1`, `２１３０７０６４３３`, and `127．0．0．1` all become `127.0.0.1`; `evil。kakao.com` becomes `evil.kakao.com`; `LOCO.Kakao.COM` becomes `loco.kakao.com`; and `한글.kr` becomes `xn--bj0bj06e.kr`. The invalid Arabic-Indic numeric spelling `١٢٧.0.0.1` produces an empty result and is rejected rather than falling back to the original spelling. Existing canonical ASCII names, punycode names, and numeric-leading DNS labels such as `0211.example.com` remain unchanged.
