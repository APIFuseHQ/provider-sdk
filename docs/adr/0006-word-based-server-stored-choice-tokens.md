# ADR: Word-based server-stored choice tokens

- Status: accepted
- Date: 2026-08-10
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

1. Parse returns one uniform `CHOICE_NOT_FOUND`-class error for a missing, expired, consumed, or binding-mismatched word token. Callers cannot distinguish those cases from the code or message; internal metrics may distinguish them.
2. Providers should declare `annotations.rateLimit` on operations that consume choices. The platform already supports this: for example, daangn `search-regions` declares `calls: 10` per minute, throttling per-tenant guessing to approximately 0.17 requests per second.
3. Unbound cursor TTLs are short — minutes, not days.

### 3. The stored record becomes the complete authority

Everything formerly split between the encrypted envelope and stored payload moves into one stored record:

- payload and its digest;
- purpose and `provider_id`;
- `issued_at_ms` and issuer `ttl_ms`;
- connection and credential binding hashes when binding was requested.

The canonical hyphen-joined word sequence is the state key. Storage continues through `resolveChoiceStateNamespace` and the configured `ctx.state` namespace, quota, value-size, and TTL policy.

Issuance selects every word with cryptographic randomness and creates the record with compare-and-set-if-absent semantics. A collision regenerates the whole sequence. Five failed attempts produce a `CHOICE_STATE_UNAVAILABLE`-class provider error instead of overwriting a live choice.

### 4. Parsing is dual-read during a bounded compatibility window

Parse first tests the literal provider prefix followed by a body that dictionary-segments into four or five hyphen-separated words. Dictionary-aware segmentation preserves the official `yo-yo` entry without confusing its internal hyphen for an extra word. A structurally valid word token is handled only as a word token: missing state, expiry, consumption, corrupt state, digest failure, or binding failure is terminal and never falls through to the encrypted parser.

Only a structural mismatch enters the legacy AES-256-GCM envelope path. This permits already-issued server handles and all inline tokens to continue parsing during rollout. The implementation fallback carries a dated removal comment and is removed after 2026-09-15.

The stored record is validated against the parse site's provider id, purpose, TTL clamp, and current connection or credential binding using the same key derivation and hash functions as the encrypted format. Missing state, expiry, prior consumption, and binding mismatch all fail closed with the same externally visible choice-not-found error class, code, and message. Internal observability may retain the reason. Successful word-token parsing atomically consumes the stored record before returning its payload, preserving single-use behavior under concurrent reads.

### 5. Inline mode is unchanged

`storage: { mode: "inline" }` continues to emit and parse the existing encrypted and signed envelope because its payload must travel client-side. No envelope, cipher, keyring, `kid`, or rotation format changes. `mode: "auto"` continues to choose storage by payload size and uses the word format whenever it chooses server storage.

## Security rationale

Word tokens are lookup keys to authoritative server state, not bearer-signed capabilities. They are equivalent to or better than the encrypted server handle because:

1. Forgery requires guessing a live 41.4- or 51.7-bit lookup key within its TTL and before single-use consumption, with uniform errors and operation rate limits suppressing online discovery.
2. The lookup key itself requires no encryption-key synchronization or secret management.
3. Dictionary membership detects malformed substitutions, while record existence detects valid-word tampering.

Payment-, reservation-, and equivalent high-impact tokens must use connection or credential binding and remain single-use. The binding is checked against the stored record before the payload is released, so learning a live word sequence does not bypass its context restriction. Unbound long-TTL or sensitive cursors use `strength: "high"` with five words.

## Consequences

Positive:

- Server-stored tokens shrink from hundreds of opaque characters to a provider prefix plus four or five LLM-copyable words.
- Single-character mistakes cannot silently become another dictionary-valid word, and valid-word tampering cannot produce state without guessing a live key.
- The state record is one auditable source of truth for payload, expiry, purpose, provider, digest, and binding.
- Inline tokens and already-issued encrypted server handles remain compatible during rollout.

Negative / accepted:

- Server-stored tokens require available state for both issuance and parsing; they are intentionally not self-contained.
- Four-word lookup keys provide 41.4 bits, so TTLs, single use, uniform errors, and operation rate limiting remain part of the security boundary. Sensitive unbound use sites select the 51.7-bit five-word form.
- Dual-read temporarily retains two parse paths. Structural discrimination and the dated removal boundary prevent a failed word-token validation from being reinterpreted by the legacy path.

## Rejected alternatives

- **Use three words.** The roughly 31-bit space produces about two expected hits in the stated one-day online-guessing scenario and is not an acceptable default tier.
- **Shrink the encrypted handle.** The 236-character empty-envelope floor cannot reach the copyability target, regardless of payload diet.
- **Use a short random base64url id.** It is compact but remains an opaque character sequence that LLMs can corrupt without an obvious word boundary or membership failure.
- **Use Short Wordlist #1 or a custom filtered list.** Short Wordlist #1 lacks Short Wordlist #2's edit-distance guarantee, and filtering would discard the reviewed artifact and its documented invariants.
- **Put signed metadata beside the words.** This recreates client-visible length and key-management requirements even though the server record is authoritative.
- **Fall back to the legacy parser after any word-token failure.** Expired, tampered, unbound, or consumed word tokens must fail closed; fallback is compatibility for a different syntax, not an alternate validator.
