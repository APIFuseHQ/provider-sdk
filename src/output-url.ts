import { z } from "zod";

import { recordOutputUrlDrop } from "./runtime/output-url-observer.js";
import type { NoMediaDeclaration } from "./types.js";
import { isPublicUrlHost } from "./url-host.js";

/** JSON Schema key that names what an output URL string points at. */
export const APIFUSE_URL_KIND_META_KEY = "x-apifuse-url-kind";
/** JSON Schema key that marks an image URL as a smaller rendition of the item's picture. */
export const APIFUSE_IMAGE_ROLE_META_KEY = "x-apifuse-image-role";

/**
 * Closed set of output URL kinds.
 * - `image`: a picture of the item (absolute `https://` only).
 * - `item_page`: the item's own human-facing page.
 * - `link`: any other URL (source, download, booking, map image, ...).
 */
export const OUTPUT_URL_KINDS = ["image", "item_page", "link"] as const;
/** One of `OUTPUT_URL_KINDS`. */
export type OutputUrlKind = (typeof OUTPUT_URL_KINDS)[number];

/** Why an output-URL constructor left a value out. */
export const OUTPUT_URL_DROP_REASONS = [
	"not_url",
	"relative",
	"scheme",
	"insecure",
	"host",
	"credentials",
] as const;
/** One of `OUTPUT_URL_DROP_REASONS`. */
export type OutputUrlDropReason = (typeof OUTPUT_URL_DROP_REASONS)[number];

/** One value an output-URL constructor left out, as reported to the request log. */
export interface OutputUrlDrop {
	/** Kind of the constructor that left the value out. */
	kind: OutputUrlKind;
	/** Why the value was left out. */
	reason: OutputUrlDropReason;
	/** Static field label the mapper passed, e.g. `items[].image_url`. */
	field?: string;
	/**
	 * The value as received; `[<typeof>]` (e.g. `[number]`) for a value that is
	 * neither a string nor a `URL`; only the scheme (`mailto:`) for reason
	 * `scheme`; absent for a value whose authority carries `@`.
	 */
	value?: string;
}

/** Type-only key that keeps the three URL kinds from being assigned to one another. */
declare const OUTPUT_URL_KIND: unique symbol;

/**
 * An item picture URL. A plain `string` is not assignable; string literals,
 * `https://` template strings and `toImageUrl()` results are. Not
 * interchangeable with `ItemPageUrl` or `LinkUrl`.
 */
export type ImageUrl = `https://${string}` & { readonly [OUTPUT_URL_KIND]?: "image" };
// Pages and links use one template, not `http://${string}` | `https://${string}`:
// a union target would let one kind's value pass as another's.
/** The item's own page URL. Built with `toItemPageUrl()` or `itemPageFrom()`. */
export type ItemPageUrl = `http${string}://${string}` & {
	readonly [OUTPUT_URL_KIND]?: "item_page";
};
/** Any other output URL. Built with `toLinkUrl()`. */
export type LinkUrl = `http${string}://${string}` & { readonly [OUTPUT_URL_KIND]?: "link" };

/** Options of `image()` and `imageList()`. */
export interface ImageFieldOptions {
	/** The URL is a smaller rendition of the item's picture (`x-apifuse-image-role: thumbnail`). */
	thumbnail?: boolean;
}

/** Options of the output URL constructors. */
export interface OutputUrlOptions {
	/**
	 * Absolute `http(s)://` URL that relative (`/files/a.jpg`) and
	 * protocol-relative (`//cdn.example.com/a.jpg`) values resolve against.
	 * Without it such values are dropped. Anything else throws on every call.
	 */
	base?: string | URL;
	/** Static label of the output field for observation events, e.g. `items[].image_url`. */
	field?: string;
}

