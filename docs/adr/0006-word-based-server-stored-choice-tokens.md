# ADR: Word-based server-stored choice tokens

- Status: accepted
- Date: 2026-08-10; amended 2026-08-19
- Deciders: Taehoon (owner), Soju (agent)
- Scope: `@apifuse/provider-sdk` managed provider choice tokens stored in runtime state

## Context

Managed choice tokens use an AES-256-GCM envelope. Server storage previously shortened only the encrypted payload: `issueServerStoredChoice` persisted the provider payload, then encrypted and signed a handle containing its state id, digest, and creation time together with the provider, purpose, issue time, TTL, and binding. The resulting server-stored token remained roughly 350–470 characters, with an empty-envelope floor of 236 characters.

Production APIFuse playground traces measured on 2026-08-10 show that LLMs do not reliably reproduce tokens of this length. Ten of fifteen sends of 330–430-character tokens were corrupted in the middle, and one session expanded into 93 retrying tool calls. Reducing the handle payload cannot cross the envelope floor. The server already holds the authoritative state, so a client-visible encrypted copy of the state metadata adds length without making that state independently usable.

## Decision

### 1. Server-stored choices use compact word lookup keys

New server-stored tokens have one of these shapes:

```text
<prefix><word>-<word>-<word>-<word>
<prefix><word>-<word>-<word>-<word>-<word>
```

Four words are the default `strength: "standard"`; an issue site requests five words with `strength: "high"`. There is no three-word tier: with a 1,296-word list it provides only about 31 bits, and the online-guessing analysis below rejects it. `strength` applies only when `storage: { mode: "server" }` or `mode: "auto"` resolves to server storage. The provider-declared prefix is copied byte-for-byte and is not shortened or rewritten. Providers may separately choose shorter prefixes.

