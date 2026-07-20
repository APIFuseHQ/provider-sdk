import { describe, expect, it } from "bun:test";
import { z } from "zod";

import {
	APIFUSE_REDACTION_MARKER,
	collectSensitivePaths,
	field,
	fields,
	redactPayload,
	sensitive,
} from "../schema.js";

describe("schema sensitivity metadata", () => {
	it("marks fields without changing validation", () => {
		const schema = z.object({
			username: z.string(),
			password: sensitive(z.string().min(8)),
		});

		expect(schema.parse({ username: "neo", password: "correct horse" })).toEqual({
			username: "neo",
			password: "correct horse",
		});
		expect(collectSensitivePaths(schema)).toEqual([["password"]]);
	});

	it("collects nested array sensitive paths and redacts reserved keys", () => {
		const schema = z.object({
			items: z.array(
				z.object({
					name: z.string(),
					otpCode: sensitive(z.string()),
				}),
			),
		});

		const paths = collectSensitivePaths(schema);
		expect(paths).toEqual([["items", "*", "otpCode"]]);
		expect(
			redactPayload(
				{
					items: [{ name: "first", otpCode: "123456" }],
					token: "upstream-token",
				},
				paths,
			),
		).toEqual({
			items: [{ name: "first", otpCode: APIFUSE_REDACTION_MARKER }],
			token: APIFUSE_REDACTION_MARKER,
		});
	});

	it("provides preset fields and generic field metadata for provider DX", () => {
		const schema = z.object({
			password: fields.password({ minLength: 8 }),
			phoneNumber: fields.phone(),
			checkoutUrl: field(z.string().url(), {
				kind: "payment_url",
				description: "Payment URL returned by the upstream provider.",
			}),
		});

		expect(collectSensitivePaths(schema)).toEqual([["password"], ["phoneNumber"], ["checkoutUrl"]]);

		const jsonSchema = z.toJSONSchema(schema) as {
			properties?: Record<string, Record<string, unknown>>;
		};
		expect(jsonSchema.properties?.password?.["x-apifuse-sensitive"]).toBe(true);
		expect(jsonSchema.properties?.password?.["x-apifuse-sensitive-kind"]).toBe("password");
		expect(jsonSchema.properties?.checkoutUrl?.description).toBe(
			"Payment URL returned by the upstream provider.",
		);
	});

	it("redacts every path when a sensitive schema instance is reused", () => {
		const token = fields.token();
		const schema = z.object({
			accessToken: token,
			refreshToken: token,
		});

		const paths = collectSensitivePaths(schema);

		expect(paths).toEqual([["accessToken"], ["refreshToken"]]);
		expect(
			redactPayload(
				{
					accessToken: "access-token",
					refreshToken: "refresh-token",
				},
				paths,
			),
		).toEqual({
			accessToken: APIFUSE_REDACTION_MARKER,
			refreshToken: APIFUSE_REDACTION_MARKER,
		});
	});

	it("redacts common snake_case sensitive keys by reserved name", () => {
		expect(
			redactPayload({
				access_token: "access-token",
				refresh_token: "refresh-token",
				otp_code: "123456",
				phone_number: "+15551234567",
				public_id: "safe",
			}),
		).toEqual({
			access_token: APIFUSE_REDACTION_MARKER,
			refresh_token: APIFUSE_REDACTION_MARKER,
			otp_code: APIFUSE_REDACTION_MARKER,
			phone_number: APIFUSE_REDACTION_MARKER,
			public_id: "safe",
		});
	});
});
