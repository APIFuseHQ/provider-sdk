# Chrome 149 caller-header ordering: result

## Outcome

The predictor is resolved for the captured request shape and reproduces **33 of
33 captures exactly**.

Strictly, none of the three proposed hypotheses won:

1. **The old ASCII case-fold/rapidhash port was not subtly wrong.** Its relevant
   hash values agree with the exact `149.0.7827.155` sources. The new faithful
   port also passes Chromium's numeric rapidhash fixture.
2. **No phantom keys are needed.** Exhaustive candidate-subset sweeps found no
   non-empty subset that reproduces all captures.
3. **The scrambling does not move somewhere else.** It still occurs in Blink's
   `HTTPHeaderMap` / `WTF::HashTable`.

The actual explanation is a fourth one: the failed models put too many
wire-visible headers in `HTTPHeaderMap`. Only the variable prefix is emitted by
that map. Default `Accept`, the Fetch Metadata headers, `Referer`,
`Accept-Encoding`, and default HTTP/2 `Priority` are added at later stages.

The standalone predictor and validator are:

`/home/ubuntu/work/sdk-stealth-audit/chrome149_header_order.py`

Run it with:

```sh
python3 chrome149_header_order.py Accept Priority Content-Type
python3 chrome149_header_order.py --harness --validate placement-rule-sweep.json
python3 chrome149_header_order.py --research placement-rule-sweep.json
```

(`--harness` is required for every corpus in this document; see the 2026-09-02
correction at the end. Without it the tool predicts real Chrome, validated by
`al-placement-capture.json` variants B and C.)

The input is a set of *effective* caller header names already accepted by the
page-context Fetch `Headers` machinery. The fixed request shape is the captured
GET fetch/XHR from the tls.peet.ws page with locale `ja-JP`. Forbidden Fetch
headers, bodies, navigation-specific headers, additional opted-in client hints,
cookies, redirects, and different locales are outside this 33-capture model.

## Validation and hypothesis searches

The validator prints:

```text
33/33 exact matches
```

The research sweep prints:

```text
winning staged HTTPHeaderMap model: 33/33
rejected all-wire-headers-in-one-map model: 0/33
all-visible-map phantom sweep: 0 non-empty exact subsets; best=0/33, phase=before, keys=['X-Requested-With']
winning-model phantom sweep: 0 non-empty exact subsets; best=22/33, phase=before, keys=['Cache-Control']
```

The phantom sweep exhausts all **511 non-empty subsets** of:

```text
X-Requested-With, Host, Connection, Priority,
Sec-Fetch-Storage-Access, Cache-Control, Pragma, Origin, Content-Length
```

Each subset is tested in three insertion phases (before caller headers, between
caller and fixed headers, and after fixed headers) against all 33 captures.
Phantom-only entries are allowed to occupy buckets and affect table expansion,
then are filtered from the modeled wire output. `Priority` and `Cache-Control`
survive filtering when actually caller-supplied. No non-empty subset reaches
33/33.

The earlier exhaustive 10-key failure is now expected: its premise was that the
ten baseline names before `Accept-Encoding` all traversed the same Blink map.
They do not.

## Exact predictor algorithm

The following is precise enough to reimplement with TypeScript `bigint`.
All 64-bit arithmetic must be reduced modulo `2^64`; the 64x64 multiply returns
the low and high 64-bit halves.

### 1. Canonicalize caller input

Deduplicate names case-insensitively and sort them by ASCII case-insensitive
lexicographic order. This is the order supplied by `FetchHeaderList`, whose
backing store is:

```cpp
std::multimap<String, String, ByteCaseInsensitiveCompare>
```

Consequently JS object order and header values do not affect map insertion
order.

### 2. Populate the Blink map

Insert the sorted caller names, followed by this fixed insertion sequence:

```text
sec-ch-ua
sec-ch-ua-mobile
sec-ch-ua-platform
User-Agent
Accept-Language
```

An already-present case-insensitive key has its value replaced/combined without
moving its bucket.

