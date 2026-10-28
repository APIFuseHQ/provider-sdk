import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";

type GatewayHit = {
	mode: "forward" | "connect";
	target: string;
	username: string;
	password: string;
	refused: boolean;
};
type Read = { status: number; hits: GatewayHit[] };
type Wire = {
	gatewayPort: number;
	stealthRotating: {
		status: number;
		body: { path: string; viaGateway: boolean };
		hits: GatewayHit[];
		selects: {
			requestId?: string;
			attempt: number;
			attemptCap: number;
			history: { vendor: string; outcome: string; errorCode?: string }[] | null;
		}[];
		reports: {
			phase: string;
			outcome: string;
			attempt?: number;
			requestId?: string;
			sessionId?: string;
		}[];
	};
	httpRotating: {
		status: number;
		body: { path: string; viaGateway: boolean };
		hits: GatewayHit[];
		attempts: {
			provider: string;
			attempt: number;
			proxyHash?: string;
			outcome: string;
			errorCode?: string;
			status?: number;
		}[];
		attemptSamples: { a: number; h?: string; o: string; c?: string; s?: number }[];
	};
	sticky: {
		epochBefore: number;
		epochAfter: number;
		reads: Record<
			"firstClient" | "firstClientAgain" | "secondClient" | "otherAffinity" | "refusedThenRetried",
			Read
		>;
	};
	served: {
		status: number;
		data: { path?: string; viaGateway?: boolean } | null;
		hits: GatewayHit[];
		rewrites: { host: string; port: number }[];
		logProxy: { kind?: string; provider?: string; cacheStatus?: string } | null;
	};
	servedMissingCredentials: {
		status: number;
		data: { errorCode?: string; errorMessage?: string } | null;
		hits: GatewayHit[];
	};
};

const USERNAME = /^smart-HUHU123_area-KR_life-(\d+)_session-([0-9a-f]{10})$/;

function tokens(username: string): { life: number; session: string } {
	const match = USERNAME.exec(username);
	if (!match) throw new Error(`unexpected gateway username: ${username}`);
	return { life: Number(match[1]), session: match[2] as string };
}

function sid(affinityKey: string, windowEpoch: number, attempt: number): string {
	return createHash("sha256")
		.update(`${affinityKey}:${windowEpoch}:${attempt}`)
		.digest("hex")
		.slice(0, 10);
}

