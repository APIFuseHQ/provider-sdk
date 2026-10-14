---
"@apifuse/provider-sdk": minor
---

Add output URL kind primitives for item pictures and item pages.

- Schema helpers `image()`, `image({ thumbnail: true })`, `imageList()`, `itemPage()` and `link()` emit `format: "uri"` plus `x-apifuse-url-kind: image | item_page | link` (and `x-apifuse-image-role: thumbnail`) on the JSON Schema node, and validate absolute `https://` images and `http(s)://` pages and links on public hosts.
- Mapper constructors `toImageUrl()`, `toImageUrls()`, `toItemPageUrl()`, `itemPageFrom()` and `toLinkUrl()` keep valid URLs byte for byte, resolve relative values against a declared `base`, upgrade `http://` images only for declared `upgradeHttp` hosts, and leave every other value out. Each left-out value is reported in the request log under `events.outputUrlDropped`; the operation never fails over it.
- Value types `ImageUrl`, `ItemPageUrl` and `LinkUrl` reject a plain `string` at compile time and are not interchangeable.
- `noMedia(reason)` and the operation key `noMedia` record that an operation's items have no picture and no own page upstream; the contract snapshot carries it.
- Declaration rules `output-url-kind-unique` (one `itemPage()` and one non-thumbnail `image()` per object) and `no-media-contradiction`.

This is a minor release because it only adds optional authoring surface; plain string fields keep working unchanged.
