import { z } from "zod";

import { recordOutputUrlDrop } from "./runtime/output-url-observer.js";
import type { NoMediaDeclaration } from "./types.js";

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
	/** The value as received (absent for credential-bearing URLs). */
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
	 * Without it such values are dropped.
	 */
	base?: string | URL;
	/** Static label of the output field for observation events, e.g. `items[].image_url`. */
	field?: string;
}

/** Options of `toImageUrl()` and `toImageUrls()`. */
export interface ImageUrlOptions extends OutputUrlOptions {
	/**
	 * Hosts whose `http://` images the upstream also serves at the same path over
	 * `https://` (measured). Their images are upgraded; any other `http://` image
	 * is dropped.
	 */
	upgradeHttp?: readonly string[];
}

const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;
const HTTP_PREFIX = /^(https?):\/\//i;
// Literal IPv4/IPv6 hosts, localhost, internal-only names and single-label
// names never belong in public output: consumers load images and open links
// from them. Kept equal to the playground's URL admission rules.
const BLOCKED_HOST =
	/^(\d{1,3}(\.\d{1,3}){3}|\[[^\]]*\]|localhost|.+\.(local|internal|localhost)|[^.]+)$/i;
const HOST_CHARACTERS = /^[a-z0-9_.-]+$/;

type Classification =
	| { status: "ok"; url: string }
	| { status: "absent" }
	| { status: "dropped"; reason: OutputUrlDropReason };

const ABSENT: Classification = { status: "absent" };

function dropped(reason: OutputUrlDropReason): Classification {
	return { status: "dropped", reason };
}

function normalizedHost(hostname: string): string {
	return hostname.toLowerCase().replace(/\.+$/, "");
}

