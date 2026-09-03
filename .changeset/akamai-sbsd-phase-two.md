---
"@apifuse/provider-sdk": major
---

Add opt-in Akamai SBSD response classification and the SDK-owned safe-read
challenge transaction: the initiating stealth session now supplies its exact
proxy-bound transport, cookie jar, and profile headers to the resolver, then
refetches an eligible original GET or HEAD once after a successful solve.

Breaking surface: `StealthResponse` gains typed challenge classification for
`resolver_unavailable`, `replay_required`, and `challenge_persisted` outcomes.
Successful solves are represented only by the unclassified refetched response;
unsafe requests are never replayed automatically.
