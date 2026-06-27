export interface PaginationInfo {
	page: number;
	perPage: number;
	total: number;
	totalPages: number;
	hasNext: boolean;
	hasPrev: boolean;
}

function toPositiveInteger(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) {
		return Math.trunc(value);
	}

	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number.parseInt(value, 10);
		return Number.isNaN(parsed) ? null : parsed;
	}

	return null;
}

function readPath(raw: unknown, path: string): unknown {
	if (!raw || typeof raw !== "object") {
		return undefined;
	}

	let current: unknown = raw;
	for (const segment of path.split(".")) {
		if (!current || typeof current !== "object") {
			return undefined;
		}

		current = (current as Record<string, unknown>)[segment];
	}

	return current;
}

/**
 * Extract pagination info from various REST API response shapes.
 * Handles: {page, per_page, total}, {meta: {pagination: {...}}}, {currentPage, totalCount, pageSize}
 */
export function extractPagination(raw: unknown): PaginationInfo | null {
	const candidates = [
		{
			page: readPath(raw, "page"),
			perPage: readPath(raw, "per_page"),
			total: readPath(raw, "total"),
		},
		{
			page: readPath(raw, "meta.pagination.page"),
			perPage: readPath(raw, "meta.pagination.per_page"),
			total: readPath(raw, "meta.pagination.total"),
		},
		{
			page: readPath(raw, "meta.pagination.currentPage"),
			perPage: readPath(raw, "meta.pagination.pageSize"),
			total: readPath(raw, "meta.pagination.totalCount"),
		},
		{
			page: readPath(raw, "currentPage"),
			perPage: readPath(raw, "pageSize"),
			total: readPath(raw, "totalCount"),
		},
	];

	for (const candidate of candidates) {
		const page = toPositiveInteger(candidate.page);
		const perPage = toPositiveInteger(candidate.perPage);
		const total = toPositiveInteger(candidate.total);

		if (page === null || perPage === null || total === null) {
			continue;
		}

		const totalPages = perPage > 0 ? Math.ceil(total / perPage) : 0;

		return {
			page,
			perPage,
			total,
			totalPages,
			hasNext: page < totalPages,
			hasPrev: page > 1,
		};
	}

	return null;
}

function extractMessage(value: unknown): string | null {
	if (typeof value === "string" && value.trim() !== "") {
		return value;
	}

	if (!value || typeof value !== "object") {
		return null;
	}

	const record = value as Record<string, unknown>;

	if (typeof record.message === "string" && record.message.trim() !== "") {
		return record.message;
	}

	if (typeof record.error === "string" && record.error.trim() !== "") {
		return record.error;
	}

	return null;
}

/**
 * Normalize error response to a standard format.
 * Handles: {error: string}, {message: string}, {errors: []}, {error: {message: string}}
 */
export function normalizeErrorResponse(
	raw: unknown,
): { message: string; code?: string } | null {
	if (!raw || typeof raw !== "object") {
		return null;
	}

	const record = raw as Record<string, unknown>;

	const directMessage =
		extractMessage(record.error) ?? extractMessage(record.message);
	if (directMessage) {
		const code =
			typeof record.code === "string" && record.code.trim() !== ""
				? record.code
				: undefined;
		return code ? { message: directMessage, code } : { message: directMessage };
	}

	const errors = record.errors;
	if (Array.isArray(errors) && errors.length > 0) {
		for (const item of errors) {
			const message = extractMessage(item);
			if (message) {
				const code =
					typeof record.code === "string" && record.code.trim() !== ""
						? record.code
						: undefined;
				return code ? { message, code } : { message };
			}
		}
	}

	return null;
}
