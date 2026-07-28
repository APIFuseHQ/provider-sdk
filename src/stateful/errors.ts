export type StatefulControlPlaneOperation = "resolve" | "acquire" | "renew" | "release";

export class StatefulControlPlaneError extends Error {
	readonly code: string;
	readonly operation: StatefulControlPlaneOperation;
	readonly status?: number;
	readonly cause?: unknown;

	constructor(input: {
		readonly code: string;
		readonly message: string;
		readonly operation: StatefulControlPlaneOperation;
		readonly status?: number;
		readonly cause?: unknown;
	}) {
		super(input.message);
		this.name = "StatefulControlPlaneError";
		this.code = input.code;
		this.operation = input.operation;
		this.status = input.status;
		this.cause = input.cause;
	}
}