// The real resolver, selector and transports against a local stand-in for the
// smartproxy gateway; run in a subprocess so the wreq-js module mock in other
// test files cannot replace the stealth transport.
async function runGatewayWire(): Promise<Wire> {
	const subprocess = Bun.spawn({
		cmd: [
			process.execPath,
			new URL("./fixtures/smartproxy-gateway-session-wire.ts", import.meta.url).pathname,
		],
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`smartproxy gateway wire fixture failed: ${stderr}`);
	return JSON.parse(stdout);
}

const wire = await runGatewayWire();

describe("operational assembly: smartproxy gateway sessions on the real transports", () => {
	it("ctx.stealth leaves a refused session for a new one and carries area, life and session", () => {
		const { stealthRotating } = wire;
		expect(stealthRotating.status).toBe(200);
		expect(stealthRotating.body).toEqual({ path: "/stealth-rotating", viaGateway: true });
		expect(stealthRotating.hits.map((hit) => hit.refused)).toEqual([true, false]);
		const [refused, passed] = stealthRotating.hits.map((hit) => tokens(hit.username));
		expect(refused?.life).toBe(30);
		expect(passed?.life).toBe(30);
		expect(refused?.session).not.toBe(passed?.session);
		for (const hit of stealthRotating.hits) {
			expect(hit.password).toBe("s3cret");
			expect(hit.target).toContain("/stealth-rotating");
		}
	});

	it("ctx.stealth asks one selector per request with the request's history and reports to it", () => {
		const { selects, reports, hits } = wire.stealthRotating;
		expect(selects).toHaveLength(2);
		const requestId = selects[0]?.requestId;
		expect(requestId).toBeString();
		expect(selects.map(({ attempt, attemptCap }) => [attempt, attemptCap])).toEqual([
			[0, 3],
			[1, 3],
		]);
		expect(selects.every((select) => select.requestId === requestId)).toBe(true);
		expect(selects[0]?.history).toEqual([]);
		expect(selects[1]?.history).toEqual([
			{ vendor: "smartproxy", outcome: "error", errorCode: expect.any(String) },
		]);
		expect(reports.map(({ phase, outcome, attempt }) => [phase, outcome, attempt])).toEqual([
			["resolution", "ok", 0],
			["transport", "error", 0],
			["resolution", "ok", 1],
			["transport", "ok", 1],
		]);
		expect(reports.every((report) => report.requestId === requestId)).toBe(true);
		const sessions = hits.map((hit) => tokens(hit.username).session);
		expect(
			reports.filter((report) => report.phase === "transport").map((r) => r.sessionId),
		).toEqual(sessions);
	});

	it("ctx.http on Bun's fetch leaves a refused session for a new one", () => {
		const { httpRotating } = wire;
		expect(httpRotating.status).toBe(200);
		expect(httpRotating.body).toEqual({ path: "/http-rotating", viaGateway: true });
		expect(httpRotating.hits.map((hit) => hit.refused)).toEqual([true, false]);
		const [refused, passed] = httpRotating.hits.map((hit) => tokens(hit.username));
		expect(refused?.session).not.toBe(passed?.session);
		expect(httpRotating.hits.every((hit) => hit.password === "s3cret")).toBe(true);
	});

	it("ctx.http records each proxy attempt with a hash that tells the two sessions apart", () => {
		const { attempts, attemptSamples } = wire.httpRotating;
		expect(attempts.map(({ provider, attempt, outcome }) => [provider, attempt, outcome])).toEqual([
			["smartproxy", 1, "error"],
			["smartproxy", 2, "ok"],
		]);
		expect(attempts[0]?.errorCode).toBeString();
		expect(attempts[1]?.status).toBe(200);
		const [refused, passed] = attempts.map((attempt) => attempt.proxyHash);
		expect(refused).toMatch(/^[0-9a-f]{12}$/);
		expect(passed).toMatch(/^[0-9a-f]{12}$/);
		// One gateway host and port for both: only the session id differs.
		expect(refused).not.toBe(passed);
		expect(attemptSamples.map(({ a, h, o }) => [a, h, o])).toEqual([
			[1, refused, "error"],
			[2, passed, "ok"],
		]);
	});

	it("keeps one session per affinity key and lifetime window, and moves a retry to the next one", () => {
		const { epochBefore, epochAfter, reads } = wire.sticky;
		expect(epochAfter).toBe(epochBefore);
		const session = (read: Read, index = 0) => tokens(read.hits[index]?.username ?? "").session;
		const own = sid("acct-1", epochBefore, 0);

		for (const read of [reads.firstClient, reads.firstClientAgain, reads.secondClient]) {
			expect(read.status).toBe(200);
			expect(read.hits).toHaveLength(1);
			expect(tokens(read.hits[0]?.username ?? "").life).toBe(120);
			expect(session(read)).toBe(own);
		}
		expect(session(reads.otherAffinity)).toBe(sid("acct-2", epochBefore, 0));
		expect(session(reads.otherAffinity)).not.toBe(own);

		const retried = reads.refusedThenRetried;
		expect(retried.status).toBe(200);
		expect(retried.hits.map((hit) => hit.refused)).toEqual([true, false]);
		expect(session(retried, 0)).toBe(own);
		expect(session(retried, 1)).toBe(sid("acct-1", epochBefore, 1));
	});

	it("a served provider reaches the default gateway endpoint with the gateway username", () => {
		const { served } = wire;
		expect(served.status).toBe(200);
		expect(served.data).toEqual({ path: "/served", viaGateway: true });
		expect(served.rewrites).toEqual([{ host: "proxy.smartproxy.net", port: 3120 }]);
		expect(served.hits).toHaveLength(1);
		expect(tokens(served.hits[0]?.username ?? "").life).toBe(30);
		expect(served.logProxy).toMatchObject({
			kind: "resolved",
			provider: "smartproxy",
			cacheStatus: "disabled",
		});
	});

	it("fails a served request that has only the retired app key, naming the gateway secrets", () => {
		const { servedMissingCredentials } = wire;
		expect(servedMissingCredentials.status).toBe(200);
		expect(servedMissingCredentials.data).toEqual({
			errorCode: "PROXY_REQUIRED",
			errorMessage:
				"Proxy egress is required but no vendor credentials are configured. Missing: APIFUSE__PROXY__SMARTPROXY_USERNAME and APIFUSE__PROXY__SMARTPROXY_PASSWORD (smartproxy).",
		});
		expect(servedMissingCredentials.hits).toEqual([]);
	});
});
