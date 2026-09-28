import { describe, expect, it } from "bun:test";

type Received = { path: string; method: string; headers: Record<string, string> };
type Scenario = {
	first: Received[];
	other: Received[];
	error?: { name?: string; code?: string };
};

// The real wreq-js transport, run in a subprocess so the wreq-js module mock in
// stealth-client.test.ts cannot replace it: these assertions are about the
// bytes a server receives, including anything wreq merges in on its own.
async function runWireScenarios(): Promise<Record<string, Scenario>> {
	const subprocess = Bun.spawn({
		cmd: [
			process.execPath,
			new URL("./fixtures/stealth-redirect-wire.ts", import.meta.url).pathname,
		],
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`stealth redirect wire fixture failed: ${stderr}`);
	return JSON.parse(stdout) as Record<string, Scenario>;
}

const wire = await runWireScenarios();

function only(scenario: Scenario | undefined, server: "first" | "other", path: string) {
	const matches = scenario?.[server].filter((request) => request.path === path) ?? [];
	expect(matches).toHaveLength(1);
	return matches[0]!;
}

describe("stealth redirect hops on the real transport", () => {
	it("sends neither Authorization nor the explicit Cookie to another site", () => {
		const login = only(wire.crossSite, "first", "/login");
		expect(login.headers.authorization).toBe("Bearer caller-token");
		expect(login.headers.cookie).toBe("sid=caller-session");
		const foreign = only(wire.crossSite, "other", "/steal");
		expect(foreign.headers.authorization).toBeUndefined();
		expect(foreign.headers.cookie).toBeUndefined();
		expect(foreign.headers["x-trace"]).toBe("kept");
	});

	it("keeps the explicit Cookie but not Authorization on another origin of the same site", () => {
		const next = only(wire.sameSite, "other", "/next");
		expect(next.headers.authorization).toBeUndefined();
		expect(next.headers.cookie).toBe("sid=caller-session");
	});

	it("sends the GET after a POST 302 without the POST's body headers", () => {
		const done = only(wire.postToGet, "first", "/done");
		expect(done.method).toBe("GET");
		expect(done.headers["content-type"]).toBeUndefined();
		expect(done.headers["content-length"]).toBeUndefined();
		expect(done.headers.authorization).toBe("Bearer caller-token");
		expect(done.headers.cookie).toBe("sid=caller-session");
	});

	it("never reaches the other origin under a same-origin redirectPolicy", () => {
		expect(wire.policy?.error).toEqual({
			name: "HttpRedirectError",
			code: "http_redirect_stopped",
		});
		expect(wire.policy?.other).toEqual([]);
	});

	it("applies the same rules to session.redirects.run", () => {
		const foreign = only(wire.redirectsRun, "other", "/steal");
		expect(foreign.headers.authorization).toBeUndefined();
		expect(foreign.headers.cookie).toBeUndefined();
	});
});
