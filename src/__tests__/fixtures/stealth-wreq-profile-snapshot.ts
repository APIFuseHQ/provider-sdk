import { getEmulationHeaders, getOperatingSystems, getProfiles, resolveProfile } from "wreq-js";

import { resolveWreqProfile } from "../../runtime/stealth.js";
import { getStealthProfile, listStealthProfiles } from "../../stealth/profiles.js";

const profiles = getProfiles();
const userAgents = Object.fromEntries(
	profiles.flatMap((profile) =>
		getOperatingSystems().map((os) => [
			`${profile}:${os}`,
			getEmulationHeaders(profile, os).get("user-agent"),
		]),
	),
);

console.log(
	JSON.stringify({
		latestChromeProfile: resolveProfile("chrome"),
		entries: listStealthProfiles().map((descriptor) => {
			const profile = getStealthProfile(descriptor);
			const mapping = resolveWreqProfile(descriptor, profiles);
			return {
				descriptor,
				identifier: profile.tlsClientIdentifier,
				profileUserAgent: profile.userAgent,
				transportUserAgent: userAgents[`${mapping.browser}:${mapping.os}`],
			};
		}),
	}),
);
