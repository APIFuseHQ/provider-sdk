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
