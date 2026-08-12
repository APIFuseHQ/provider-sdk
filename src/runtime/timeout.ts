export function isTimeoutLikeError(error: unknown): error is Error {
	return (
		error instanceof Error &&
		(error.name === "AbortError" ||
			error.name === "TimeoutError" ||
			/\b(timed out|timeout|deadline exceeded)\b/i.test(error.message))
	);
}

export function createTimeoutController(signalTimeoutMs: number): {
	controller: AbortController;
	clear: () => void;
} {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), signalTimeoutMs);
	timeout.unref?.();
	return { controller, clear: () => clearTimeout(timeout) };
}
