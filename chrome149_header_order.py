#!/usr/bin/env python3
"""Predict Chrome 149.0.7827.155 page-fetch HTTP/2 header-name order.

Inputs are the *effective* caller header names accepted by Fetch's Headers
object.  Values and the input order are intentionally ignored.  The request
shape is a GET XHR/fetch from the tls.peet.ws page with no body.

By default the prediction is for a real Chrome with no DevTools session: the
fixed HTTPHeaderMap keys are the three client hints and User-Agent, and
Accept-Language is appended by //net after Accept-Encoding
(al-placement-capture.json variants B and C).  `--harness` reproduces the
Playwright `newContext({locale})` capture harness instead, whose CDP
Emulation.setUserAgentOverride acceptLanguage makes InspectorEmulationAgent
insert Accept-Language into the map as a fifth fixed key; every corpus other
than al-placement-capture.json B/C was captured that way.

Examples:
  python3 chrome149_header_order.py Accept Priority Content-Type
  python3 chrome149_header_order.py --validate al-placement-capture.json --label-prefix B_
  python3 chrome149_header_order.py --validate al-placement-capture.json --label-prefix C_
  python3 chrome149_header_order.py --harness --validate al-placement-capture.json --label-prefix A_
  python3 chrome149_header_order.py --harness --validate placement-rule-sweep.json
  python3 chrome149_header_order.py --harness --validate expansion-sweep.json
  python3 chrome149_header_order.py --harness --validate m1-capture.json --label-prefix m1_ \
      --exclude-caller If-None-Match
  python3 chrome149_header_order.py --research placement-rule-sweep.json

Known, documented exceptions (net layer, outside the Blink map model): a caller
If-None-Match makes //net prepend Cache-Control (holdout h_ifnone), and a caller
Range is removed from the map by the HTTP cache and re-added at the tail, after
//net's Accept-Encoding/Accept-Language and Cookie, before Priority.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Iterable, Sequence

U64_MASK = (1 << 64) - 1
RAPID_SEED = 0xBDD89AA982704029
RAPID_SECRET = (
    0x2D358DCCAA6C78A5,
    0x8BB84B93962EACC9,
    0x4B33A62ED433D4A3,
)


def _latin1_case_fold(ch: int) -> int:
    """StringImpl::kLatin1CaseFoldTable, expressed without a 256-item literal."""
    if 0x41 <= ch <= 0x5A:
        return ch + 0x20
    if ch == 0xB5:
        return 0x03BC
    if 0xC0 <= ch <= 0xD6 or 0xD8 <= ch <= 0xDE:
        return ch + 0x20
    return ch


def _rapid_mul128(a: int, b: int) -> tuple[int, int]:
    product = (a & U64_MASK) * (b & U64_MASK)
    return product & U64_MASK, (product >> 64) & U64_MASK


def _rapid_mix(a: int, b: int) -> int:
    lo, hi = _rapid_mul128(a, b)
    return lo ^ hi


class _PlainHashReader:
    compression_factor = 1
    expansion_factor = 1

    def __init__(self, data: bytes):
        self.data = data

    def read64(self, p: int) -> int:
        return int.from_bytes(self.data[p : p + 8], "little")

    def read32(self, p: int) -> int:
        return int.from_bytes(self.data[p : p + 4], "little")

    def read_small(self, p: int, k: int) -> int:
        return (self.data[p] << 56) | (self.data[p + (k >> 1)] << 32) | self.data[p + k - 1]


class _CaseFoldingLCharReader:
    compression_factor = 1
    expansion_factor = 2

    def __init__(self, data: bytes):
        self.data = data

    def fold(self, p: int) -> int:
        return _latin1_case_fold(self.data[p])

    def read64(self, p: int) -> int:
        return (
            self.fold(p)
            | (self.fold(p + 1) << 16)
            | (self.fold(p + 2) << 32)
            | (self.fold(p + 3) << 48)
        )

    def read32(self, p: int) -> int:
        return self.fold(p) | (self.fold(p + 1) << 16)

    def read_small(self, p: int, k: int) -> int:
        # case_folding_hash.h DCHECKs k == 2 here.
        if k != 2:
            raise AssertionError(f"CaseFoldingHashReader<LChar>::ReadSmall k={k}, expected 2")
        return self.fold(p)


def _rapidhash_internal(reader: object, produced_length: int) -> int:
    """Faithful scalar port of tagged third_party/rapidhash/rapidhash.h."""
    x = reader.compression_factor  # type: ignore[attr-defined]
    y = reader.expansion_factor  # type: ignore[attr-defined]
    if produced_length % y:
        raise AssertionError("rapidhash reader length is not divisible by expansion factor")

    seed = RAPID_SEED
    seed ^= _rapid_mix(seed ^ RAPID_SECRET[0], RAPID_SECRET[1]) ^ produced_length
    seed &= U64_MASK
    p = 0

    if produced_length <= 16:
        if produced_length >= 4:
            plast = p + (produced_length - 4) * x // y
            a = (reader.read32(p) << 32) | reader.read32(plast)  # type: ignore[attr-defined]
            delta = ((produced_length & 24) >> (produced_length >> 3)) * x // y
            b = (reader.read32(p + delta) << 32) | reader.read32(plast - delta)  # type: ignore[attr-defined]
        elif produced_length > 0:
            a = reader.read_small(p, produced_length)  # type: ignore[attr-defined]
            b = 0
        else:
            a = b = 0
    else:
        remaining = produced_length
        if remaining > 48:
            see1 = seed
            see2 = seed
            while True:
                seed = _rapid_mix(
                    reader.read64(p) ^ RAPID_SECRET[0],  # type: ignore[attr-defined]
                    reader.read64(p + 8 * x // y) ^ seed,  # type: ignore[attr-defined]
                )
                see1 = _rapid_mix(
                    reader.read64(p + 16 * x // y) ^ RAPID_SECRET[1],  # type: ignore[attr-defined]
                    reader.read64(p + 24 * x // y) ^ see1,  # type: ignore[attr-defined]
                )
                see2 = _rapid_mix(
                    reader.read64(p + 32 * x // y) ^ RAPID_SECRET[2],  # type: ignore[attr-defined]
                    reader.read64(p + 40 * x // y) ^ see2,  # type: ignore[attr-defined]
                )
                p += 48 * x // y
                remaining -= 48
                if remaining < 48:
                    break
            seed ^= see1 ^ see2
        if remaining > 16:
            seed = _rapid_mix(
                reader.read64(p) ^ RAPID_SECRET[2],  # type: ignore[attr-defined]
                reader.read64(p + 8 * x // y) ^ seed ^ RAPID_SECRET[1],  # type: ignore[attr-defined]
            )
            if remaining > 32:
                seed = _rapid_mix(
                    reader.read64(p + 16 * x // y) ^ RAPID_SECRET[2],  # type: ignore[attr-defined]
                    reader.read64(p + 24 * x // y) ^ seed,  # type: ignore[attr-defined]
                )
        # The casts in the C++ source force signed arithmetic before division.
        a = reader.read64(p + (remaining - 16) * x // y)  # type: ignore[attr-defined]
        b = reader.read64(p + (remaining - 8) * x // y)  # type: ignore[attr-defined]

    a ^= RAPID_SECRET[1]
    b ^= seed
    a, b = _rapid_mul128(a, b)
    return _rapid_mix(a ^ RAPID_SECRET[0] ^ produced_length, b ^ RAPID_SECRET[1])


def _mask_top_8_bits(result: int) -> int:
    result &= 0xFFFFFF
    return result if result else 0x800000


def blink_casefold_hash(name: str) -> int:
    """DeprecatedCaseFoldingHash::GetHash(span<LChar>) for Latin-1 text."""
    data = name.encode("latin-1")
    reader = _CaseFoldingLCharReader(data)
    return _mask_top_8_bits(_rapidhash_internal(reader, len(data) * reader.expansion_factor))


def self_check() -> None:
    """Check rapidhash against the numeric fixture in string_hasher_test.cc."""
    fixture = bytes((0x41, 0x95, 0xFF, 0x50, 0x01))
    expected_full = 0xE9422771E0A5DDE6
    got_full = _rapidhash_internal(_PlainHashReader(fixture), len(fixture))
    if got_full != expected_full:
        raise AssertionError(f"rapidhash fixture mismatch: got {got_full:#018x}, expected {expected_full:#018x}")
    if _mask_top_8_bits(got_full) != 0xA5DDE6:
        raise AssertionError("StringHasher masking fixture mismatch")
    # Tagged tests assert equality, rather than a numeric value, for this reader.
    if blink_casefold_hash("Longer string 123") != blink_casefold_hash("longEr String 123"):
        raise AssertionError("DeprecatedCaseFoldingHash case-fold equality fixture mismatch")


class WtfHashMap:
    """No-deletion subset of WTF::HashTable used by HTTPHeaderMap."""

    def __init__(self) -> None:
        self.table: list[str | None] = []
        self.key_count = 0

    @staticmethod
    def _equal(a: str, b: str) -> bool:
        return a.casefold() == b.casefold()

    def _insert_without_expand(self, key: str) -> bool:
        mask = len(self.table) - 1
        index = blink_casefold_hash(key) & mask
        probe_count = 0
        while True:
            stored = self.table[index]
            if stored is None:
                self.table[index] = key
                self.key_count += 1
                return True
            if self._equal(stored, key):
                return False
            probe_count += 1
            index = (index + probe_count) & mask

    def _rehash(self, new_size: int) -> None:
        old_table = self.table
        self.table = [None] * new_size
        self.key_count = 0
        # RehashTo traverses the old backing store in ascending bucket order.
        for key in old_table:
            if key is not None:
                self._insert_without_expand(key)

    def insert(self, key: str) -> None:
        if not self.table:
            self.table = [None] * 8
        if not self._insert_without_expand(key):
            return
        # With no deleted buckets: (key_count * kMaxLoad) >= table_size.
        if self.key_count * 2 >= len(self.table):
            self._rehash(len(self.table) * 2)

    def iteration_order(self) -> list[str]:
        return [key for key in self.table if key is not None]


# Effective HTTPHeaderMap insertion sequence of the fixed headers. This is the
# INSERTION order (not the eventual bucket/iteration order), and it is read
# directly from Chromium 149.0.7827.155 (blob SHAs: hashmap-emulation-report.md /
# expansion-fix-report.md). The caller headers precede all of these
# (core/fetch/fetch_manager.cc:1128-1130, AddHttpHeaderField over the sorted
# FetchHeaderList multimap).
#
#   platform/loader/fetch/resource_request_utils.cc:146 UpgradeResourceRequestForLoader
#     :166  context.UpgradeResourceRequestForLoader
#            -> core/loader/frame_fetch_context.cc:994-1002
#               :1000 AddClientHintsIfNecessary (:622)
#                     Set sec-ch-ua @737, sec-ch-ua-mobile @748, sec-ch-ua-platform @761
#               :1001 AddReducedAcceptLanguageIfNecessary (:911) -- no-op, because
#                     kReduceAcceptLanguage / kReduceAcceptLanguageHTTP are
#                     FEATURE_DISABLED_BY_DEFAULT (services/network/public/cpp/features.cc:204,214)
#     :214  context.PrepareRequest
#            -> core/loader/frame_fetch_context.cc:410
#               :419 SetHTTPUserAgent            -> Set User-Agent
#               :455 probe::PrepareRequest -> Set Accept-Language ONLY when a
#                    DevTools session set an override; real Chrome has none:
#                    -> core/inspector/inspector_emulation_agent.cc:626-636
#                       (Emulation.setUserAgentOverride acceptLanguage, which is
#                       what Playwright's `locale` uses; skips a page-set key)
#                    -> core/inspector/inspector_network_agent.cc:1524-1547
#                       (Network.setExtraHTTPHeaders; overwrites)
#
# The earlier sequence (platform, sec-ch-ua, User-Agent, Accept-Language,
# mobile) was a fitted permutation that happened to reproduce the 33 derivation
# captures; it fails the 10-key expansion boundary (expansion-sweep n5/alt5/alt6)
# and the M1 discriminators because it reverses which key wins a shared home
# bucket. With the real order the 8-bucket initial table reproduces everything.
#
# Real Chrome (no DevTools) never puts Accept-Language into this map; //net adds
# it in URLRequestHttpJob::AddExtraHeaders (url_request_http_job.cc:784-797)
# after Accept-Encoding and only if the request does not already carry one.
FIXED_MAP_INSERTION = (
    "sec-ch-ua",
    "sec-ch-ua-mobile",
    "sec-ch-ua-platform",
    "User-Agent",
)

# Playwright `newContext({locale})` capture harness: DevTools inserts
# Accept-Language as a fifth fixed key. Fixture interpretation only.
HARNESS_MAP_INSERTION = FIXED_MAP_INSERTION + ("Accept-Language",)

# Added after PopulateResourceRequest has iterated HTTPHeaderMap.
DOWNSTREAM_SUFFIX = (
    "sec-fetch-site",
    "sec-fetch-mode",
    "sec-fetch-dest",
    "referer",
)


def _ascii_case_key(name: str) -> bytes:
    data = name.encode("latin-1")
    return bytes(ch + 0x20 if 0x41 <= ch <= 0x5A else ch for ch in data)


def predict(
    caller_names: Iterable[str],
    fixed_map_insertion: Sequence[str] = FIXED_MAP_INSERTION,
) -> list[str]:
    """Return non-pseudo HTTP/2 header names in Chrome wire order."""
    # FetchHeaderList is a case-insensitive std::multimap. A set has at most one
    # entry per name, and insertion spelling/order cannot affect this sort.
    unique: dict[bytes, str] = {}
    for name in caller_names:
        name.encode("latin-1")  # Header names are byte strings in this path.
        unique.setdefault(_ascii_case_key(name), name)
    sorted_caller = [unique[key] for key in sorted(unique)]

    header_map = WtfHashMap()
    for name in sorted_caller:
        header_map.insert(name)
    for name in fixed_map_insertion:
        header_map.insert(name)

    order = [name.lower() for name in header_map.iteration_order()]
    # SetAcceptHeader adds */* only when caller Accept was absent.
    if "accept" not in order:
        order.append("accept")
    order.extend(DOWNSTREAM_SUFFIX)
    # URLRequestHttpJob::AddExtraHeaders: Accept-Encoding, then Accept-Language,
    # each only if the request does not already carry it (SetHeaderIfMissing).
    if "accept-encoding" not in order:
        order.append("accept-encoding")
    if "accept-language" not in order:
        order.append("accept-language")
    # CreateSpdyHeadersFromHttpRequest appends default Priority only if absent.
    if "priority" not in order:
        order.append("priority")
    return order


ALIASES = {
    "accept": "Accept",
    "priority": "Priority",
    "uir": "Upgrade-Insecure-Requests",
    "lang": "Accept-Language",
    "ctype": "Content-Type",
    "custom": "X-Custom-Probe",
    "cachectl": "Cache-Control",
}


def load_captures(path: Path, label_prefix: str | None = None) -> dict[str, dict[str, object]]:
    raw = json.loads(path.read_text())
    if not isinstance(raw, dict):
        raise ValueError("capture file must contain an object of named cases")
    captures: dict[str, dict[str, object]] = {}
    for label, capture in raw.items():
        if label.startswith("__"):  # e.g. m1-capture.json "__summary"
            continue
        if label_prefix and not label.startswith(label_prefix):
            continue
        if not isinstance(capture, dict) or "order" not in capture:
            raise ValueError(f"case {label!r} has no 'order'")
        captures[label] = capture
    return captures


def caller_names(capture: dict[str, object]) -> list[str]:
    """Caller header names of a capture; accepts caller / caller_names / sent."""
    names = capture.get("caller")
    if names is None:
        names = capture.get("caller_names")
    if names is None and isinstance(capture.get("sent"), dict):
        names = list(capture["sent"].keys())  # type: ignore[union-attr]
    if not isinstance(names, list):
        raise ValueError("capture has no caller / caller_names / sent")
    return [ALIASES.get(str(name), str(name)) for name in names]


def validate(
    path: Path,
    verbose: bool = True,
    exclude_caller: Sequence[str] = (),
    label_prefix: str | None = None,
    harness: bool = False,
) -> tuple[int, int]:
    fixed_map_insertion = HARNESS_MAP_INSERTION if harness else FIXED_MAP_INSERTION
    captures = load_captures(path, label_prefix)
    excluded = {_ascii_case_key(name) for name in exclude_caller}
    matches = 0
    total = 0
    for label, capture in captures.items():
        caller = caller_names(capture)
        if excluded and any(_ascii_case_key(name) in excluded for name in caller):
            if verbose:
                print(f"SKIP {label} (excluded caller header)")
            continue
        total += 1
        expected = capture["order"]
        got = predict(caller, fixed_map_insertion)
        ok = got == expected
        matches += int(ok)
        if verbose:
            print(f"{'PASS' if ok else 'FAIL'} {label}")
            if not ok:
                print(f"  got:      {' '.join(got)}")
                print(f"  expected: {' '.join(expected)}")
    return matches, total


PHANTOM_CANDIDATES = (
    "X-Requested-With",
    "Host",
    "Connection",
    "Priority",
    "Sec-Fetch-Storage-Access",
    "Cache-Control",
    "Pragma",
    "Origin",
    "Content-Length",
)


def _predict_with_phantoms(caller_names: Sequence[str], phantoms: Sequence[str], phase: str) -> list[str]:
    """Research model: insert candidates, then drop non-caller phantom keys."""
    caller_keys = {_ascii_case_key(name) for name in caller_names}
    sorted_caller = sorted(caller_names, key=_ascii_case_key)
    header_map = WtfHashMap()
    phases = {
        "before": (phantoms, sorted_caller, HARNESS_MAP_INSERTION),
        "middle": (sorted_caller, phantoms, HARNESS_MAP_INSERTION),
        "after": (sorted_caller, HARNESS_MAP_INSERTION, phantoms),
    }[phase]
    for group in phases:
        for name in group:
            header_map.insert(name)
    phantom_keys = {_ascii_case_key(name) for name in phantoms}
    order = [
        name.lower()
        for name in header_map.iteration_order()
        if _ascii_case_key(name) not in phantom_keys or _ascii_case_key(name) in caller_keys
    ]
    if "accept" not in order:
        order.append("accept")
    order.extend(DOWNSTREAM_SUFFIX)
    if "accept-encoding" not in order:
        order.append("accept-encoding")
    if "accept-language" not in order:
        order.append("accept-language")
    if "priority" not in order:
        order.append("priority")
    return order


def research(path: Path) -> None:
    """Hypothesis sweeps over a harness-captured corpus (always harness mode)."""
    captures = load_captures(path)
    exact, total = validate(path, verbose=False, harness=True)
    print(f"winning staged HTTPHeaderMap model: {exact}/{total}")

    all_visible_defaults = HARNESS_MAP_INSERTION + ("Accept",) + DOWNSTREAM_SUFFIX

    def old_single_map(caller: Sequence[str]) -> list[str]:
        header_map = WtfHashMap()
        for name in sorted(caller, key=_ascii_case_key):
            header_map.insert(name)
        for name in all_visible_defaults:
            header_map.insert(name)
        result = [name.lower() for name in header_map.iteration_order()]
        result.append("accept-encoding")
        if "priority" not in result:
            result.append("priority")
        return result

    old_matches = 0
    cases: list[tuple[list[str], list[str]]] = []
    for capture in captures.values():
        caller = caller_names(capture)
        expected = capture["order"]  # type: ignore[index]
        cases.append((caller, expected))
        old_matches += int(old_single_map(caller) == expected)
    print(f"rejected all-wire-headers-in-one-map model: {old_matches}/{total}")

    def old_map_with_phantoms(
        caller: Sequence[str], phantoms: Sequence[str], phase: str
    ) -> list[str]:
        caller_keys = {_ascii_case_key(name) for name in caller}
        sorted_caller = sorted(caller, key=_ascii_case_key)
        header_map = WtfHashMap()
        phases = {
            "before": (phantoms, sorted_caller, all_visible_defaults),
            "middle": (sorted_caller, phantoms, all_visible_defaults),
            "after": (sorted_caller, all_visible_defaults, phantoms),
        }[phase]
        for group in phases:
            for name in group:
                header_map.insert(name)
        phantom_keys = {_ascii_case_key(name) for name in phantoms}
        result = [
            name.lower()
            for name in header_map.iteration_order()
            if _ascii_case_key(name) not in phantom_keys
            or _ascii_case_key(name) in caller_keys
        ]
        result.append("accept-encoding")
        if "priority" not in result:
            result.append("priority")
        return result

    old_phantom_best = (-1, "", 0)
    old_phantom_exact = 0
    for phase in ("before", "middle", "after"):
        for mask in range(1, 1 << len(PHANTOM_CANDIDATES)):
            phantoms = [
                name for bit, name in enumerate(PHANTOM_CANDIDATES) if mask & (1 << bit)
            ]
            score = sum(
                old_map_with_phantoms(caller, phantoms, phase) == expected
                for caller, expected in cases
            )
            if score > old_phantom_best[0]:
                old_phantom_best = (score, phase, mask)
            old_phantom_exact += int(score == total)
    _, old_best_phase, old_best_mask = old_phantom_best
    old_best_names = [
        name
        for bit, name in enumerate(PHANTOM_CANDIDATES)
        if old_best_mask & (1 << bit)
    ]
    print(
        f"all-visible-map phantom sweep: {old_phantom_exact} non-empty exact subsets; "
        f"best={old_phantom_best[0]}/{total}, phase={old_best_phase}, keys={old_best_names}"
    )

    best_nonempty = (-1, "", 0)
    exact_nonempty: list[tuple[str, int]] = []
    for phase in ("before", "middle", "after"):
        for mask in range(1, 1 << len(PHANTOM_CANDIDATES)):
            phantoms = [
                name for bit, name in enumerate(PHANTOM_CANDIDATES) if mask & (1 << bit)
            ]
            score = sum(
                _predict_with_phantoms(caller, phantoms, phase) == expected
                for caller, expected in cases
            )
            if score > best_nonempty[0]:
                best_nonempty = (score, phase, mask)
            if score == total:
                exact_nonempty.append((phase, mask))
    _, best_phase, best_mask = best_nonempty
    best_names = [
        name for bit, name in enumerate(PHANTOM_CANDIDATES) if best_mask & (1 << bit)
    ]
    print(
        f"winning-model phantom sweep: {len(exact_nonempty)} non-empty exact subsets; "
        f"best={best_nonempty[0]}/{total}, phase={best_phase}, keys={best_names}"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("headers", nargs="*", help="effective caller-supplied header names")
    parser.add_argument("--json", action="store_true", help="emit the prediction as JSON")
    parser.add_argument(
        "--harness",
        action="store_true",
        help="reproduce the Playwright locale capture harness (DevTools inserts "
        "Accept-Language into the map) instead of real Chrome",
    )
    parser.add_argument("--validate", type=Path, metavar="CAPTURES", help="validate all capture cases")
    parser.add_argument("--research", type=Path, metavar="CAPTURES", help="run hypothesis/phantom sweeps")
    parser.add_argument(
        "--exclude-caller",
        action="append",
        default=[],
        metavar="NAME",
        help="with --validate: skip cases whose caller set contains NAME (repeatable)",
    )
    parser.add_argument(
        "--label-prefix",
        metavar="PREFIX",
        help="with --validate: only consider cases whose label starts with PREFIX",
    )
    args = parser.parse_args()

    self_check()
    if args.validate:
        matches, total = validate(
            args.validate,
            exclude_caller=args.exclude_caller,
            label_prefix=args.label_prefix,
            harness=args.harness,
        )
        print(f"{matches}/{total} exact matches")
        if matches != total:
            raise SystemExit(1)
        return
    if args.research:
        research(args.research)
        return
    result = predict(args.headers, HARNESS_MAP_INSERTION if args.harness else FIXED_MAP_INSERTION)
    print(json.dumps(result) if args.json else " ".join(result))


if __name__ == "__main__":
    main()
