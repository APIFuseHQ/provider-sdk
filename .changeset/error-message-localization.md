---
"@apifuse/provider-sdk": minor
---

Localize provider error text through the provider locale catalog:
`ProviderErrorOptions` gains `messageKey`, `fixKey` and `params`,
`OperationErrorCode` gains `messageKey`/`fixKey`, and the server resolves them
at envelope time against `locales/{en,ko,ja}.json` using the caller's
`Accept-Language`.

**Exactly two fields are localized: the response body's `error.message` and
`error.fix`.** Everything else stays English and unchanged — `error.code`,
`error.details`, `errorCodes[].description`, `Error.message`, cause frames, the
`provider_request_failed` log, OTLP attributes, the request-scope redaction
record, and the `X-ApiFuse-Error-Observability` header. The error envelope
schema is unchanged; clients keep receiving plain `message`/`fix` strings.

Resolution order per field: the throw site's key, then the matching
`errorCodes[]` entry's key, then the derived `errors.<code>.<field>`, then the
English literal. Each candidate resolves in the caller's locale before `en`. A
missing key, a malformed key, a non-string catalog value or an absent catalog is
a miss, never a throw — a caller always gets text. The declaration and derived
steps are skipped for SDK-owned failures so a provider catalog cannot relabel
`Request timed out`. A request without `Accept-Language` keeps serving the `en`
value, so existing contract fixtures do not change.

Interpolation is `{name}` with `{{`/`}}` escapes and string/finite-number params
only. Param values are treated as untrusted relayed text: secrets and e-mail
addresses are redacted, control/bidi/newline characters are encoded or
collapsed, `<`, `>`, backticks and HTML-entity ampersands are removed, values
are capped at 200 characters, and substituted text is never rescanned, so a
param cannot inject markup, break the envelope, or trigger a second
interpolation round.

Also in this release:

- `serve`/`createServerApp` accept `localeCatalogs` to bundle or pin catalogs.
- Catalogs are now loaded **once** when the server is built instead of being
  re-read from disk on every auth turn, and only the locale files that exist are
  read — a provider with `en`+`ko` but no `ja.json` previously got no
  localization at all. A catalog that exists but cannot be parsed logs one
  `provider_locale_catalogs_unavailable` warn at boot.
- Locale negotiation now honours `Accept-Language` quality values instead of
  taking the first supported tag in header order, and is negotiated once per
  request so an auth turn and an error envelope from the same request cannot
  disagree. The request envelope's `headers` map outranks the HTTP header,
  which is what keeps a flow's continue/poll turns in the language its start
  turn used.
- Authoring lint gains `error-locale-key-missing` and
  `error-locale-key-malformed` (**error**: a literal `messageKey`/`fixKey` that
  `locales/en.json` does not resolve) and `thrown-error-message-not-localized`
  (**warn**: a declared code thrown with no key anywhere, so it is served
  untranslated). Both are skipped when the caller does not supply
  `localeCatalogEn`; `apifuse check` supplies it from the provider directory.

No provider change is required: behaviour is identical until a key exists.