/** Options of `toImageUrl()` and `toImageUrls()`. */
export interface ImageUrlOptions extends OutputUrlOptions {
	/**
	 * Host names whose `http://` images the upstream also serves at the same
	 * path over `https://` (measured). Their images are upgraded unless the URL
	 * names a port; any other `http://` image is dropped. An entry that is not a
	 * bare host name throws on every call.
	 */
	upgradeHttp?: readonly string[];
}

const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;
const HTTP_PREFIX = /^(https?):\/\//i;
// The authority as written: between `scheme://` and the first `/`, `?` or `#`.
const WRITTEN_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i;

type Classification =
	| { status: "ok"; url: string }
	| { status: "absent" }
	| { status: "dropped"; reason: OutputUrlDropReason };

const ABSENT: Classification = { status: "absent" };

function dropped(reason: OutputUrlDropReason): Classification {
	return { status: "dropped", reason };
}

// ASCII controls and space: the URL parser strips or encodes them, so a value
// carrying them is not the URL every parser reads.
function hasControlOrSpace(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 0x20 || code === 0x7f) return true;
	}
	return false;
}

function normalizedHost(hostname: string): string {
	return hostname.toLowerCase().replace(/\.+$/, "");
}

/** Constructor arguments the author writes, checked on every call before the value. */
type ConstructorArguments = { base: URL | undefined; upgradeHosts: ReadonlySet<string> };

const NO_UPGRADE: ReadonlySet<string> = new Set();

function constructorArguments(options: ImageUrlOptions, caller: string): ConstructorArguments {
	return {
		base: resolveBase(options.base, caller),
		upgradeHosts: upgradeHostSet(options.upgradeHttp, caller),
	};
}

function resolveBase(base: string | URL | undefined, caller: string): URL | undefined {
	if (base === undefined) return undefined;
	let parsed: URL | undefined;
	try {
		parsed = new URL(String(base));
	} catch {
		parsed = undefined;
	}
	if (parsed?.protocol !== "https:" && parsed?.protocol !== "http:")
		throw new TypeError(`${caller}: base must be an absolute http(s) URL, got ${String(base)}.`);
	return parsed;
}

function upgradeHostSet(hosts: readonly string[] | undefined, caller: string): ReadonlySet<string> {
	if (hosts === undefined || hosts.length === 0) return NO_UPGRADE;
	const set = new Set<string>();
	for (const entry of hosts) {
		let parsed: URL | undefined;
		try {
			parsed = typeof entry === "string" ? new URL(`http://${entry}`) : undefined;
		} catch {
			parsed = undefined;
		}
		// Compared the way the URL parser gives a host: punycode, lower case.
		if (!parsed || parsed.href !== `http://${parsed.host}/` || parsed.port !== "")
			throw new TypeError(
				`${caller}: upgradeHttp entries must be host names such as img.example.com, got ${String(entry)}.`,
			);
		set.add(normalizedHost(parsed.hostname));
	}
	return set;
}

function classify(raw: unknown, kind: OutputUrlKind, args: ConstructorArguments): Classification {
	if (raw === undefined || raw === null) return ABSENT;
	const text = raw instanceof URL ? raw.href : raw;
	if (typeof text !== "string") return dropped("not_url");
	const trimmed = text.trim();
	if (trimmed.length === 0) return ABSENT;

	let candidate = trimmed;
	if (!SCHEME_PREFIX.test(candidate)) {
		if (!args.base) return dropped("relative");
		try {
			candidate = new URL(candidate, args.base).href;
		} catch {
			return dropped("not_url");
		}
	}
	// Slash-less forms (`https:host/a.jpg`) parse as absolute without a base but
	// a browser resolves them against the page, so `scheme://` is required.
	const scheme = HTTP_PREFIX.exec(candidate)?.[1]?.toLowerCase();
	if (scheme !== "http" && scheme !== "https")
		return dropped(/^https?:/i.test(candidate) ? "not_url" : "scheme");

	let url: URL;
	try {
		url = new URL(candidate);
	} catch {
		return dropped("not_url");
	}
	if (url.username !== "" || url.password !== "") return dropped("credentials");
	if (!isPublicUrlHost(url.hostname)) return dropped("host");
	if (kind === "image" && scheme === "http") {
		// A named port serves http there; nothing says https answers on it.
		if (url.port !== "" || !args.upgradeHosts.has(normalizedHost(url.hostname)))
			return dropped("insecure");
		url.protocol = "https:";
	}
	// The serialization of the URL that was checked, so the published host is
	// the checked host in every parser. A serialized URL (a signed URL) is
	// returned byte for byte; percent-escapes are never decoded or re-encoded.
	return { status: "ok", url: url.href };
}

