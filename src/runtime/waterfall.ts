import type { Span } from "./trace.js";

export type WaterfallRequest = {
	method: string;
	path: string;
	status: number;
	totalMs: number;
};

export type WaterfallOptions = {
	slowThresholdMs?: number;
	maxBarWidth?: number;
};

type SpanNode = {
	span: Span;
	children: SpanNode[];
};

const ANSI = {
	green: "\x1b[32m",
	red: "\x1b[31m",
	yellow: "\x1b[33m",
	dim: "\x1b[2m",
	bold: "\x1b[1m",
	reset: "\x1b[0m",
} as const;

export function renderWaterfall(
	spans: Span[],
	request: WaterfallRequest,
	options?: WaterfallOptions,
): string {
	if (spans.length === 0) {
		return "";
	}

	const slowThresholdMs = options?.slowThresholdMs ?? 500;
	const maxBarWidth = options?.maxBarWidth ?? 40;

	const tree = buildTree(spans);
	const bottleneckId = findBottleneck(tree);
	const totalDuration = request.totalMs;

	const lines: string[] = [];

	const headerRule = "─".repeat(40);
	lines.push(
		`  ${ANSI.dim}┌─${ANSI.reset} ${request.method} ${request.path} ${ANSI.dim}${headerRule}${ANSI.reset}`,
	);
	lines.push(`  ${ANSI.dim}│${ANSI.reset}`);

	for (const node of tree) {
		const operationDuration = formatDuration(node.span.duration_ms);
		const operationBar = renderBar(node.span.duration_ms, totalDuration, maxBarWidth);
		const operationColor = spanColor(node.span, slowThresholdMs);

		lines.push(
			`  ${ANSI.dim}│${ANSI.reset}  ${operationColor}[${node.span.name}] ${operationDuration} ${operationBar}${ANSI.reset}`,
		);

		renderChildren(lines, node.children, 1, {
			totalDuration,
			maxBarWidth,
			slowThresholdMs,
			bottleneckId,
		});
	}

	lines.push(`  ${ANSI.dim}│${ANSI.reset}`);

	const statusColor = request.status >= 400 ? ANSI.red : ANSI.green;
	const totalFormatted = formatDuration(request.totalMs);
	lines.push(
		`  ${ANSI.dim}└─${ANSI.reset} ${statusColor}${request.status} ${statusText(request.status)}${ANSI.reset} (${totalFormatted})`,
	);

	return lines.join("\n");
}

function renderChildren(
	lines: string[],
	children: SpanNode[],
	depth: number,
	ctx: {
		totalDuration: number;
		maxBarWidth: number;
		slowThresholdMs: number;
		bottleneckId: string | null;
	},
): void {
	const indent = "  ".repeat(depth);

	for (let i = 0; i < children.length; i++) {
		const node = children[i];
		if (!node) {
			continue;
		}
		const isLast = i === children.length - 1;
		const provider = isLast ? "└─" : "├─";

		const duration = formatDuration(node.span.duration_ms);
		const bar = renderBar(node.span.duration_ms, ctx.totalDuration, ctx.maxBarWidth);
		const color = spanColor(node.span, ctx.slowThresholdMs);
		const star = node.span.id === ctx.bottleneckId ? `  ${ANSI.yellow}★${ANSI.reset}` : "";
		const barSuffix = bar ? ` ${bar}` : "";

		const nameWidth = 20;
		const paddedName = node.span.name.padEnd(nameWidth);

		lines.push(
			`  ${ANSI.dim}│${ANSI.reset}  ${indent}${ANSI.dim}${provider}${ANSI.reset} ${color}${paddedName}${ANSI.reset} ${duration}${barSuffix}${star}`,
		);

		if (node.children.length > 0) {
			renderChildren(lines, node.children, depth + 1, ctx);
		}
	}
}

function buildTree(spans: Span[]): SpanNode[] {
	const sorted = [...spans].sort((a, b) => a.startedAt - b.startedAt);
	const nodeMap = new Map<string, SpanNode>();

	for (const span of sorted) {
		nodeMap.set(span.id, { span, children: [] });
	}

	const roots: SpanNode[] = [];

	for (const span of sorted) {
		const node = nodeMap.get(span.id);
		if (!node) {
			continue;
		}

		if (span.parentId) {
			const parent = nodeMap.get(span.parentId);
			if (parent) {
				parent.children.push(node);
				continue;
			}
		}

		roots.push(node);
	}

	return roots;
}

function findBottleneck(roots: SpanNode[]): string | null {
	if (roots.length === 0) {
		return null;
	}

	const allTopLevel: Span[] = [];

	for (const root of roots) {
		for (const child of root.children) {
			allTopLevel.push(child.span);
		}
	}

	if (allTopLevel.length === 0) {
		return null;
	}

	const first = allTopLevel[0];
	if (!first) {
		return null;
	}

	let longest = first;

	for (const span of allTopLevel) {
		if (span.duration_ms > longest.duration_ms) {
			longest = span;
		}
	}

	return longest.id;
}

function renderBar(durationMs: number, totalMs: number, maxWidth: number): string {
	if (totalMs <= 0 || durationMs <= 0) {
		return "";
	}

	const ratio = durationMs / totalMs;
	const width = Math.max(1, Math.round(ratio * maxWidth));

	return "━".repeat(width);
}

function spanColor(span: Span, slowThresholdMs: number): string {
	if (span.status === "error") {
		return ANSI.red;
	}

	if (span.duration_ms >= slowThresholdMs) {
		return ANSI.yellow;
	}

	return ANSI.green;
}

function formatDuration(ms: number): string {
	if (ms >= 1000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}

	if (ms >= 10) {
		return `${Math.round(ms)}ms`;
	}

	return `${ms.toFixed(1)}ms`;
}

function statusText(status: number): string {
	const texts: Record<number, string> = {
		200: "OK",
		201: "Created",
		400: "Bad Request",
		401: "Unauthorized",
		404: "Not Found",
		500: "Internal Server Error",
		502: "Bad Gateway",
	};

	return texts[status] ?? "";
}
