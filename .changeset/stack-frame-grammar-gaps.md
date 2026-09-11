---
"@apifuse/provider-sdk": patch
---

Fix two grammar gaps in the masked-5xx stack frame whitelist.

A frame that carries its `async`/`new` modifier inline with no parenthesized
location — `at async file:///app/index.mjs:12:3`, the shape V8 emits for an
anonymous async frame such as a module's top-level await — was dropped
entirely, because the modifier left whitespace inside the text handed to the
location parser. The modifier is now split off first, so the frame is emitted
as `async (index.mjs:12:3)` and the call site it names is no longer lost from
`provider_request_failed` logs.

A path whose basename is `.` or `..` (`/srv/app/..:1:1`) satisfied the basename
character class and was re-emitted as `..:1:1`. Such a basename names no file
and is exactly the traversal token the grammar exists to exclude; it is now
rejected like any other frame that does not fit the grammar.
