---
"@apifuse/provider-sdk": minor
---

Add `apifuse migrate-deployment`, a codemod that retires a provider
repository's standalone `deploy.ts`. Deployment intent has exactly one home —
the `deployment` key on `defineProvider({...})` — and only the fields that
differ from the runtime profile belong there. The command reads the legacy
file, subtracts the profile defaults (shared `25m/128Mi`, browser
`200m/256Mi`, HPA `1-1-70`, `replicas: 1`, `language: "typescript"`), proves
the resulting key resolves to exactly what the file declared, writes it into
the declaration (or removes a `deployment` extra from a
`{ ...provider, deployment }` default export and the matching
`import ... from "./deploy"`), and deletes `deploy.ts`. The `/deploy.ts`
CODEOWNERS lock is kept until the platform retires its legacy fallback
(`--drop-codeowners-lock` afterwards). Anything it cannot fully account for — a
declaration or spread it cannot read statically, a value mutated after its
initializer, a type imported from `./deploy` still in use, another repository
source importing the module — is refused with a reason (exit 1) instead of
partially migrated. Verified against all
91 fleet `deploy.ts` shapes: 90 migrate (40 to zero configuration), 1 refuses
(declaration built by a factory call).

`apifuse check` gains three warning-only deployment rules ahead of their
promotion to errors once the fleet has migrated: `deployment/legacy-deploy-file`
(a `deploy.ts` is still present), `deployment/spread-export` (a `deployment`
extra rides `export default { ...provider, deployment }`), and
`deployment/redundant-default` (a declared `deployment` field restates the
profile default).