function resolveBase(base: string | URL | undefined, caller: string): URL | undefined {
	if (base === undefined) return undefined;
	let parsed: URL;
	try {
		parsed = new URL(String(base));
	} catch {
		throw new TypeError(`${caller}: base must be an absolute http(s) URL, got ${String(base)}.`);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
		throw new TypeError(`${caller}: base must be an absolute http(s) URL, got ${String(base)}.`);
	return parsed;
}

function classify(
	raw: unknown,
	kind: OutputUrlKind,
	base: URL | undefined,
	upgradeHosts: ReadonlySet<string>,
): Classification {
	if (raw === undefined || raw === null) return ABSENT;
	const text = raw instanceof URL ? raw.href : raw;
	if (typeof text !== "string") return dropped("not_url");
	const trimmed = text.trim();
	if (trimmed.length === 0) return ABSENT;

	let candidate = trimmed;
	if (!SCHEME_PREFIX.test(candidate)) {
		if (!base) return dropped("relative");
		try {
			candidate = new URL(candidate, base).href;
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
	const host = normalizedHost(url.hostname);
	if (host.length === 0 || BLOCKED_HOST.test(host) || !HOST_CHARACTERS.test(host))
		return dropped("host");
	if (kind === "image" && scheme === "http") {
		if (!upgradeHosts.has(host)) return dropped("insecure");
		candidate = `https${candidate.slice("http".length)}`;
	}
	return { status: "ok", url: candidate };
}

// Any authority with `@` may carry a user name or password, whatever the
// scheme and whether or not it parses, so such values never reach the log.
const USERINFO_AUTHORITY = /^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/?#]*@/i;

function exampleValue(raw: unknown, reason: OutputUrlDropReason): string | undefined {
	if (reason === "credentials") return undefined;
	const text = raw instanceof URL ? raw.href : typeof raw === "string" ? raw.trim() : undefined;
	if (text === undefined) return `[${typeof raw}]`;
	return USERINFO_AUTHORITY.test(text) ? undefined : text;
}

function construct(
	raw: unknown,
	kind: OutputUrlKind,
	options: ImageUrlOptions,
	caller: string,
): string | undefined {
	const base = resolveBase(options.base, caller);
	const upgradeHosts = new Set((options.upgradeHttp ?? []).map((host) => normalizedHost(host)));
	const result = classify(raw, kind, base, upgradeHosts);
	if (result.status === "ok") return result.url;
	if (result.status === "dropped") {
		const value = exampleValue(raw, result.reason);
		recordOutputUrlDrop({
			kind,
			reason: result.reason,
			...(options.field === undefined ? {} : { field: options.field }),
			...(value === undefined ? {} : { value }),
		});
	}
	return undefined;
}

/**
 * The picture URL to publish, or `undefined`. Keeps absolute `https://` URLs on
 * public hosts byte for byte; resolves relative values against `base`;
 * upgrades `http://` only for `upgradeHttp` hosts. Every other value is left
 * out and reported as an observation event; the operation never fails over it.
 */
export function toImageUrl(raw: unknown, options: ImageUrlOptions = {}): ImageUrl | undefined {
	return construct(raw, "image", options, "toImageUrl") as ImageUrl | undefined;
}

/** `toImageUrl()` over a list: order kept, left-out values skipped, duplicates removed. */
export function toImageUrls(
	raws: readonly unknown[] | null | undefined,
	options: ImageUrlOptions = {},
): ImageUrl[] {
	if (raws === null || raws === undefined) return [];
	const seen = new Set<string>();
	const out: ImageUrl[] = [];
	for (const raw of raws) {
		const url = toImageUrl(raw, options);
		if (url === undefined || seen.has(url)) continue;
		seen.add(url);
		out.push(url);
	}
	return out;
}

/** The item's own page URL (`http(s)://`, public host), or `undefined`. */
export function toItemPageUrl(
	raw: unknown,
	options: OutputUrlOptions = {},
): ItemPageUrl | undefined {
	return construct(raw, "item_page", options, "toItemPageUrl") as ItemPageUrl | undefined;
}

/** Any other output URL (`http(s)://`, public host), or `undefined`. */
export function toLinkUrl(raw: unknown, options: OutputUrlOptions = {}): LinkUrl | undefined {
	return construct(raw, "link", options, "toLinkUrl") as LinkUrl | undefined;
}

const TEMPLATE_PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

/**
 * Assembles the item's page URL from an absolute template such as
 * `https://www.example.com/items/{item_id}`. Each value is percent-encoded as
 * one URL component. A missing (`null`, `undefined`, empty) value yields
 * `undefined`; a placeholder without a value entry is a code defect and throws.
 */
export function itemPageFrom(
	template: string,
	values: Readonly<Record<string, string | number | null | undefined>>,
	options: Pick<OutputUrlOptions, "field"> = {},
): ItemPageUrl | undefined {
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
	if (absent) return undefined;
	return toItemPageUrl(url, options);
}

/** Schema-side check: the value is exactly what a constructor would publish. */
function isPublishable(value: string, kind: OutputUrlKind): boolean {
	const result = classify(value, kind, undefined, new Set());
	return result.status === "ok" && result.url === value;
}

const SCHEMA_MESSAGES: Record<OutputUrlKind, string> = {
	image:
		"Expected an absolute https:// image URL on a public host. Build the value with toImageUrl().",
	item_page:
		"Expected an absolute http(s):// item page URL on a public host. Build the value with toItemPageUrl() or itemPageFrom().",
	link: "Expected an absolute http(s):// URL on a public host. Build the value with toLinkUrl().",
};

function outputUrlSchema(kind: OutputUrlKind, meta: Record<string, unknown>) {
	return z
		.url()
		.refine((value) => isPublishable(value, kind), { message: SCHEMA_MESSAGES[kind] })
		.meta(meta);
}

/**
 * Output field holding one picture of the item. Emits `format: "uri"` and
 * `x-apifuse-url-kind: "image"` (plus `x-apifuse-image-role: "thumbnail"`)
 * on the JSON Schema node. Fill it with `toImageUrl()`.
 */
export function image(options: ImageFieldOptions = {}): z.ZodType<ImageUrl, string> {
	return outputUrlSchema("image", {
		[APIFUSE_URL_KIND_META_KEY]: "image",
		...(options.thumbnail ? { [APIFUSE_IMAGE_ROLE_META_KEY]: "thumbnail" } : {}),
	}) as unknown as z.ZodType<ImageUrl, string>;
}

/** Output field holding several pictures of the item, in upstream order. Fill it with `toImageUrls()`. */
export function imageList(
	options: ImageFieldOptions = {},
): z.ZodArray<z.ZodType<ImageUrl, string>> {
	return z.array(image(options));
}

/** Output field holding the item's own human-facing page. Fill it with `toItemPageUrl()` or `itemPageFrom()`. */
export function itemPage(): z.ZodType<ItemPageUrl, string> {
	return outputUrlSchema("item_page", {
		[APIFUSE_URL_KIND_META_KEY]: "item_page",
	}) as unknown as z.ZodType<ItemPageUrl, string>;
}

/** Output field holding any other URL (source, download, booking, map image). Fill it with `toLinkUrl()`. */
export function link(): z.ZodType<LinkUrl, string> {
	return outputUrlSchema("link", {
		[APIFUSE_URL_KIND_META_KEY]: "link",
	}) as unknown as z.ZodType<LinkUrl, string>;
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
