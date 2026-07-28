import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";

export const STATEFUL_SIGNATURE_HEADER = "x-apifuse-stateful-signature";
export const STATEFUL_TIMESTAMP_HEADER = "x-apifuse-stateful-timestamp";
export const STATEFUL_NONCE_HEADER = "x-apifuse-stateful-nonce";

export type StatefulSigningInput = {
	readonly secret: string;
	readonly timestamp: string;
	readonly rawBody: string;
	readonly method: string;
	readonly path: string;
	readonly nonce: string;
};

export function signStatefulRequestBody(input: StatefulSigningInput): string {
	return `v1=${createHmac("sha256", input.secret)
		.update(
			`v1:${input.method.toUpperCase()}:${input.path}:${input.timestamp}:${input.nonce}.${input.rawBody}`,
		)
		.digest("hex")}`;
}

export function verifyStatefulRequestSignature(
	input: StatefulSigningInput & { readonly signature: string },
): boolean {
	return safeEqualAscii(input.signature, signStatefulRequestBody(input));
}

export function statefulSignedHeaders(
	input: Omit<StatefulSigningInput, "nonce"> & { readonly nonce?: string },
): Record<string, string> {
	const nonce = input.nonce ?? randomUUID();
	return {
		[STATEFUL_SIGNATURE_HEADER]: signStatefulRequestBody({ ...input, nonce }),
		[STATEFUL_TIMESTAMP_HEADER]: input.timestamp,
		[STATEFUL_NONCE_HEADER]: nonce,
	};
}

function safeEqualAscii(actual: string, expected: string): boolean {
	const actualBytes = Buffer.from(actual);
	const expectedBytes = Buffer.from(expected);
	if (actualBytes.byteLength !== expectedBytes.byteLength) return false;
	return timingSafeEqual(actualBytes, expectedBytes);
}
