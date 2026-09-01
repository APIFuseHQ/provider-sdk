import { describe, expect, it } from "bun:test";

type WreqProfileSnapshot = {
	latestChromeProfile: string;
	entries: Array<{
		descriptor: { browser: string; os: string };
		identifier?: string;
		profileUserAgent: string;
		transportUserAgent: string | null;
	}>;
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
	it("keeps structured Chrome selection on wreq-js's newest Chromium profile", () => {
		const identifier = wreq.entries.find(
			(entry) => entry.descriptor.browser === "chrome" && entry.descriptor.os === "macos",
		)?.identifier;
		if (identifier !== wreq.latestChromeProfile) {
			throw new Error(
				`Structured Chrome selection resolves to "${identifier}" but wreq-js offers "${wreq.latestChromeProfile}". Update its User-Agent and client hints to wreq-js's newest Chromium profile.`,
			);
		}
	});

	for (const entry of wreq.entries) {
		it(`matches the wreq transport for ${entry.descriptor.browser}/${entry.descriptor.os}`, () => {
			const transportUserAgent = entry.transportUserAgent;
			if (transportUserAgent === null || transportUserAgent === undefined) {
				throw new Error(`Missing wreq user-agent for ${entry.identifier}`);
			}

			expect(entry.profileUserAgent).toBe(transportUserAgent);
		});
	}
});