// Any authority with `@` may carry a user name or password, whatever the
// scheme and whether or not it parses, so such values never reach the log.
const USERINFO_AUTHORITY = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]*@/i;

function exampleValue(raw: unknown, reason: OutputUrlDropReason): string | undefined {
	if (reason === "credentials") return undefined;
	const text = raw instanceof URL ? raw.href : typeof raw === "string" ? raw.trim() : undefined;
	if (text === undefined) return `[${typeof raw}]`;
	if (USERINFO_AUTHORITY.test(text)) return undefined;
	// A mailto:, tel: or data: value is its whole payload (an address, a
	// number, a picture); the scheme is what locates the mapping defect.
	if (reason === "scheme") return SCHEME_PREFIX.exec(text)?.[0].toLowerCase();
	return text;
}

function reportDrop(
	raw: unknown,
	kind: OutputUrlKind,
	reason: OutputUrlDropReason,
	field: string | undefined,
): void {
	const value = exampleValue(raw, reason);
	recordOutputUrlDrop({
		kind,
		reason,
		...(field === undefined ? {} : { field }),
		...(value === undefined ? {} : { value }),
	});
}

function construct(
	raw: unknown,
	kind: OutputUrlKind,
	args: ConstructorArguments,
	field: string | undefined,
): string | null {
	const result = classify(raw, kind, args);
	if (result.status === "ok") return result.url;
	if (result.status === "dropped") reportDrop(raw, kind, result.reason, field);
	return null;
}

/**
 * The picture URL to publish, or `null` when the upstream gave none or gave
 * one that cannot be published. Publishes the URL's serialization (an already
 * serialized URL, such as a signed URL, byte for byte); resolves relative
 * values against `base`; upgrades `http://` only for `upgradeHttp` hosts.
 * Every other value is left out and reported as an observation event; an
 * upstream value never fails the operation. A malformed `base` or
 * `upgradeHttp` throws on every call, whatever the value.
 */
export function toImageUrl(raw: unknown, options: ImageUrlOptions = {}): ImageUrl | null {
	const args = constructorArguments(options, "toImageUrl");
	return construct(raw, "image", args, options.field) as ImageUrl | null;
}

/**
 * `toImageUrl()` over a list: order kept, left-out values skipped, duplicates
 * removed. A `raws` that is not an array (a single upstream entry, an object)
 * is one left-out value with reason `not_url`.
 */
export function toImageUrls(
	raws: readonly unknown[] | null | undefined,
	options: ImageUrlOptions = {},
): ImageUrl[] {
	const args = constructorArguments(options, "toImageUrls");
	if (raws === null || raws === undefined) return [];
	if (!Array.isArray(raws)) {
		reportDrop(raws, "image", "not_url", options.field);
		return [];
	}
	const seen = new Set<string>();
	const out: ImageUrl[] = [];
	for (const raw of raws) {
		const url = construct(raw, "image", args, options.field) as ImageUrl | null;
		if (url === null || seen.has(url)) continue;
		seen.add(url);
		out.push(url);
	}
	return out;
}

/** The item's own page URL (`http(s)://`, public host), or `null`. */
export function toItemPageUrl(raw: unknown, options: OutputUrlOptions = {}): ItemPageUrl | null {
	const args = constructorArguments(options, "toItemPageUrl");
	return construct(raw, "item_page", args, options.field) as ItemPageUrl | null;
}

