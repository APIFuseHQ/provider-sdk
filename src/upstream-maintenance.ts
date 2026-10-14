import { z } from "zod";

import type { NonEmpty } from "./health-scenario.js";

/**
 * How far before its declaration a maintenance window may start. The platform
 * keeps health samples for 90 days: a window older than that has no samples
 * left to classify and no incident evidence left to retract, so declaring it
 * would only add a statement nothing can check.
 */
export const UPSTREAM_MAINTENANCE_LOOKBACK_DAYS = 90;

const LOOKBACK_MS = UPSTREAM_MAINTENANCE_LOOKBACK_DAYS * 86_400_000;

/**
 * One maintenance window the upstream announced, at absolute UTC instants.
 *
 * Health samples taken inside the window that fail (`degraded` or `down`) are
 * classified as an expected absence rather than an outage, and incidents whose
 * failing samples all fall inside it are retracted, including incidents
 * recorded before the window was declared (within the 90-day lookback). Probes
 * keep running through the window, so a failure that outlasts `endsAt` is an
 * outage from `endsAt` on.
 */
export type UpstreamMaintenanceWindow = {
	/** Start of the announced window, ISO 8601 in UTC (`Z`), e.g. `2026-10-13T17:00:00Z`. */
	startsAt: string;
	/** End of the announced window, ISO 8601 in UTC (`Z`); later than `startsAt`. */
	endsAt: string;
	/** The upstream's own announcement of this window (http or https URL). */
	sourceUrl: string;
	/**
	 * When this window was declared, ISO 8601 in UTC (`Z`). `startsAt` may be at
	 * most 90 days earlier ({@link UPSTREAM_MAINTENANCE_LOOKBACK_DAYS}).
	 */
	declaredAt: string;
	/**
	 * Operation ids the announcement covers. Omit when the whole upstream is
	 * under maintenance; every operation of the provider is then covered.
	 */
	operations?: NonEmpty<string>;
};

const utcInstant = (field: string) =>
	z.iso.datetime({
		error: `${field} must be an ISO 8601 instant in UTC ending in Z, e.g. 2026-10-13T17:00:00Z`,
	});

const UtcInstantSchema = z.iso.datetime();

function parseUtcInstant(value: string): number | undefined {
	return UtcInstantSchema.safeParse(value).success ? Date.parse(value) : undefined;
}

export const UpstreamMaintenanceWindowSchema: z.ZodType<UpstreamMaintenanceWindow> = z
	.object({
		startsAt: utcInstant("startsAt"),
		endsAt: utcInstant("endsAt"),
		sourceUrl: z.url({
			protocol: /^https?$/,
			error: "sourceUrl must be an absolute http(s) URL of the upstream's announcement",
		}),
		declaredAt: utcInstant("declaredAt"),
		operations: z
			.array(z.string().min(1))
			.min(1)
			.transform((value) => value as [string, ...string[]])
			.optional(),
	})
	.strict()
	.superRefine((value, ctx) => {
		// The instants are compared only once each is a well-formed UTC
		// instant; a malformed one already carries its own issue.
		const startsAt = parseUtcInstant(value.startsAt);
		const endsAt = parseUtcInstant(value.endsAt);
		const declaredAt = parseUtcInstant(value.declaredAt);
		if (startsAt !== undefined && endsAt !== undefined && !(endsAt > startsAt))
			ctx.addIssue({
				code: "custom",
				path: ["endsAt"],
				message: "endsAt must be later than startsAt",
			});
		if (startsAt !== undefined && declaredAt !== undefined && startsAt < declaredAt - LOOKBACK_MS)
			ctx.addIssue({
				code: "custom",
				path: ["startsAt"],
				message: `startsAt must be at most ${UPSTREAM_MAINTENANCE_LOOKBACK_DAYS} days before declaredAt: the platform keeps health samples for ${UPSTREAM_MAINTENANCE_LOOKBACK_DAYS} days`,
			});
		if (value.operations) {
			const seen = new Set<string>();
			for (const [index, operationId] of value.operations.entries()) {
				if (seen.has(operationId))
					ctx.addIssue({
						code: "custom",
						path: ["operations", index],
						message: `duplicate operation ${operationId}`,
					});
				seen.add(operationId);
			}
		}
	});

export const UpstreamMaintenanceWindowsSchema: z.ZodType<NonEmpty<UpstreamMaintenanceWindow>> = z
	.array(UpstreamMaintenanceWindowSchema)
	.min(1)
	.transform((value) => value as [UpstreamMaintenanceWindow, ...UpstreamMaintenanceWindow[]]);
