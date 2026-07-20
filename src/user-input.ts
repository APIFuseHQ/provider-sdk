// Official cross-provider contract for user-input round-trips.
//
// Doctrine (born from the 2026-07-20 CatchTable reserve incident): an
// operation MUST NOT dead-end on a problem the end user can resolve by
// choosing among live options. Instead of throwing, the provider returns a
// SUCCESSFUL payload with `status: "needs_input"` that carries everything a
// consumer-side agent needs to relay the choice verbatim and retry:
//
// - `required_selections`: only the still-pending questions, each with
//   human-readable `label`s and `valid_options` the agent shows the user
//   as-is. The agent never chooses on the user's behalf.
// - `selected_options`: selections already settled, echoed so the follow-up
//   call keeps them without the agent reconstructing anything.
// - `continue_with`: a ready-to-send operation + args template for the retry.
// - a fresh provider-specific state token (e.g. `reservation_state`) minted
//   at response time, so the retry never races an expired token.
//
// Keeping this success-shaped (instead of error `details`) is deliberate:
// consumer error-shaping layers routinely strip error metadata, and a model
// that only sees "error" narrates failure to the user. Complex recovery
// logic belongs to the system, not the model.

export const NEEDS_INPUT_STATUS = "needs_input" as const;

export interface ProviderSelectionOption {
	readonly selection_value: string;
	readonly label: string;
	readonly [extra: string]: unknown;
}

export interface ProviderRequiredSelection {
	readonly selection_key: string;
	readonly label: string;
	readonly required: boolean;
	readonly selection_type?: string;
	readonly valid_options: readonly ProviderSelectionOption[];
	readonly [extra: string]: unknown;
}

export interface ProviderSelectedOption {
	readonly selection_key: string;
	readonly selection_value: string;
	/** Free-text answer for text-kind selections. */
	readonly text?: string;
	/** Quantity for quantity-kind selections. */
	readonly quantity?: number;
}

export interface ProviderContinueWith {
	readonly operation: string;
	readonly args: Readonly<Record<string, unknown>>;
}

export interface ProviderNeedsInputPayload {
	readonly status: typeof NEEDS_INPUT_STATUS;
	readonly required_selections: readonly ProviderRequiredSelection[];
	readonly selected_options?: readonly ProviderSelectedOption[];
	readonly continue_with?: ProviderContinueWith;
	readonly action_hint: string;
	/** Provider-specific fresh state token(s), e.g. `reservation_state`. */
	readonly [extra: string]: unknown;
}

export function isProviderNeedsInputPayload(
	value: unknown,
): value is ProviderNeedsInputPayload {
	if (typeof value !== "object" || value === null || Array.isArray(value)) {
		return false;
	}
	const record = value as Record<string, unknown>;
	return (
		record.status === NEEDS_INPUT_STATUS &&
		Array.isArray(record.required_selections) &&
		typeof record.action_hint === "string"
	);
}
