import { describe, expect, it } from "bun:test";

import { resolveWreqProfile } from "../runtime/stealth.js";
import { getStealthProfile, listStealthProfiles } from "../stealth/profiles.js";

type WreqProfileSnapshot = {
	profiles: Parameters<typeof resolveWreqProfile>[1];
	userAgents: Record<string, string | null>;
};

async function loadWreqProfileSnapshot(): Promise<WreqProfileSnapshot> {
	const subprocess = Bun.spawn({
		cmd: [
			process.execPath,
			new URL("./fixtures/stealth-wreq-profile-snapshot.ts", import.meta.url).pathname,
		],
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`Failed to read wreq profile headers: ${stderr}`);
	}
	return JSON.parse(stdout) as WreqProfileSnapshot;
}

const wreq = await loadWreqProfileSnapshot();

describe("stealth user-agent parity", () => {
	for (const profileName of listStealthProfiles()) {
		it(`matches the wreq transport for ${profileName}`, () => {
			const profile = getStealthProfile(profileName);
			const { browser } = resolveWreqProfile(profileName, wreq.profiles);
			const transportUserAgent = wreq.userAgents[browser];

			expect(profile.userAgent).toBe(transportUserAgent);
		});
	}
});