/** Any other output URL (`http(s)://`, public host), or `null`. */
export function toLinkUrl(raw: unknown, options: OutputUrlOptions = {}): LinkUrl | null {
	const args = constructorArguments(options, "toLinkUrl");
	return construct(raw, "link", args, options.field) as LinkUrl | null;
}

const TEMPLATE_PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

/**
 * Assembles the item's page URL from an absolute template such as
 * `https://www.example.com/items/{item_id}`. Each value is percent-encoded as
 * one URL component. A missing (`null`, `undefined`, empty) value yields
 * `null`. A template that is not absolute `http(s)://` or a placeholder
 * without a value entry is a code defect and throws on every call.
 */
export function itemPageFrom(
	template: string,
	values: Readonly<Record<string, string | number | null | undefined>>,
	options: Pick<OutputUrlOptions, "field"> = {},
): ItemPageUrl | null {
	if (!HTTP_PREFIX.test(template))
		throw new TypeError(
			`itemPageFrom: template must start with http:// or https://, got ${template}.`,
		);
	let absent = false;
	const url = template.replace(TEMPLATE_PLACEHOLDER, (_match, name: string) => {
		if (!Object.hasOwn(values, name))
			throw new TypeError(`itemPageFrom: no value for placeholder {${name}} in ${template}.`);
		const value = values[name];
		if (value === null || value === undefined) {
			absent = true;
			return "";
		}
		if (typeof value === "number" && !Number.isFinite(value)) {
			absent = true;
			return "";
		}
		const text = String(value).trim();
		if (text.length === 0) absent = true;
		return encodeURIComponent(text);
	});
	if (absent) return null;
	return toItemPageUrl(url, options);
}

/**
 * Schema-side check: the value is one a constructor would accept, and every
 * URL parser reads the host that was checked. A constructor's result always
 * passes; so does a literal such as `https://www.example.com`.
 */
function isPublishable(value: string, kind: OutputUrlKind): boolean {
	if (hasControlOrSpace(value)) return false;
	const result = classify(value, kind, { base: undefined, upgradeHosts: NO_UPGRADE });
	if (result.status !== "ok") return false;
	const written = WRITTEN_AUTHORITY.exec(value)?.[1];
	return written !== undefined && written.toLowerCase() === new URL(result.url).host;
}

const SCHEMA_MESSAGES: Record<OutputUrlKind, string> = {
	image:
		"Expected an absolute https:// image URL on a public host. Build the value with toImageUrl().",
	item_page:
		"Expected an absolute http(s):// item page URL on a public host. Build the value with toItemPageUrl() or itemPageFrom().",
	link: "Expected an absolute http(s):// URL on a public host. Build the value with toLinkUrl().",
};

// The kind brand exists only in the type; at runtime the value stays the
// validated string, so the one cast below only names its brand.
function outputUrlValue<T extends string>(
	kind: OutputUrlKind,
	meta: Record<string, unknown>,
): z.ZodType<T, string> {
	const schema: z.ZodType<string, string> = z
		.url()
		.refine((value) => isPublishable(value, kind), { message: SCHEMA_MESSAGES[kind] })
		.meta(meta);
	return schema as z.ZodType<T, string>;
}

function imageValue(options: ImageFieldOptions): z.ZodType<ImageUrl, string> {
	return outputUrlValue<ImageUrl>("image", {
		[APIFUSE_URL_KIND_META_KEY]: "image",
		...(options.thumbnail ? { [APIFUSE_IMAGE_ROLE_META_KEY]: "thumbnail" } : {}),
	});
}

/**
 * Output field holding one picture of the item, or `null` when there is none:
 * the constructors return `null` for an absent or left-out value, so the field
 * admits it without `.nullable()`. Emits `format: "uri"` and
 * `x-apifuse-url-kind: "image"` (plus `x-apifuse-image-role: "thumbnail"`) on
 * the string branch of the JSON Schema node. Fill it with `toImageUrl()`.
 */
