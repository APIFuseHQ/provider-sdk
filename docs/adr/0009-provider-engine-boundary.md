# ADR-0009 v1.1 amendment: resolver credentials and ceremony leases

- Status: **Proposed (v1.1 amendment)**
- Amendment date: 2026-09-02
- Amends: ADR-0009's engine-owned credential and opaque-session boundaries
- Builds on: ADR-0008 v1.1
- Implementation status: deferred; this amendment is paper-only

ADR-0009 v1.0 already places proxy vendor credentials in the engine and says
stateful lifecycles use opaque engine-owned session handles. Resolver vendor
credentials and an identity-bound challenge ceremony are the same existing
axes, so this is an in-place amendment rather than a new capability ADR. The
accepted v1.0 record is retained verbatim below; this v1.1 amendment remains
Proposed and is not self-ratified by its draft PR.

## v1.1 context

Resolver configuration already reads 2captcha, CapSolver, and CapMonster API
keys from engine/runtime environment variables
([`src/runtime/resolver-config.ts:1-5`](../../src/runtime/resolver-config.ts#L1-L5),
[`src/runtime/resolver.ts:1037-1066`](../../src/runtime/resolver.ts#L1037-L1066),
[`src/runtime/resolver.ts:1089-1147`](../../src/runtime/resolver.ts#L1089-L1147)).
The provider boundary, however, classifies only proxy and telemetry names as
engine-owned ([`src/engine.ts:34-80`](../../src/engine.ts#L34-L80)) and provider
validation rejects only those classes
([`src/define.ts:935-956`](../../src/define.ts#L935-L956)). ZOZOTOWN therefore
declares and reads its Hyper key as provider state
([`index.ts:21-29`](https://github.com/APIFuseHQ/apifuse-provider-zozotown/blob/85fbd652e579eb6e51c5f990e8654b1993609376/index.ts#L21-L29),
[`upstream/sbsd.ts:15,472-477`](https://github.com/APIFuseHQ/apifuse-provider-zozotown/blob/85fbd652e579eb6e51c5f990e8654b1993609376/upstream/sbsd.ts#L472-L477)).

The engine passes common proxy intent to stealth and resolver, but the resolver
calls `resolveProxyConfigAsync` independently
([`src/server/serve-implementation.ts:681-700`](../../src/server/serve-implementation.ts#L681-L700),
[`src/runtime/resolver.ts:824-867`](../../src/runtime/resolver.ts#L824-L867)).
That preserves policy and affinity intent, not the exact endpoint and pool index
selected by the initiating request. NodeMaven derives a deterministic SID from
affinity, refresh epoch, and pool index
([`src/runtime/proxy-nodemaven.ts:109-127`](../../src/runtime/proxy-nodemaven.ts#L109-L127));
Smartproxy extraction is explicitly cached for only 15 seconds because a raw
endpoint is not a hard lease
([`src/config/loader.ts:243-248`](../../src/config/loader.ts#L243-L248)).

ZOZOTOWN filled this boundary itself by carrying a signed descriptor containing
the vendor, pool index, and either the exact Smartproxy endpoint or a NodeMaven
URL fingerprint, then re-binding it on later turns
([`upstream/sbsd.ts:76-84`](https://github.com/APIFuseHQ/apifuse-provider-zozotown/blob/85fbd652e579eb6e51c5f990e8654b1993609376/upstream/sbsd.ts#L76-L84),
[`upstream/sbsd.ts:189-378`](https://github.com/APIFuseHQ/apifuse-provider-zozotown/blob/85fbd652e579eb6e51c5f990e8654b1993609376/upstream/sbsd.ts#L189-L378)).
Those are engine facts and should not need provider signing.

## v1.1 decisions

### Solver credentials are engine-owned

All hosted resolver API keys are engine credentials, the same class as proxy
vendor credentials. The Hyper Solutions key is named exactly:

```text
APIFUSE__RESOLVER__HYPERSOLUTIONS__API_KEY
```

It joins `APIFUSE__RESOLVER__2CAPTCHA__API_KEY`,
`APIFUSE__RESOLVER__CAPSOLVER__API_KEY`, and
`APIFUSE__RESOLVER__CAPMONSTER__API_KEY` in the engine host. These names are
filtered from provider environment projections and rejected from provider
`secrets`, case-insensitively, under the same fail-closed rule ADR-0009 v1.0
applies to proxy credentials. Providers declare resolver kinds and optional
vendor ordering; they do not own, read, forward, or meter solver keys.

`APIFUSE__PROVIDER__*__HYPER_API_KEY` is rejected as an ownership model. A
provider-specific alias does not convert a shared paid resolver credential into
provider business state.

### Ceremony/solve continuity is an opaque engine handle

The engine creates and owns a ceremony/solve lease handle containing at least:

- proxy vendor;
- the exact endpoint, or the inputs required to reproduce the exact vendor SID;
- selected pool index;
- expiry;
- affinity identity.

The handle is opaque to provider code and is integrity-bound to its engine
session/flow. Its contents are never projected through provider `ctx.env`,
`ctx.context`, logs, or errors. For Smartproxy this records the exact selected
raw endpoint and an engine expiry; it does not claim that Smartproxy's
extraction result became a vendor-guaranteed lease. For NodeMaven it preserves
the SID inputs, including pool index and refresh window, rather than assuming a
second resolution will make the same choice.

The provider declares `proxy: { mode: "required" }`, geo/session policy, and
the client profile required by its upstream. The initiating stealth session
binds the ceremony handle. A resolver adapter that needs upstream transport
receives `createTransport` from that session and cookie jar; it must not perform
a second independent `resolveProxyConfigAsync` to approximate the initiating
identity. The same handle covers challenge detection, vendor IP reflection,
script fetch, payload submission, cookie mutation, and eligible refetch until
completion or expiry.

Cross-turn auth continuity stores this state engine-side behind the opaque
handle. The provider may retain site/business context, but not a signed proxy
descriptor or an engine lease vocabulary.

## v1.1 anti-goals

- Provider-owned Hyper credentials, including
  `APIFUSE__PROVIDER__*__HYPER_API_KEY` aliases.
- A provider-facing `ctx.proxy.lease.acquire()` / `.bind()` API or any contract
  that exposes vendor, endpoint, SID, or pool index to provider code.
- Calling `resolveProxyConfigAsync` a second time and treating equal affinity
  intent as proof of the same exact transport.
- Treating a Smartproxy extraction endpoint as a vendor-guaranteed lease.
- Implementing credential filtering, the Hyper adapter, or ceremony-handle code
  in this paper-only PR.
- Marking the v1.1 amendment Accepted before architectural ratification.

## v1.1 consequences

- Paid shared solver keys stay outside provider sandboxes and follow one
  validation/projection rule.
- A challenge transaction can preserve its exact egress and cookie identity
  across resolver work and auth turns without provider HMAC machinery.
- The engine must own expiry, cleanup, handle integrity, and safe diagnostics
  for ceremony state.
- Provider migrations can delete their solver key declaration and signed lease
  protocol after the roadmap in ADR-0008 v1.1 lands; this amendment alone does
  not change runtime behaviour.

---

# ADR 0009: Provider engine boundary and protocol

## Status

Accepted.

## Decision

Provider business logic receives capabilities only through `ProviderEngine.attach`.
The in-process implementation is the local-development transport; deployment
bridges implement the same attachment interface with RPC clients. Attachment
projects the declaration into an exact context, validates every declared binding,
and guards dynamic access to undeclared capability names.

The remote protocol is `provider-engine.v1`: an authenticated, versioned RPC
envelope over the platform's private provider-to-engine channel. HTTP, OCR,
resolver calls, and non-streaming cache/state operations use request/response
messages first. Payload serialization is structured-clone compatible and errors
retain the SDK provider-error code, retryability, and safe details.

Streaming HTTP/STT data uses a separate stream lane with cancellation and
backpressure. Browser pages, stealth sessions, and stateful/native lifecycles use
opaque engine-owned session handles with explicit close and expiry. They are not
flattened into request/response calls. Deployment authentication, discovery, and
channel provisioning live in the APIFuse monorepo; the SDK defines their protocol
and attachment contracts.

Proxy vendor credentials are captured by the engine host. Provider declarations
may express proxy policy but may not name engine-owned credential secrets. The
provider environment projection drops those names even if an upstream generator
mistakenly requests them.

## Runtime targets

`runtimeTarget: "vanilla"` runs provider logic outside the engine and cannot
declare `native`. `runtimeTarget: "engine"` is reserved for session-bearing logic
that must remain resident; kakaotalk is the initial provider in this lane.
The older `runtime` field continues to describe the standard/shared/browser
execution profile and is not reused for engine residency.

## Migration sequencing

1. Publish declaration-derived contexts, engine attachment, and the migration
   tooling.
2. Migrate providers in reviewable lanes: add declarations, one context alias,
   capability-only helper parameters, and an explicit runtime target. Kakaotalk
   selects `engine`; all portable providers select `vanilla`.
3. Enable the remote engine bridge and remove proxy credentials from provider
   environment projections before moving each lane's traffic.
4. After every provider is migrated, make `runtimeTarget` mandatory and delete
   the legacy omitted-target compatibility path. There is one provider context
   surface throughout; no direct-capability fallback is introduced.
