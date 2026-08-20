import { describe, expect, it } from "bun:test";

import { resolveWreqProfile } from "../runtime/stealth.js";
import { getStealthProfile, listStealthProfiles } from "../stealth/profiles.js";

type WreqProfileSnapshot = {
	profiles: Parameters<typeof resolveWreqProfile>[1];
	userAgents: Record<string, string | null>;
};

type WreqRequestUserAgentSnapshot = {
	observed: string | null;
	expected: string | null;
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

async function captureWreqRequestUserAgent(
	browser: string,
	os: string,
): Promise<WreqRequestUserAgentSnapshot> {
	const subprocess = Bun.spawn({
		cmd: [
			process.execPath,
			"--eval",
			`import { createSession, getEmulationHeaders } from "wreq-js";
let observed = null;
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	fetch(request) {
		observed = request.headers.get("user-agent");
		return new Response("ok");
	},
});
const browser = process.env.WREQ_BROWSER;
const os = process.env.WREQ_OS;
const session = await createSession({ browser, os });
try {
	const response = await session.fetch(server.url);
	await response.text();
	console.log(JSON.stringify({
		observed,
		expected: getEmulationHeaders(browser, os).get("user-agent"),
	}));
} finally {
	await session.close();
	server.stop(true);
}`,
		],
		env: { ...process.env, WREQ_BROWSER: browser, WREQ_OS: os },
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
	]);
	if (exitCode !== 0) {
		throw new Error(`Failed to capture wreq request headers: ${stderr}`);
	}
	return JSON.parse(stdout) as WreqRequestUserAgentSnapshot;
}

describe("stealth user-agent parity", () => {
	for (const profileName of listStealthProfiles()) {
		it(`matches the wreq transport for ${profileName}`, () => {
			const profile = getStealthProfile(profileName);
			const { browser } = resolveWreqProfile(profileName, wreq.profiles);
			const transportUserAgent = wreq.userAgents[browser];

			expect(profile.userAgent).toBe(transportUserAgent);
		});
	}

	it("matches the resolved latest Chrome on Windows transport user-agent", async () => {
		const { browser, os } = resolveWreqProfile("chrome-latest", wreq.profiles);
		const userAgent = await captureWreqRequestUserAgent(browser, os);

		expect({ browser, os }).toEqual({ browser: "chrome_149", os: "windows" });
		expect(userAgent.observed).toBe(userAgent.expected);
		expect(userAgent.observed).toContain("Chrome/149.0.0.0");
		expect(userAgent.observed).toContain("Windows NT 10.0");
	});
});
