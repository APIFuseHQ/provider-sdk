export const CAPABILITY_BODY_UNAVAILABLE = "<body unavailable>";

/** Read optional diagnostic response text without letting a body stall the request failure. */
export async function readCapabilityErrorBody(
	response: Response,
	signal: AbortSignal,
): Promise<string> {
	if (signal.aborted) return CAPABILITY_BODY_UNAVAILABLE;

	let timer: ReturnType<typeof setTimeout> | undefined;
	let onAbort: (() => void) | undefined;
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	let unavailableWon = false;
	const cancelBody = (reason: unknown) => {
		const cancellation = reader ? reader.cancel(reason) : response.body?.cancel(reason);
		if (cancellation) void cancellation.catch(() => {});
	};
	const unavailable = new Promise<string>((resolve) => {
		onAbort = () => {
			unavailableWon = true;
			resolve(CAPABILITY_BODY_UNAVAILABLE);
			cancelBody(signal.reason);
		};
		signal.addEventListener("abort", onAbort, { once: true });
		timer = setTimeout(() => {
			unavailableWon = true;
			resolve(CAPABILITY_BODY_UNAVAILABLE);
			cancelBody(new Error("capability error body read timeout"));
		}, 250);
	});
	const body = Promise.resolve()
		.then(async () => {
			if (unavailableWon) return CAPABILITY_BODY_UNAVAILABLE;
			if (!response.body) return response.text();
			reader = response.body.getReader();
			const decoder = new TextDecoder();
			let text = "";
			while (true) {
				if (unavailableWon) return CAPABILITY_BODY_UNAVAILABLE;
				const chunk = await reader.read();
				if (chunk.done) return text + decoder.decode();
				text += decoder.decode(chunk.value, { stream: true });
			}
		})
		.catch(() => CAPABILITY_BODY_UNAVAILABLE);

	try {
		return await Promise.race([body, unavailable]);
	} finally {
		if (timer !== undefined) clearTimeout(timer);
		if (onAbort) signal.removeEventListener("abort", onAbort);
	}
}
