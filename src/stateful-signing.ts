import { createHmac, timingSafeEqual } from "node:crypto";

export const STATEFUL_SIGNATURE_HEADER = "x-apifuse-stateful-signature";
export const STATEFUL_TIMESTAMP_HEADER = "x-apifuse-stateful-timestamp";

export type StatefulSigningInput = {
	readonly secret: string;
	readonly timestamp: string;
	readonly rawBody: string;
};

export function signStatefulRequestBody(input: StatefulSigningInput): string {
	return `v1=${createHmac("sha256", input.secret)
		.update(`${input.timestamp}.${input.rawBody}`)
		.digest("hex")}`;
}

export function verifyStatefulRequestSignature(
	input: StatefulSigningInput & { readonly signature: string },
): boolean {
	return safeEqualAscii(input.signature, signStatefulRequestBody(input));
}

export function statefulSignedHeaders(input: StatefulSigningInput): Record<string, string> {
	return {
		[STATEFUL_SIGNATURE_HEADER]: signStatefulRequestBody(input),
		[STATEFUL_TIMESTAMP_HEADER]: input.timestamp,
	};
}

function safeEqualAscii(actual: string, expected: string): boolean {
	const actualBytes = Buffer.from(actual);
	const expectedBytes = Buffer.from(expected);
	if (actualBytes.byteLength !== expectedBytes.byteLength) return false;
	return timingSafeEqual(actualBytes, expectedBytes);
}
