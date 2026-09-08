---
"@apifuse/provider-sdk": patch
---

Flag more untranslated-placeholder markers in `validateProviderLocaleCatalogs`: `FIXME`, `TBD`, `TRANSLATE`, `[en]`/`[ko]`/`[ja]` locale tags, `번역 필요`, and `翻訳が必要` now produce the same "is empty or placeholder text" issue as `TODO`. ASCII tokens are matched case-sensitively as whole tokens so prose such as "todo list" or "TBDx" is no longer reported.
