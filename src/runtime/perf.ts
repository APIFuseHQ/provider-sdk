import type { Span } from "./trace";

export type PerfStats = {
	p50: number;
	p95: number;
	p99: number;
	avg: number;
	min: number;
	max: number;
};

export function computePercentile(sortedValues: number[], p: number): number {
	if (sortedValues.length === 0) {
		return 0;
	}

	if (sortedValues.length === 1) {
		return sortedValues[0] ?? 0;
	}

	const percentile = Math.min(100, Math.max(0, p));
	const position = (percentile / 100) * (sortedValues.length - 1);
	const lowerIndex = Math.floor(position);
	const upperIndex = Math.ceil(position);
	const lower = sortedValues[lowerIndex] ?? 0;
	const upper = sortedValues[upperIndex] ?? lower;

	if (lowerIndex === upperIndex) {
		return lower;
	}

	const weight = position - lowerIndex;
	return lower + (upper - lower) * weight;
}

export function computeStats(durations: number[]): PerfStats {
	if (durations.length === 0) {
		return {
			p50: 0,
			p95: 0,
			p99: 0,
			avg: 0,
			min: 0,
			max: 0,
		};
	}

	const sorted = [...durations].sort((a, b) => a - b);
	const total = sorted.reduce((sum, value) => sum + value, 0);

	return {
		p50: computePercentile(sorted, 50),
		p95: computePercentile(sorted, 95),
		p99: computePercentile(sorted, 99),
		avg: total / sorted.length,
		min: sorted[0] ?? 0,
		max: sorted[sorted.length - 1] ?? 0,
	};
}

export function groupSpansByName(allSpans: Span[][]): Map<string, number[]> {
	const grouped = new Map<string, number[]>();

	for (const spans of allSpans) {
		for (const span of spans) {
			const durations = grouped.get(span.name) ?? [];
			durations.push(span.duration_ms);
			grouped.set(span.name, durations);
		}
	}

	return grouped;
}
