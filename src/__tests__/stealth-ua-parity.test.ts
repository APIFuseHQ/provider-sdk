import { describe, expect, it } from "bun:test";

import { resolveWreqProfile } from "../runtime/stealth.js";
import { getStealthProfile, listRegisteredStealthProfiles } from "../stealth/profiles.js";

type WreqProfileSnapshot = {
	latestChromeProfile: string;
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
	it("keeps chrome-desktop on wreq-js's newest Chromium profile", () => {
		const identifier = getStealthProfile("chrome-desktop").tlsClientIdentifier;
		if (identifier !== wreq.latestChromeProfile) {
			throw new Error(
				`chrome-desktop resolves to "${identifier}" but wreq-js offers "${wreq.latestChromeProfile}". Update the chrome-desktop stealth profile, User-Agent, and client hints to wreq-js's newest Chromium profile.`,
			);
		}
	});

	for (const profileName of listRegisteredStealthProfiles()) {
		it(`matches the wreq transport for ${profileName}`, () => {
			const profile = getStealthProfile(profileName);
			const { browser, os } = resolveWreqProfile(profileName, wreq.profiles);
			const transportUserAgent = wreq.userAgents[`${browser}:${os}`];
			if (transportUserAgent === null || transportUserAgent === undefined) {
				throw new Error(`Missing wreq user-agent for ${browser}`);
			}

			expect(profile.userAgent).toBe(transportUserAgent);
		});
	}
});
