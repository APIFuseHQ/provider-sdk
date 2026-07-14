import { z } from "zod";

import { HttpRetryPreset } from "../types";

export const ConnectionModeSchema = z.enum([
	"oauth2",
	"credentials",
	"platform-managed",
	"none",
]);

export const OperationConnectionSchema = z.object({
	id: z.string(),
	mode: ConnectionModeSchema,
	secrets: z.record(z.string(), z.string()),
	scopes: z.array(z.string()).optional(),
	metadata: z.record(z.string(), z.unknown()),
	externalRef: z.string(),
});

export const OperationRequestSchema = z.object({
	requestId: z.string(),
	input: z.record(z.string(), z.unknown()),
	connectionId: z.string().optional(),
	connection: OperationConnectionSchema.optional(),
	headers: z.record(z.string(), z.string()).optional(),
	trace: z.record(z.string(), z.string()).optional(),
});

export const ErrorEnvelopeSchema = z.object({
	code: z.string(),
	message: z.string(),
	requestId: z.string().optional(),
	fix: z.string().optional(),
	details: z.unknown().optional(),
});

export const OperationSuccessResponseSchema = z.object({
	data: z.unknown(),
	meta: z
		.object({
			cached: z.boolean().optional(),
			stale: z.boolean().optional(),
			cache: z
				.object({
					hit: z.boolean(),
					stale: z.boolean(),
					keys: z.array(z.string()),
					source: z.enum(["redis", "memory", "loader", "mixed"]).optional(),
				})
				.optional(),
			retry: z
				.object({
					attempts: z.number().int().min(1),
					retries: z.number().int().min(0),
					preset: z
						.enum([
							HttpRetryPreset.Off,
							HttpRetryPreset.TransportTransient,
							HttpRetryPreset.SafeRead,
							HttpRetryPreset.AggressiveRead,
							HttpRetryPreset.RateLimitAware,
						])
						.optional(),
					transport: z.enum(["native"]),
					lastErrorCode: z.string().optional(),
					lastStatus: z.number().int().optional(),
				})
				.optional(),
		})
		.passthrough()
		.optional(),
});

export const OperationErrorResponseSchema = z.object({
	error: ErrorEnvelopeSchema,
});

export const AuthFlowRequestSchema = z.object({
	requestId: z.string(),
	flowId: z.string(),
	connectionId: z.string().optional(),
	externalRef: z.string().optional(),
	tenantId: z.string().optional(),
	providerId: z.string().optional(),
	headers: z.record(z.string(), z.string()).optional(),
	input: z.record(z.string(), z.unknown()).optional(),
	context: z.record(z.string(), z.unknown()).optional(),
	connection: OperationConnectionSchema.optional(),
});

export const AuthFlowSuccessResponseSchema = z.object({
	data: z.unknown(),
	contextPatch: z.record(z.string(), z.unknown().nullable()).optional(),
});

export const AuthFlowErrorResponseSchema = OperationErrorResponseSchema;

export type ConnectionMode = z.infer<typeof ConnectionModeSchema>;
export type OperationConnection = z.infer<typeof OperationConnectionSchema>;
export type OperationRequest = z.infer<typeof OperationRequestSchema>;
export type OperationSuccessResponse = z.infer<
	typeof OperationSuccessResponseSchema
>;
export type OperationErrorResponse = z.infer<
	typeof OperationErrorResponseSchema
>;
export type OperationResponse =
	| OperationSuccessResponse
	| OperationErrorResponse;
export type AuthFlowRequest = z.infer<typeof AuthFlowRequestSchema>;
export type AuthFlowSuccessResponse = z.infer<
	typeof AuthFlowSuccessResponseSchema
>;
export type AuthFlowErrorResponse = z.infer<typeof AuthFlowErrorResponseSchema>;
export type AuthFlowResponse = AuthFlowSuccessResponse | AuthFlowErrorResponse;