The SDK embeds the official [EFF Short Wordlist #2](https://www.eff.org/files/2016/09/08/eff_short_wordlist_2_0.txt) unchanged as a TypeScript module. It contains 1,296 lowercase ASCII words, each 3–10 characters long. Of these, 1,295 use only `a-z`; the official entry `yo-yo` contains the list's sole punctuation mark and is retained rather than silently creating a custom list. Every word has a unique three-character prefix and is at edit distance at least three from every other word. These last two properties are the reason for choosing Short Wordlist #2: a one-character typo can never resolve to another valid word. Short Wordlist #1 is not used because it lacks the edit-distance guarantee, and the SDK does not derive a custom filtered list.

At `log2(1296) = 10.34` bits per independently selected word, four words carry 41.4 bits and five words carry 51.7 bits. A worst-case four-word body is approximately 47 characters (four 10-character words plus separators), still roughly ten times shorter than the measured 470-character envelope. Tests pin the embedded list at 1,296 entries and assert the normalized official word-sequence digest, lowercase `a-z` except for the exact `yo-yo` source entry, 3–10-character bounds, uniqueness, and unique three-character prefixes. The module docstring cites the official source URL.

### 2. Guessing and collision analysis

The online guessing expectation is `E = N_guesses * K_active / keyspace`. With `K = 1,000` concurrently active tokens in one provider-and-purpose namespace and an attacker sustaining 50 requests per second for 24 hours (`N = 4.32M`):

- 3 words (`2.2e9`) produce `E ≈ 2.0` expected hits — **rejected**.
- 4 words (`2.8e12`) produce 0.15%.
- 5 words (`3.7e15`) produce 0.0001%.

For issuance collisions, four words tolerate approximately 1.98 million concurrently active tokens at 50% cumulative collision probability. At one million active tokens, the per-issue collision probability is 0.00004%. Compare-and-set retry, capped at five attempts, fully absorbs that rate without overwriting a live token.

Binding changes the threat model. A **bound** token whose connection or credential hash is verified server-side at parse is useless to a guesser even on a hit. Guessing matters for **unbound** tokens, such as anonymous search cursors, because a hit discloses another caller's stored search state. Consequently, an unbound token with a sensitive-ish payload or a TTL greater than one hour **SHOULD** use `strength: "high"`; bound tokens are safe at the four-word default.

The analysis depends on these requirements:

1. Parse returns one uniform `CHOICE_NOT_FOUND`-class error for a missing, expired, corrupt, or binding-mismatched word token. A consumed token also returns that error in `never` and `on-parse` modes. An `explicit` caller that already possesses the exact token may receive only its consumed status and replay key; it receives no payload. Invalid callers cannot distinguish the failure cases from the code or message, while internal metrics may distinguish them.
2. Providers should declare `annotations.rateLimit` on operations that parse choices. The platform already supports this: for example, daangn `search-regions` declares `calls: 10` per minute, throttling per-tenant guessing to approximately 0.17 requests per second.
3. Unbound handles minimize TTL. When an existing contract requires a long-lived unbound handle, it uses five-word `high` strength and an operation rate limit rather than relying on consumption.

### 3. The stored record becomes the complete authority

Everything formerly split between the encrypted envelope and stored payload moves into one stored record:

- payload and its digest;
- prefix, purpose, and `provider_id`;
- `issued_at_ms` and issuer `ttl_ms`;
- connection and credential binding hashes when binding was requested;
- active/consumed status and a stable replay key.

The canonical hyphen-joined word sequence is the state key. Storage continues through `resolveChoiceStateNamespace` and the configured `ctx.state` namespace, quota, value-size, and TTL policy.

Issuance selects every word with cryptographic randomness and creates the record with compare-and-set-if-absent semantics. A collision regenerates the whole sequence. Five failed attempts produce a `CHOICE_STATE_UNAVAILABLE`-class provider error instead of overwriting a live choice.

### 4. Parsing is dual-read during a bounded compatibility window

Parse first tests the literal provider prefix followed by a body that dictionary-segments into four or five hyphen-separated words. Dictionary-aware segmentation preserves the official `yo-yo` entry without confusing its internal hyphen for an extra word. A structurally valid word token is handled only as a word token: missing state, expiry, consumption, corrupt state, digest failure, or binding failure is terminal and never falls through to the encrypted parser.

Only a structural mismatch enters the legacy AES-256-GCM envelope path. This permits already-issued server handles and all inline tokens to continue parsing during rollout. A failed validation of a structurally valid word token never falls through to the legacy parser.

Provider code MUST pass the unmodified token and its declared literal prefix to `ctx.choice.parse`. It MUST NOT preclassify with checks such as `token.startsWith(prefix + ".")`: the dot is part of the legacy envelope syntax and is absent from word tokens. The SDK parser is the single format discriminator. This contract lets provider-side prefix prechecks be deleted without weakening validation: the word path validates the literal prefix against both the input and stored record, while the legacy path validates the signed envelope prefix.

The legacy parser cannot be removed on a calendar date chosen independently of issued TTLs. Rollout records the last time any deployment pinned to an older SDK can mint a legacy managed token, `T_last_legacy_mint`, and the parser removal milestone MUST be later than `T_last_legacy_mint + TTL_max`, where `TTL_max` is the largest issuer-supplied TTL actually minted, not an assumed constant: the issuance API accepts an unconstrained `ttlMs`, so removal MUST be gated on verifying the outstanding legacy-token horizon (from mint records or the shared state store) at removal time. As a reference point the live-provider inventory currently caps managed-token TTLs at 30 days, but that inventory is an observation, not an enforced bound. A token is accepted according to its issuer TTL measured from issuance; this horizon describes only when parser code may be removed and is not a promise that every legacy token remains valid until a named date.

The stored record is validated against prefix, provider id, purpose, TTL clamp, payload digest, replay key, and current connection or credential binding using the same key derivation and hash functions as the encrypted format. Missing state, expiry, invalid status for the requested consume mode, and binding mismatch fail closed with the same externally visible choice-not-found error class, code, and message. Internal observability may retain a safe reason.

### Unconditional issuance and rollback

Server-stored issuance always produces the ADR word format. There is no runtime
format setting: deployments are version-pinned, so the pinned SDK version is
the rollout phase. Parsing remains dual-read while legacy tokens are in flight.

Unconditional issuance carries a deployment prerequisite: every instance that
can receive a token minted by this version MUST already run a dual-read parser
(the version that introduced word parsing, or later). A parser older than the
dual-read introduction rejects word tokens as structurally invalid, so a mixed
fleet that still contains such instances re-creates the orphaned-token failure
this ADR exists to prevent. Upgrades MUST therefore be ordered: land the
dual-read version fleet-wide first, then land unconditional issuance. Within a
single rolling deploy of the issuance version this holds automatically, because
the preceding pinned version is already dual-read.

Rollback repins the immediately preceding beta, which already parses both word
and legacy formats. Word tokens minted before the repin therefore remain
readable, while the older version resumes its own issuance behavior. Legacy
explicit claims retain the existing `unsupported` result and stable replay key;
providers using `consume: "explicit"` must handle that compatibility branch
until the legacy horizon closes. Removing the legacy parser is a separate wave
after `T_last_legacy_mint + TTL_max`.

### 5. Parsing has provider-controlled consume semantics

`ctx.choice.parse` accepts `consume: "never" | "on-parse" | "explicit"`. The default is `never`.

- `never` validates and returns an active payload without changing state. Repeated parse is valid until TTL expiry. This is the compatibility default because legacy managed tokens have never been consumed merely by parsing, and the live inventory includes reusable pagination cursors, NOL booking handles, and TableCheck cart handles.
- `on-parse` validates and atomically changes active to consumed before returning the payload. Concurrent reads admit one caller. Providers use it only when losing retry-after-parse behavior is intentional.
- `explicit` validates without consuming and returns an active claim containing `payload`, `replayKey`, and `consume()`. The provider calls `consume()` at its chosen commit point. If upstream work fails before that point, the provider omits `consume()` and the same input can be parsed again. Competing claims use the captured state version, so only one claim changes the record and later claim attempts report already consumed.

After explicit consumption, parsing the same input with `explicit` returns a consumed replay branch containing only the same `replayKey`; it does not return the payload or another consume function. Providers that maintain created/result records query those records by `replayKey` before deciding that a consumed replay is an error. The replay key is lowercase SHA-256 of the exact client-visible token, matching existing provider digest keys, and remains in the consumed record. This is the selected alternative to an atomic transaction across the SDK choice namespace and a provider-owned result namespace: the provider writes or claims its dedup/result record at the appropriate commit boundary, and the durable alias lets every later replay reach it.

Consumption is a word-record capability. Legacy managed tokens retain their historical non-consuming behavior during dual-read; an explicit legacy claim therefore reports `unsupported`, while still providing the stable token replay key. Providers that opt into explicit consume MUST handle this compatibility branch until the legacy horizon closes.

High-impact reservation, payment, and equivalent uses MUST request connection or credential binding and select either `on-parse` or `explicit` with provider-owned result deduplication. Reusable cursors and lookup handles use `never`.

### 6. Choice telemetry is allowlisted and redacted

The runtime records `format=word|legacy`, operation (`parse` or `consume`), parse outcome, consume mode, consumed/replay booleans, provider id, and purpose. These fields distinguish word rollout, legacy fallback, invalid input, state failure, consumption, and idempotent replay without exposing capability material. Token text, payloads, replay keys, digests, credential values, and arbitrary error messages MUST NOT be placed in logs or telemetry. A telemetry sink failure does not change parse or consume behavior.

### 7. Inline mode is unchanged

`storage: { mode: "inline" }` continues to emit and parse the existing encrypted and signed envelope because its payload must travel client-side. No envelope, cipher, keyring, `kid`, or rotation format changes. `mode: "auto"` continues to choose storage by payload size and uses the word format whenever it chooses server storage.

## Security rationale

Word tokens are lookup keys to authoritative server state, not bearer-signed capabilities. They are equivalent to or better than the encrypted server handle because:

1. Forgery requires guessing a live 41.4- or 51.7-bit lookup key within its TTL, with uniform invalid-input errors and operation rate limits suppressing online discovery. Single-use modes can shorten this window further but are not assumed for reusable handles.
2. The lookup key itself requires no encryption-key synchronization or secret management.
3. Dictionary membership detects malformed substitutions, while record existence detects valid-word tampering.

Payment-, reservation-, and equivalent high-impact tokens use connection or credential binding plus an explicit consumption/deduplication policy. The binding is checked against the stored record before an active payload or consumed replay key is released, so learning a live word sequence does not bypass its context restriction. Unbound long-TTL or sensitive reusable handles use `strength: "high"` with five words.

## Consequences

Positive:

- Server-stored tokens shrink from hundreds of opaque characters to a provider prefix plus four or five LLM-copyable words.
- Single-character mistakes cannot silently become another dictionary-valid word, and valid-word tampering cannot produce state without guessing a live key.
- The state record is one auditable source of truth for payload, expiry, prefix, purpose, provider, digest, replay alias, consume status, and binding.
- Inline tokens and already-issued encrypted server handles remain compatible during rollout.
- Reusable cursors and handles preserve legacy parse behavior, while high-impact providers can select atomic claim semantics and retain idempotent result replay.

Negative / accepted:

- Server-stored tokens require available state for both issuance and parsing; they are intentionally not self-contained.
- Four-word lookup keys provide 41.4 bits, so TTLs, binding where applicable, uniform invalid-input errors, and operation rate limiting remain part of the security boundary. Sensitive unbound use sites select the 51.7-bit five-word form.
- Dual-read retains two parse paths until the last legacy mint plus the maximum issued TTL. Structural discrimination and the measured removal boundary prevent a failed word-token validation from being reinterpreted by the legacy path.
- Explicit consumption adds a provider-visible active/consumed branch. Providers must check their result record by replay key before treating a consumed replay as failure.

## Rejected alternatives

- **Use three words.** The roughly 31-bit space produces about two expected hits in the stated one-day online-guessing scenario and is not an acceptable default tier.
- **Shrink the encrypted handle.** The 236-character empty-envelope floor cannot reach the copyability target, regardless of payload diet.
- **Use a short random base64url id.** It is compact but remains an opaque character sequence that LLMs can corrupt without an obvious word boundary or membership failure.
- **Use Short Wordlist #1 or a custom filtered list.** Short Wordlist #1 lacks Short Wordlist #2's edit-distance guarantee, and filtering would discard the reviewed artifact and its documented invariants.
- **Put signed metadata beside the words.** This recreates client-visible length and key-management requirements even though the server record is authoritative.
- **Fall back to the legacy parser after any word-token failure.** Expired, tampered, binding-mismatched, or mode-incompatible consumed word tokens must fail closed; fallback is compatibility for a different syntax, not an alternate validator.
- **Keep unconditional consume-on-parse.** It breaks retry after an upstream failure, idempotent confirmation replay, reusable pagination cursors, and long-lived lookup handles.
- **Move state to a second context surface or declarative SSoT.** Provider choice issuance, parsing, claim, and replay remain on `ctx.choice.issue/parse` so token semantics do not split across competing APIs.