export function image(options: ImageFieldOptions = {}): z.ZodNullable<z.ZodType<ImageUrl, string>> {
	return imageValue(options).nullable();
}

/**
 * Output field holding several pictures of the item, in upstream order; empty
 * when there are none. Fill it with `toImageUrls()`.
 */
export function imageList(
	options: ImageFieldOptions = {},
): z.ZodArray<z.ZodType<ImageUrl, string>> {
	return z.array(imageValue(options));
}

/**
 * Output field holding the item's own human-facing page, or `null`. Fill it
 * with `toItemPageUrl()` or `itemPageFrom()`.
 */
export function itemPage(): z.ZodNullable<z.ZodType<ItemPageUrl, string>> {
	return outputUrlValue<ItemPageUrl>("item_page", {
		[APIFUSE_URL_KIND_META_KEY]: "item_page",
	}).nullable();
}

/**
 * Output field holding any other URL (source, download, booking, map image),
 * or `null`. Fill it with `toLinkUrl()`.
 */
export function link(): z.ZodNullable<z.ZodType<LinkUrl, string>> {
	return outputUrlValue<LinkUrl>("link", { [APIFUSE_URL_KIND_META_KEY]: "link" }).nullable();
}

/**
 * Declares that an operation's items have no picture and no own page upstream,
 * with the evidence: `noMedia: noMedia("Upstream rows carry codes only: ...")`.
 */
export function noMedia(reason: string): NoMediaDeclaration {
	if (typeof reason !== "string" || reason.trim().length === 0)
		throw new TypeError("noMedia(reason) needs a non-empty reason naming the upstream evidence.");
	return Object.freeze({ reason });
}

// ---------------------------------------------------------------------------
// Declaration-time view of the annotations in an output JSON Schema.

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isOutputUrlKind(value: unknown): value is OutputUrlKind {
	return OUTPUT_URL_KINDS.some((kind) => kind === value);
}

function appendPropertyPath(path: string, property: string): string {
	const segment = /^[A-Za-z_][A-Za-z0-9_]*$/.test(property)
		? property
		: `[${JSON.stringify(property)}]`;
	if (path.length === 0 || segment.startsWith("[")) return `${path}${segment}`;
	return `${path}.${segment}`;
}

function localReference(root: JsonRecord, reference: string): unknown {
	if (!reference.startsWith("#/")) return undefined;
	let current: unknown = root;
	for (const encoded of reference.slice(2).split("/")) {
		if (!isRecord(current)) return undefined;
		current = current[encoded.replaceAll("~1", "/").replaceAll("~0", "~")];
	}
	return current;
}

/** One annotated URL leaf of an output schema. */
export interface OutputUrlKindEntry {
	/** Response-value path, e.g. `items[].image_url` (`$` for the root). */
	path: string;
	kind: OutputUrlKind;
	thumbnail: boolean;
}

/** One object of an output schema that declares more than one own page or main picture. */
export interface OutputUrlKindConflict {
	path: string;
	kind: "image" | "item_page";
	properties: string[];
}

/**
 * Walks an output JSON Schema (as `z.toJSONSchema()` emits it) and returns
 * every URL-kind leaf plus the objects that declare more than one
 * `itemPage()` or more than one non-thumbnail single `image()` property.
 */
