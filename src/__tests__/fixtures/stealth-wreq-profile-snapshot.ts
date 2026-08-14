import { getEmulationHeaders, getProfiles } from "wreq-js";

const profiles = getProfiles();
const userAgents = Object.fromEntries(
	profiles.map((profile) => [profile, getEmulationHeaders(profile).get("user-agent")]),
);

console.log(JSON.stringify({ profiles, userAgents }));
