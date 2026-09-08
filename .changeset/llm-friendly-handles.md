---
"@apifuse/provider-sdk": major
---

Replace choice tokens with LLM-friendly handles per ADR-0012. `ctx.choice`,
the encrypted inline token envelope, `src/choice-token.ts`, every
`ProviderChoice*` type, `createTestProviderChoiceContext`, and the
`APIFUSE__PROVIDER_RUNTIME__CHOICE_TOKEN_MASTER_SECRET` setting are removed
with no alias or dual-read window; tokens minted by earlier versions are
invalid once a provider bumps its pin. Providers declare
`handle: [Kind, ...]` (with `state`) using `defineCursor` / `defineDraft`,
place `kind.field()` on schemas, and use `ctx.handle.create/read/update/commit/discard`
plus `pick` for plain-key selections. Handles are `kind_word-word` (bound, 2
words) or `kind_word-word-word-word[-word]` (public cursors), normalized
tolerantly on read. New lint rules: `handle-kind-undeclared`,
`handle-field-name`, `handle-field-parity`, `handle-issued-by`,
`handle-requires-state`, `legacy-choice-usage`. Migration guide:
`docs/migrations/handle.md`; decision record: `docs/adr/0012-llm-friendly-handles.md`.
