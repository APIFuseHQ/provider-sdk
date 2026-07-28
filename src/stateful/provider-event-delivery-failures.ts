export type ProviderWebhookFailureTotals = {
	retryingCount: number;
	failedCount: number;
	deadLetteredCount: number;
};

export function failureForStatus(statusCode: number): {
	readonly statusCode: number;
	readonly error?: string;
} {
	if (statusCode >= 300 && statusCode < 400) {
		return { statusCode, error: "Webhook redirects are not followed." };
	}
	return { statusCode };
}

export function failureForError(error: unknown): {
	readonly statusCode?: number;
	readonly error: string;
} {
	if (isPublicValidationError(error)) {
		return { statusCode: 400, error: error.message };
	}
	return { error: publicWorkerError(error) };
}

export function countProviderWebhookFailure(
	totals: ProviderWebhookFailureTotals,
	status: string,
): void {
	if (status === "retrying") {
		totals.retryingCount += 1;
		return;
	}
	if (status === "dead_lettered") {
		totals.deadLetteredCount += 1;
		return;
	}
	totals.failedCount += 1;
}

export type ProviderEventDeliveryFailureReason = "buffer_overflow" | "attempts_exhausted";

export type ProviderEventDeliveryFailure = {
	readonly eventId: string;
	readonly reason: ProviderEventDeliveryFailureReason;
	readonly attempts: number;
	readonly failedAt: string;
	readonly error?: string;
};

export interface ProviderEventDeliveryFailureRecorder {
	record(failure: ProviderEventDeliveryFailure): void | Promise<void>;
}

export const NOOP_PROVIDER_EVENT_DELIVERY_FAILURE_RECORDER = {
	record() {},
} satisfies ProviderEventDeliveryFailureRecorder;

export class RecordingProviderEventDeliveryFailureRecorder
	implements ProviderEventDeliveryFailureRecorder
{
	readonly failures: ProviderEventDeliveryFailure[] = [];

	record(failure: ProviderEventDeliveryFailure): void {
		this.failures.push(failure);
	}
}

function publicWorkerError(error: unknown): string {
	if (isPublicValidationError(error)) return error.message;
	if (error instanceof Error && error.message) {
		return "Webhook delivery request failed.";
	}
	return "Webhook delivery failed.";
}

function isPublicValidationError(error: unknown): error is Error {
	return error instanceof Error && error.name.endsWith("ValidationError");
}