export function inspectOutputUrlKinds(schema: unknown): {
	entries: OutputUrlKindEntry[];
	conflicts: OutputUrlKindConflict[];
} {
	const entries = new Map<string, OutputUrlKindEntry>();
	const conflicts: OutputUrlKindConflict[] = [];
	if (!isRecord(schema)) return { entries: [], conflicts };
	const root = schema;
	const active = new Set<object>();

	const resolve = (node: unknown, seen = new Set<object>()): JsonRecord | undefined => {
		if (!isRecord(node) || seen.has(node)) return undefined;
		seen.add(node);
		if (typeof node.$ref === "string") return resolve(localReference(root, node.$ref), seen);
		return node;
	};
	// The URL leaf a property holds directly: itself, or the non-null branch of a nullable.
	const singleLeaf = (node: unknown): JsonRecord | undefined => {
		const resolved = resolve(node);
		if (!resolved) return undefined;
		if (isOutputUrlKind(resolved[APIFUSE_URL_KIND_META_KEY])) return resolved;
		for (const keyword of ["anyOf", "oneOf"] as const) {
			const variants = resolved[keyword];
			if (!Array.isArray(variants)) continue;
			const nonNull = variants.filter((variant) => resolve(variant)?.type !== "null");
			if (nonNull.length === 1) return singleLeaf(nonNull[0]);
		}
		return undefined;
	};

	// Properties an object node declares itself or through `allOf` branches
	// (z.intersection): they all land on the same response object.
	const ownProperties = (node: JsonRecord, seen = new Set<object>()): Array<[string, unknown]> => {
		if (seen.has(node)) return [];
		seen.add(node);
		const out: Array<[string, unknown]> = isRecord(node.properties)
			? Object.entries(node.properties)
			: [];
		if (Array.isArray(node.allOf))
			for (const branch of node.allOf) {
				const resolved = resolve(branch);
				if (resolved) out.push(...ownProperties(resolved, seen));
			}
		return out;
	};

	const countConflicts = (node: JsonRecord, path: string): void => {
		const pages = new Set<string>();
		const pictures = new Set<string>();
		for (const [property, schema] of ownProperties(node)) {
			const leaf = singleLeaf(schema);
			if (leaf?.[APIFUSE_URL_KIND_META_KEY] === "item_page") pages.add(property);
			if (
				leaf?.[APIFUSE_URL_KIND_META_KEY] === "image" &&
				leaf[APIFUSE_IMAGE_ROLE_META_KEY] !== "thumbnail"
			)
				pictures.add(property);
		}
		const objectPath = path.length > 0 ? path : "$";
		if (pages.size > 1)
			conflicts.push({ path: objectPath, kind: "item_page", properties: [...pages].sort() });
		if (pictures.size > 1)
			conflicts.push({ path: objectPath, kind: "image", properties: [...pictures].sort() });
	};

	const visit = (candidate: unknown, path: string, allOfBranch = false): void => {
		const node = resolve(candidate);
		if (!node || active.has(node)) return;
		active.add(node);
		try {
			const kind = node[APIFUSE_URL_KIND_META_KEY];
			if (isOutputUrlKind(kind)) {
				const projected = path.length > 0 ? path : "$";
				entries.set(`${projected}\u0000${kind}`, {
					path: projected,
					kind,
					thumbnail: node[APIFUSE_IMAGE_ROLE_META_KEY] === "thumbnail",
				});
			}
			// An allOf branch's properties are counted with its parent object.
			if (!allOfBranch && (isRecord(node.properties) || Array.isArray(node.allOf)))
				countConflicts(node, path);
			const properties = node.properties;
			if (isRecord(properties))
				for (const property of Object.keys(properties).sort())
					visit(properties[property], appendPropertyPath(path, property));
			if (isRecord(node.items)) visit(node.items, `${path}[]`);
			if (Array.isArray(node.prefixItems))
				for (const item of node.prefixItems) visit(item, `${path}[]`);
			if (isRecord(node.additionalProperties)) visit(node.additionalProperties, `${path}.*`);
			if (Array.isArray(node.allOf)) for (const branch of node.allOf) visit(branch, path, true);
			for (const keyword of ["anyOf", "oneOf"] as const) {
				const variants = node[keyword];
				if (Array.isArray(variants)) for (const variant of variants) visit(variant, path);
			}
		} finally {
			active.delete(node);
		}
	};

	visit(root, "");
	return {
		entries: [...entries.values()].sort(
			(left, right) => left.path.localeCompare(right.path) || left.kind.localeCompare(right.kind),
		),
		conflicts,
	};
}
