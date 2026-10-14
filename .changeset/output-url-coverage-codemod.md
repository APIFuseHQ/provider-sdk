---
"@apifuse/provider-sdk": minor
---

Add the output URL coverage report and the `apifuse migrate-url-kinds` codemod
(openspec `add-output-url-kinds`, group 2).

`apifuse check` prints two warnings under "Output URL coverage" and never fails
on them: `output-url-unclassified` (a recorded fixture output holds an absolute
URL, or the schema declares `format: "uri"`, at a string field no URL kind
helper declares) and `output-url-item-coverage` (an output with an object array
declares no `image()`, `imageList()` or `itemPage()` field and the operation has
no `noMedia`). Each warning names the operation, the path and how to turn it
off.

`apifuse migrate-url-kinds [path] [--check] [--json] [--no-typecheck]` declares
fleet-named output fields (`image_url`, `thumbnail_url`, `image_urls`,
`thumbnail_urls`, `url`) whose recorded fixture values are absolute URLs with
the helpers, dropping the field's own `.nullable()`, wraps the mapper
assignments it can trace in the constructors, marks other URL fields
`TODO(url-kind)`, lists what it left alone with the reason, and reports the
type errors its edits introduce. A second run changes nothing.
