import { describe, expect, it } from "bun:test";
import { HandleError } from "../handle.js";
import { ProviderError, ValidationError } from "../errors.js";
import {
	isSdkIssuedError,
	issueSdkError,
	type PlatformFault,
	platformFaultOf,
} from "../sdk-issued-errors.js";
import {
	issueStatefulRoutingDeadlineError,
	statefulRoutingDeadlineErrorCausedBy,
} from "../stateful/deadline-expiry.js";
import { StatefulRoutingDeadlineError } from "../stateful/errors.js";

const STATEFUL_FORWARDING_DEADLINE_FAULT: PlatformFault = {
	category: "stateful_forwarding_deadline",
	code: "STATEFUL_FORWARDING_DEADLINE_EXPIRED",
	status: 504,
	retryable: false,
};

describe("sdk-issued error record", () => {
	it("records only the very object the SDK issued", () => {
		const issued = issueSdkError(new ProviderError("issued", { code: "X" }));
		expect(isSdkIssuedError(issued)).toBe(true);
		expect(platformFaultOf(issued)).toBeUndefined();

		// Same class, same fields, built by someone else: not issued.
		const lookalike = new ProviderError("issued", { code: "X" });
		expect(isSdkIssuedError(lookalike)).toBe(false);
		// A copy of the issued object's own properties is a different object.
		const copy = Object.assign(Object.create(Object.getPrototypeOf(issued)), issued);
		expect(isSdkIssuedError(copy)).toBe(false);
		expect(isSdkIssuedError(null)).toBe(false);
		expect(isSdkIssuedError("issued")).toBe(false);
	});

	it("records the platform fault beside the issued object", () => {
		const cause = new Error("schema");
		const error = issueSdkError(
			new ValidationError("output", { code: "OUTPUT_VALIDATION_FAILED", retryable: false }),
			{
				category: "output_validation",
				code: "OUTPUT_VALIDATION_FAILED",
				status: 500,
				retryable: false,
				cause,
			},
		);
		expect(isSdkIssuedError(error)).toBe(true);
		expect(platformFaultOf(error)).toEqual({
			category: "output_validation",
			code: "OUTPUT_VALIDATION_FAILED",
			status: 500,
			retryable: false,
			cause,
		});
		// The fault is read from the record, not from the error's options:
		// the options carry no platform word.
		expect(error.options).not.toHaveProperty("category");
	});

	it("gives a provider-constructed error no platform fault, whatever it carries", () => {
		const providerHandleError = new HandleError("HANDLE_STORAGE_UNAVAILABLE", "storage", {});
		expect(isSdkIssuedError(providerHandleError)).toBe(false);
		expect(platformFaultOf(providerHandleError)).toBeUndefined();
		expect(providerHandleError.options).not.toHaveProperty("category");

		const providerCodeLookalike = new ProviderError("x", {
			code: "STATEFUL_FORWARDING_DEADLINE_EXPIRED",
		});
		expect(platformFaultOf(providerCodeLookalike)).toBeUndefined();
	});

	it("records the stateful forwarding deadline fault on every deadline error the SDK raises", () => {
		const expired = issueStatefulRoutingDeadlineError("request-1", "2026-10-28T00:00:00.000Z");
		expect(platformFaultOf(expired)).toEqual(STATEFUL_FORWARDING_DEADLINE_FAULT);

		// A conversion keeps the failure the deadline stopped as the cause of
		// both the error and its fault.
		const cancelled = new Error("cancelled by the deadline");
		const converted = statefulRoutingDeadlineErrorCausedBy(
			"request-1",
			"2026-10-28T00:00:00.000Z",
			cancelled,
		);
		expect(platformFaultOf(converted)).toEqual({
			...STATEFUL_FORWARDING_DEADLINE_FAULT,
			cause: cancelled,
		});
		expect(converted.cause).toBe(cancelled);

		// The public class constructed outside the SDK carries no fault.
		const constructed = new StatefulRoutingDeadlineError("request-1", "2026-10-28T00:00:00.000Z");
		expect(platformFaultOf(constructed)).toBeUndefined();
	});
});