**Correction (2026-09-02, see `expansion-fix-report.md`).** The sequence
originally documented here (`sec-ch-ua-platform, sec-ch-ua, User-Agent,
Accept-Language, sec-ch-ua-mobile`) was a fitted permutation. It reproduces the
33 derivation captures but fails 3 of the 17 `expansion-sweep.json` cases (the
10- and 11-key tables `n5`, `alt5`, `alt6`) and 3 of the 5 non-conditional M1
discriminators, because it reverses which key wins a shared home bucket. The
sequence above is the one the tagged source actually executes:
`UpgradeResourceRequestForLoader` (`resource_request_utils.cc:146`) first calls
`context.UpgradeResourceRequestForLoader` (`:166`, client hints in
`frame_fetch_context.cc:737/748/761`) and only afterwards `context.PrepareRequest`
(`:214`, `SetHTTPUserAgent` at `frame_fetch_context.cc:419`, then the DevTools
extra header `Accept-Language` via `probe::PrepareRequest` at `:455` and
`inspector_network_agent.cc:1545`). With this sequence the 8-bucket initial
table reproduces 33/33, 17/17, 9/10 (the `h_ifnone` //net exception) and 5/5.

Note that `Accept-Language` is in this map only because the capture harness
(Playwright with `locale: "ja-JP"`) injects it through DevTools;
`AddReducedAcceptLanguageIfNecessary` is a no-op because
`network::features::kReduceAcceptLanguage` is `FEATURE_DISABLED_BY_DEFAULT`
(`services/network/public/cpp/features.cc:204,214`).

### 3. Hash each map key

For an ASCII/Latin-1 header name of `n` bytes:

1. Use `CaseFoldingHashReader<LChar>`.
2. Its compression factor is 1 and expansion factor is 2.
3. Call rapidhash with produced length `2*n`, while pointer offsets are scaled
   by `x/y = 1/2` exactly where tagged `rapidhash.h` does so.
4. `Read32` reads two Latin-1 input characters, case-folds each through
   `StringImpl::kLatin1CaseFoldTable`, and places them at bits 0 and 16.
5. `Read64` similarly reads four characters into bits 0, 16, 32, and 48.
6. `ReadSmall` is only called with `k == 2` and returns the first folded
   character.
7. Use seed `0xbdd89aa982704029` and secrets:

   ```text
   0x2d358dccaa6c78a5
   0x8bb84b93962eacc9
   0x4b33a62ed433d4a3
   ```

8. Keep `rapidhash & 0xffffff`; remap zero to `0x800000`.

The full rapidhash branches and signed final pointer arithmetic are ported in
the program rather than summarized here.

### 4. Emulate `WTF::HashTable`

The initial table size is 8. For insertion:

```text
mask = tableSize - 1
i = hash & mask
probeCount = 0
while bucket i is occupied by a different case-insensitive key:
    probeCount += 1
    i = (i + probeCount) & mask
```

After inserting a new key, expand when:

```text
(keyCount + deletedCount) * 2 >= tableSize
```

There are no deletions in the winning model. Expansion doubles the size and
reinserts occupied entries by scanning the old buckets from index 0 upward.
Final map iteration likewise scans buckets from index 0 upward.

One compact confirmation is the `all_seven` case. Its 11 map keys have distinct
low-five-bit buckets, and ascending bucket order is exactly:

```text
sec-ch-ua-platform cache-control accept-language sec-ch-ua
upgrade-insecure-requests x-custom-probe sec-ch-ua-mobile user-agent
accept content-type priority
```

This is byte-for-byte the captured prefix.

### 5. Append downstream headers

Lowercase the iterated map names for HTTP/2, then apply these stages:

1. If `accept` is absent, append `accept`. Caller `Accept` was already in the
   map, so it keeps its bucket position instead.
2. Append, in order:

   ```text
   sec-fetch-site sec-fetch-mode sec-fetch-dest referer
   ```

3. Append `accept-encoding` if absent.
4. If `priority` is absent, append it last. A caller-supplied `Priority` was
   already in the map and therefore is not appended.

For an implementation that needs values too, these steps order names only;
the corresponding Chrome-generated values must be supplied independently.

## Hash-port self-check

Tagged `string_hasher_test.cc` asserts this numeric fixture:

```cpp
const LChar kTestALChars[5] = {0x41, 0x95, 0xFF, 0x50, 0x01};
const uint64_t kTestAHash = 0xE9422771E0A5DDE6;
```

The port produces exactly `0xe9422771e0a5dde6`, and
`ComputeHashAndMaskTop8Bits` produces exactly `0xa5dde6`. **It matched.**

I did not find a numeric expected value asserted specifically for
`DeprecatedCaseFoldingHash` in the tagged WTF tests. The tagged tests instead
assert case-fold equality (for example, `"Longer string 123"` against
`"longEr String 123"`) and equality of the 8-bit expansion path with the
16-bit path over many lengths. The port passes the applicable case-fold
equality assertion. Thus the numeric fixture independently checks the
rapidhash core and masking, while the exact tagged reader/table port plus the
33 captures check the case-fold path.

## Exact Chromium tag and blob hashes

All source was fetched from tag **`149.0.7827.155`** using Gitiles
`?format=TEXT` or the equivalent tagged directory archive. Hashes below are Git
blob SHA-1s computed over the decoded file contents.

Required port sources:

| Chromium path | Blob SHA-1 |
|---|---|
| `third_party/rapidhash/rapidhash.h` | `65aa7f0064bd426b7bee33c7175bd457e8dc5a9a` |
| `third_party/blink/renderer/platform/wtf/text/case_folding_hash.h` | `b9f7d7175b046a3e263df402b1f37e0da4b5ccd8` |
| `third_party/blink/renderer/platform/wtf/text/string_impl.cc` | `40e9708574cfb04c1584d1e796c19fd6cc2d4c40` |
| `third_party/blink/renderer/platform/wtf/text/string_impl.h` | `83e0251fa49f5aa844a7fa09e8526f6d4bb69a36` |
| `third_party/blink/renderer/platform/wtf/hash_table.h` | `1d86fd9d4d6eb1322b8ce6b7178cf1d7afdcda14` |

Pipeline and verification sources:

| Chromium path | Blob SHA-1 |
|---|---|
| `third_party/blink/renderer/platform/network/http_header_map.h` | `3ecba4aab4208952e63625d30d922f3c6d6dc333` |
| `third_party/blink/renderer/platform/network/http_header_map.cc` | `9447af8c51192837902b614558cb9131b6719034` |
| `third_party/blink/renderer/platform/loader/fetch/url_loader/request_conversion.cc` | `a58aec09a356d46fba2cf34ad4bcec9ae5f00eef` |
| `third_party/blink/renderer/platform/loader/fetch/resource_request.cc` | `7132bf73a142d1cef8f8ee5aaf34a02e482e7d65` |
| `third_party/blink/renderer/core/fetch/fetch_header_list.h` | `7c56a222dd552733cbf5cae27b784e1258449a0b` |
| `third_party/blink/renderer/core/fetch/fetch_header_list.cc` | `f9de5bf9d9f5c80ef9eb655128983dd178d6eb8d` |
| `third_party/blink/renderer/core/fetch/fetch_manager.cc` | `d6bfb4322a07d70b16e38f79d8d0af480fd89c70` |
| `third_party/blink/renderer/core/loader/frame_fetch_context.cc` | `a459abf8bb66b19c2f66215760836ef62c9a544e` |
| `third_party/blink/renderer/platform/loader/fetch/resource_request_utils.cc` | `fbd9c72f598b83dd7ed8aeb74ca731712a4cca2a` |
| `third_party/blink/renderer/core/inspector/inspector_network_agent.cc` | `6f77e0ccd6617b88f7cea646dbc1e4d3110a526c` |
| `third_party/blink/renderer/platform/loader/fetch/resource_fetcher.cc` | `6fb28940e1f1715873666a8d2e3a145936ff1933` |
| `third_party/blink/renderer/platform/loader/fetch/resource.cc` | `47ca1fc0e47b27ef433235b4a7013c44e48acd13` |
| `services/network/public/cpp/features.cc` | `a5e8a9f06fd131bbc4752edde0a1b164321ab706` |
| `net/spdy/spdy_http_utils.cc` | `e72e2cfc045c765b4eca8cc0ce852ba835fa8b1c` |
| `third_party/blink/renderer/platform/wtf/text/string_hasher_test.cc` | `904320d3cfd4265a5ecfc32448eaa60cf0b79e3d` |

## Remaining uncertainty

There is no remaining mismatch in the supplied corpus: **33/33** are exact.
The result should not be generalized silently to a different request shape.
The smallest experiment needed for such a generalization is not another wire
capture, but a tagged Chrome instrumentation build that logs every
`HTTPHeaderMap::Set/Add/Remove`, table capacity, and bucket iteration immediately
before `PopulateResourceRequest`. That would settle effective insertion traces
for additional client hints, forbidden/special headers, bodies, redirects, and
other locales without inferring them from wire position.

## Correction (2026-09-02): real Chrome does not put Accept-Language in the map

Every corpus above was captured through Playwright `newContext({ locale: "ja-JP" })`.
Playwright (1.61.1, Chromium backend) implements `locale` with CDP
`Emulation.setUserAgentOverride` `acceptLanguage`, which
`InspectorEmulationAgent::PrepareRequest` (`inspector_emulation_agent.cc:626-636`)
applies to the Blink `HTTPHeaderMap` unless the page already set the header. The
earlier attribution to `inspector_network_agent.cc:1545` (`Network.setExtraHTTPHeaders`)
names the other DevTools agent on the same `probe::PrepareRequest`
(`frame_fetch_context.cc:455`); it writes into the same map, so the placement
model is unchanged, but it overwrites rather than skips, and Playwright's extra
headers carry no `Accept-Language`. Either way, DevTools is the only reason
`Accept-Language` appeared as a fifth fixed key. A Chrome without DevTools attached
never inserts it there: `AddReducedAcceptLanguageIfNecessary` is a no-op
(`kReduceAcceptLanguage` and `kReduceAcceptLanguageHTTP` are
`FEATURE_DISABLED_BY_DEFAULT`, `features.cc:204,214`), and //net appends it in
`URLRequestHttpJob::AddExtraHeaders` (`url_request_http_job.cc:784-797`) after
`Accept-Encoding`, only when the request does not already carry one
(`SetHeaderIfMissing`, `http_request_headers.cc:128-137`).

Residual caveat: `testing/variations/fieldtrial_testing_config.json` lists both
reduce-Accept-Language features with an Enabled arm, and non-Google-branded
Chromium applies that config unless launched with `--disable-field-trial-config`
(which Playwright passes). If a Google Chrome build had them enabled via Finch,
Blink itself would insert a reduced `Accept-Language` into the map
(`frame_fetch_context.cc:911-937`) and navigations would carry it before
`Upgrade-Insecure-Requests`. The B/C captures show the //net placement and the
full `en-US,en;q=0.9` value, so the feature was inactive in the capture binary; the
shipped model assumes the code default.

`al-placement-capture.json` (A/B/C x caller none/three/five) confirms it:

- A (`locale: ja-JP`): `accept-language` inside the scrambled block (this corpus).
- B (no locale): absent from the block; after `accept-encoding`, before `priority`;
  value `en-US,en;q=0.9`.
- C (`--accept-lang=ja`): same position as B; value `ja`.

The shipped model is therefore:

```text
map insertion: sorted caller names, then
               sec-ch-ua, sec-ch-ua-mobile, sec-ch-ua-platform, User-Agent
downstream:    accept (if absent), sec-fetch-site, sec-fetch-mode, sec-fetch-dest,
               referer, accept-encoding (if absent), accept-language (if absent),
               priority (if absent)
```

It reproduces B and C 6/6. The 33/17/10/5 corpora remain valid tests of the hash
and table mechanics when interpreted with the harness insertion list (the four
keys above plus `Accept-Language`); `chrome149_header_order.py --harness` and the
test suite do exactly that, and no production path selects it. Removing the fifth
key reorders the other keys only where that key alone crossed the 16 -> 32 bucket
expansion: three caller keys and no caller `Accept-Language` (placement-rule-sweep
`three_accept_prio_uir`, expansion-sweep `n3`/`alt3`, the five plain M1 cases).

A caller-supplied `Accept-Language` is an ordinary Fetch header: it enters the map
at its sorted-caller position and //net's `SetHeaderIfMissing` appends nothing.
`chrome-value-transform.json` `accept_language_override` shows that order on the
wire; because `InspectorEmulationAgent::PrepareRequest` skips a key the page
already set (the surviving `ko-KR,ko;q=0.9` value proves the skip), the harness
capture is also the real-Chrome order for that case, as are the ten
placement-rule-sweep cases whose caller set included `Accept-Language`.
