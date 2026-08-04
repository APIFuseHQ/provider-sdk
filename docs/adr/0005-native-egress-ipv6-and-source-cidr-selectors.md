# ADR: Native egress IPv6 and source CIDR selectors

- Status: accepted
- Date: 2026-08-04
- Deciders: Taehoon (owner), Soju (agent)
- Scope: `@apifuse/provider-sdk` native dynamic TCP egress declarations, grants, and dial sinks
- Builds on: `0004-dynamic-egress-ipv4-cidr-targets.md`

## Context

ADR 0004 intentionally shipped dynamic target CIDRs for IPv4 only. The first real consumer, KakaoTalk LOCO, demonstrates that the address-family scope was too narrow. Its measured live `GETCONF` response declares both families:

```json
{
  "statusCode": 0,
  "ticket": {
    "lsl": [
      "ticket-loco.kakao.com",
      "211.183.222.6",
      "211.183.211.10",
      "121.53.93.47"
    ],
    "lsl6": [
      "ticket-loco.kakao.com",
      "2404:4600:9:2dc::228",
      "2404:4600:6:4e5::7f"
    ]
  },
  "wifi": {
    "ports": [5228, 9282, 5242, 10009, 995, 8080, 5223],
    "encType": 2
  }
}
```

Two independent gaps prevent the shipped selector from representing this flow:

1. A valid IPv6 literal was classified as numeric-ambiguous and matched no selector, so an advertised `lsl6` endpoint always failed closed.
2. Dynamic rules selected sources only by `sourceHost` and `sourceHostSuffixes`. Grant chaining uses the connected endpoint's host as the next grant's `sourceHost`; when bootstrap selected an advertised IP literal, no DNS suffix could match it.

The compatibility risk is contained. `dynamicTcp` has one consumer across the 19 provider workspaces, `apifuse-sot/kakaotalk`; the other workspaces have no references. The existing `targetIpv4Cidrs` name and semantics remain unchanged.

IPv6 adds one authorization-sensitive distinction. The measured host platform permits both `::ffff:127.0.0.1` and `::ffff:7f00:1` to reach an IPv4 listener bound on `127.0.0.1`. IPv4-mapped and IPv4-compatible IPv6 text therefore cannot safely be treated as ordinary IPv6 authorization even though their syntax parses as 128-bit addresses.

## Decision

### 1. Dynamic rules expose four family-specific CIDR selectors

`NativeTcpDynamicEgressRule` supports:

```ts
readonly targetIpv4Cidrs?: readonly string[];
readonly targetIpv6Cidrs?: readonly string[];
readonly sourceIpv4Cidrs?: readonly string[];
readonly sourceIpv6Cidrs?: readonly string[];
```

A target rule must declare at least one non-empty list across `targetHostSuffixes`, `targetIpv4Cidrs`, and `targetIpv6Cidrs`. A source matches when any declared exact host, DNS suffix, IPv4 CIDR, or IPv6 CIDR selector matches. A rule with no source selector remains invalid and therefore cannot match.

Matching is family-disjoint:

| Classified host | CIDR/suffix selector that may authorize it |
| --- | --- |
| canonical IPv4 literal | corresponding `Ipv4Cidrs` only |
| ordinary IPv6 literal | corresponding `Ipv6Cidrs` only |
| IPv4-mapped or IPv4-compatible IPv6 literal | corresponding `Ipv4Cidrs` only |
| DNS name | host/suffix selectors only |
| numeric-ambiguous input | none |

Exact `sourceHost` remains an exact canonical match for DNS names and canonical IPv4 or IPv6 literals. Resolver-numeric forms and malformed colon-bearing forms are numeric-ambiguous and are rejected at the declaration boundary; reserved delimiters, percent escapes, format controls, and zone IDs remain rejected at the canonical input boundary.

### 2. Mapped and compatible IPv4 space requires explicit IPv4 authority

At classification time, `::ffff:0:0/96` is IPv4-mapped. `::/96` is IPv4-compatible except for `::` and `::1`, which remain ordinary IPv6 addresses. A mapped or compatible literal is parsed to its 128-bit value, its embedded final 32 bits are extracted, and only an IPv4 selector may authorize it. No IPv6 CIDR may authorize a socket operation that reaches IPv4.

IPv6 CIDR declarations that overlap `::ffff:0:0/96` or the compatible range from `::2` through `::ffff:ffff` are rejected. This includes a range such as `::/0` that contains either space. Rejection names the overlap instead of silently normalizing or relying on runtime precedence.

`64:ff9b::/96` (NAT64) and `2002::/16` (6to4) are deliberately ordinary IPv6. They encode IPv4 information, but the local socket still performs an IPv6 dial; the measured NAT64 example produced `ECONNREFUSED` without a local translator rather than reaching the IPv4 listener. Their routing semantics belong to the network, so an explicit IPv6 CIDR is the correct authority.

### 3. One shared parser owns declaration and runtime grammar

The internal parser moves from `src/native-ipv4.ts` to `src/native-address.ts`; the old path was not a package export. It owns strict IPv4, RFC 4291 IPv6, both CIDR grammars, byte/bit CIDR matching, RFC 5952 formatting, reserved delimiters, host canonicalization, mapped/compatible detection, and the single five-way classifier.

