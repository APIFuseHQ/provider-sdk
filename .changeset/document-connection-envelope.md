---
"@apifuse/provider-sdk": patch
---

Document the request envelope's connection fields: the top-level `connectionId` (identity only, sent by the gateway for `optional` connection mode when the caller supplied an authorized connection, exposed as `ctx.request.connectionId`), the credential-bearing `connection` (sent for `required` mode, omitted for `none` mode), and the precedence rule when a malformed envelope carries both (a non-empty nested `connection.id` wins). The same text is added to the generated provider README template. An HTTP-boundary test pins that precedence at `POST /v1/{operation}`. No runtime behavior change.
