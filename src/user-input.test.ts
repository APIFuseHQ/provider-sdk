import { describe, expect, it } from "bun:test";
import {
	isProviderNeedsInputPayload,
	NEEDS_INPUT_STATUS,
} from "./user-input.js";

describe("user-input contract", () => {
	const payload = {
		status: NEEDS_INPUT_STATUS,
		required_selections: [
			{
				selection_key: "precaution_2",
				label: "코스를 선택해주세요",
				required: true,
				selection_type: "precaution",
				valid_options: [
					{ selection_value: "21", label: "스페셜 코스" },
					{ selection_value: "22", label: "시그니처 코스" },
				],
			},
		],
		selected_options: [
			{ selection_key: "reservation_option", selection_value: "H:1:2" },
		],
		reservation_state: "ct_res_state_v1.fresh",
		continue_with: {
			operation: "reserve",
			args: { shop_ref: "s1", reservation_state: "ct_res_state_v1.fresh" },
		},
		action_hint: "Relay required_selections to the user verbatim.",
	};

	it("accepts a well-formed needs_input payload", () => {
		expect(isProviderNeedsInputPayload(payload)).toBe(true);
	});

	it("rejects payloads without the needs_input markers", () => {
		expect(isProviderNeedsInputPayload({ status: "ok" })).toBe(false);
		expect(
			isProviderNeedsInputPayload({
				...payload,
				required_selections: "not-a-list",
			}),
		).toBe(false);
		expect(
			isProviderNeedsInputPayload({
				status: NEEDS_INPUT_STATUS,
				required_selections: [],
			}),
		).toBe(false);
		expect(isProviderNeedsInputPayload(null)).toBe(false);
		expect(isProviderNeedsInputPayload([payload])).toBe(false);
	});

	it("rejects malformed selections and a missing retry template", () => {
		expect(
			isProviderNeedsInputPayload({
				...payload,
				required_selections: [{ selection_key: 1 }],
			}),
		).toBe(false);
		expect(
			isProviderNeedsInputPayload({
				...payload,
				required_selections: [
					{
						...payload.required_selections[0],
						valid_options: [{ selection_value: "21" }],
					},
				],
			}),
		).toBe(false);
		const { continue_with: _omitted, ...withoutContinueWith } = payload;
		expect(isProviderNeedsInputPayload(withoutContinueWith)).toBe(false);
		expect(
			isProviderNeedsInputPayload({
				...payload,
				continue_with: { operation: "reserve" },
			}),
		).toBe(false);
	});
});
