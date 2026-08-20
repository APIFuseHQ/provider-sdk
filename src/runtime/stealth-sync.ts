import { createRequire } from "node:module";
import type * as Wreq from "wreq-js";

import { SDKError } from "../errors.js";
import { getStealthProfile } from "../stealth/profiles.js";
import { resolveWreqProfile } from "./stealth.js";

/**
 * Synchronous UA seam for CLI context builders. The CLI already runs in a
 * wreq-js-capable process, so it can inspect the installed profile list without
 * changing the builders' synchronous public shape.
 */
export function resolveStealthProfileUserAgentSync(profileName: string): string {
	const selection = getStealthProfile(profileName);
	if (!("resolution" in selection)) return selection.userAgent;
	const require = createRequire(import.meta.url);
	const wreq = require("wreq-js") as typeof Wreq;
	const defaultWreq =
		(wreq.default as
			| {
					getProfiles?: typeof wreq.getProfiles;
					getEmulationHeaders?: typeof wreq.getEmulationHeaders;
			  }
			| undefined) ?? {};
	const getProfiles = wreq.getProfiles ?? defaultWreq.getProfiles;
	const getEmulationHeaders = wreq.getEmulationHeaders ?? defaultWreq.getEmulationHeaders;
	if (!getProfiles || !getEmulationHeaders) {
		throw new SDKError("wreq-js does not expose its browser profile resolution helpers.");
	}
	const { browser, os } = resolveWreqProfile(profileName, getProfiles());
	const userAgent = getEmulationHeaders(browser, os).get("user-agent");
	if (!userAgent) {
		throw new SDKError(
			`Stealth profile "${profileName}" resolved to ${browser}, but wreq-js did not provide a user-agent.`,
		);
	}
	return userAgent;
}