IPv6 matching always uses the parsed 16 bytes. Compressed, expanded, uppercase, and dotted-quad-tail spellings therefore have one authorization identity. IPv6 network declarations require a prefix from 0 through 128 without leading zeroes and a canonical network with no host bits set.

Zone IDs contain `%` and stay rejected as reserved-delimiter inputs. Brackets are URI authority syntax rather than address syntax and also stay rejected at host input boundaries.

### 4. Authorization identity and dial identity share canonical text

Every valid IPv6 input is formatted from its parsed bytes as lowercase RFC 5952 text: no leading group zeroes and the first longest run of at least two zero groups compressed once. Grant storage and connection lookup use this form, so equivalent input spellings share a grant.

Direct TCP, the SOCKS5 destination, and default TLS SNI receive the unbracketed canonical host. HTTP CONNECT request-target and `Host` authorities receive the same canonical host in brackets. No caller-supplied non-canonical spelling reaches a transport sink.

### 5. Numeric-ambiguous declarations fail at both policy and match boundaries

Every declared exact host and DNS suffix is classified after canonicalization. A `numeric-ambiguous` static `host`, exact `sourceHost`, `sourceHostSuffixes` entry, or `targetHostSuffixes` entry makes policy construction fail with `native_egress_policy_invalid`; the diagnostic names the field path and only the safe `numeric-ambiguous` classification. Suffix lists additionally reject canonical IPv4 and IPv6 literals because an address literal is not a DNS suffix. Exact `sourceHost` continues to accept canonical literals of either family.

The source matcher independently classifies its incoming host before any exact-string comparison and returns false for `numeric-ambiguous`. This guard does not rely on the current policy parser, so a future internal snapshot construction path cannot restore exact-match authority by skipping declaration validation. `canonicalizeEgressHost` still returns numeric-ambiguous spellings unchanged: preserving their spelling is what prevents resolver normalization from widening them into canonical IPv4 with CIDR authority.

The defect was measured both on this PR's pre-fix head and on `origin/main`, where declaring and granting the same spelling produced:

| Declared and granted `sourceHost` | Policy | Grant | Resolver observation |
| --- | --- | --- | --- |
| `2130706433` | accepted | granted | `dns.lookup` resolved to `127.0.0.1` |
| `0177.0.0.1` | accepted | granted | `dns.lookup` resolved to `127.0.0.1` |
| `127.1` | accepted | granted | `dns.lookup` resolved to `127.0.0.1` |
| `0x7f.0.0.1` | accepted | granted | `dns.lookup` resolved to `127.0.0.1` |
| `1.2.3.04` | accepted | granted | `dns.lookup` resolved to `1.2.3.4` |
| `2404::4600::1` | accepted | granted | malformed IPv6; `ENOTFOUND` |
| `12345::1` | accepted | granted | malformed IPv6; `ENOTFOUND` |

The scope is narrow but fail-open relative to the declared invariant that numeric-ambiguous input matches no selector. The operator had to write the ambiguous spelling into policy; an undeclared ambiguous source was refused, and a declaration authorized only the byte-identical spelling, with neither canonical-IP widening nor cross-spelling authority. The target side was unaffected even when all target selector classes were declared. This is therefore an operator footgun rather than a remote-input bypass: a policy value that looks like an address was silently treated as an opaque exact name. The behavior pre-dated this PR on `origin/main`, but this change closes it because the PR establishes family-disjoint source selectors.

## Consequences

Positive:

- Providers can represent every address family advertised by LOCO while retaining fail-closed family boundaries.
- A declared IPv6 range can never grant IPv4 reachability through mapped or compatible syntax.
- Source IP selectors support grant chaining when the bootstrap connection itself used a literal.
- Policy validation, runtime authorization, grant identity, and dial formatting cannot drift across separate parsers.

Negative / accepted:

- Operators must maintain verified vendor ranges for both IPv4 and IPv6 and update either list as routing changes.
- A newly advertised address outside those maintained ranges fails closed.
- Broad IPv6 declarations that overlap mapped or compatible IPv4 space are invalid even if an operator expected runtime matching precedence to exclude that space.
- Zone-scoped link-local addresses and bracketed host inputs are not expressible; callers must supply an unbracketed, scope-free address.

## Rejected alternatives

- **Match IPv6 strings or normalized URL hostnames.** One address has compressed, expanded, uppercase, and dotted-tail spellings. String matching either misses equivalents or requires a second normalization grammar, and URL hostnames add brackets that are not address bytes.
- **Let IPv6 CIDRs authorize mapped addresses and normalize them into IPv4 only at runtime.** This makes a policy that visually grants only IPv6 reach IPv4 and hides the mistake until a connection is attempted. Declaration-time overlap rejection makes the authority boundary explicit.
- **Automatically treat mapped input as IPv4 without rejecting overlapping IPv6 declarations.** Runtime precedence alone leaves misleading, dead portions of declarations and invites future matcher changes to restore the bypass.
- **Special-case NAT64 and 6to4 as IPv4.** Unlike mapped/compatible literals, these remain IPv6 socket destinations and depend on network routing or translation. Reclassifying them would deny an operator's explicit IPv6 authority and conflate address encoding with local socket behavior.
