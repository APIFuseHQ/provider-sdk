---
"@apifuse/provider-sdk": minor
---

Add the operation `agent` contract: `OperationDefinition.agent?: OperationAgentContract` (annotations, serverOnly, handles, secureInput, errors guidance, normalizers, projection, facts, terms, policy) and `meta.agent.descriptionKey`, the one factual line an agent host reads for the provider. `defineProvider` fails the build when a declared path is not in the operation's input or output schema, a consumed handle kind has no single producer, an `errors` key is not a declared error code, `annotations.readOnly`/`destructive` contradict `riskClass`, or an operation declares `agent` without `meta.agent.descriptionKey`; `apifuse check` fails when a referenced locale key is missing from `locales/en.json` or a `{op:<id>}` placeholder names no operation. The contract snapshot carries `agent` verbatim.
