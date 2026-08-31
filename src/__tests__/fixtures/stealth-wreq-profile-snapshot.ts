import { getEmulationHeaders, getOperatingSystems, getProfiles, resolveProfile } from "wreq-js";

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
		profiles,
		userAgents,
	}),
);
