export type StatefulControlPlaneOperation = "resolve" | "acquire" | "renew" | "release";

export class StatefulRoutingDeadlineError extends Error {
	readonly requestId: string;
	readonly deadlineAt: string;

	constructor(requestId: string, deadlineAt: string) {
		super(`Stateful operation request ${requestId} deadline has expired.`);
		this.name = "StatefulRoutingDeadlineError";
		this.requestId = requestId;
		this.deadlineAt = deadlineAt;
	}
}

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
