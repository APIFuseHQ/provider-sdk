import { describe, expect, it } from "bun:test";

type Hit = {
	app: string;
	path: string;
	method: string;
	status: number;
	edgeCookie: string | null;
	authorization: string | null;
	cookie: string | null;
	headerNames: string[];
};
type SessionStateCounts = {
	acquired: number;
	reused: number;
	expired: number;
	invalidated: number;
	reacquired: number;
	waited: number;
};
type Call = {
	status: number;
	body: { data?: Record<string, unknown>; error?: Record<string, unknown> };
	bodyText: string;
	telemetryHeader: string | null;
	hits: Hit[];
	stealthLog: { sessionState?: SessionStateCounts } | null;
	httpLog: { sessionState?: SessionStateCounts } | null;
};
type Wire = Record<
	| "presetFirst"
	| "presetSecond"
	| "unlisted"
	| "optedOut"
	| "holdCarried"
	| "revoked"
	| "holdRevoked"
	| "exhausted"
	| "directFirst"
	| "directSecond"
	| "ttlFirst"
	| "ttlSecond"
	| "ttlExpired"
	| "idleFirst"
	| "idleSecond"
	| "idleThird"
	| "idleExpired"
	| "usesFirst"
	| "usesSecond"
	| "usesThird"
	| "shareAfter"
	| "presetPastCookieExpiry"
	| "plainSearch"
	| "headerFirst"
	| "headerSecond"
	| "headerRevoked"
	| "memberOk"
	| "memberStale"
	| "memberNone",
	Call
> & {
	authFlow: { status: number; hits: Hit[] };
	sharedBurst: { calls: Call[]; hits: Hit[] };
	shareBurst: { calls: Call[]; hits: Hit[] };
	everyIssuedValue: string[];
	logText: string;
	presetDeclaration: unknown;
	directDeclaration: unknown;
};

// Real provider apps (createServerApp), the real wreq-js stealth transport and
// the real native ctx.http transport, against a local origin that answers with
// the recorded 403 block page. Run in a subprocess so the wreq-js module mock in
// other test files cannot replace the stealth transport.
async function runSessionStateWire(): Promise<Wire> {
	const subprocess = Bun.spawn({
		cmd: [process.execPath, new URL("./fixtures/session-state-wire.ts", import.meta.url).pathname],
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`session-state wire fixture failed: ${stderr}`);
	return JSON.parse(stdout) as Wire;
}

const counts = (partial: Partial<SessionStateCounts>): SessionStateCounts => ({
	acquired: 0,
	reused: 0,
	expired: 0,
	invalidated: 0,
	reacquired: 0,
	waited: 0,
	...partial,
});

const shape = (hit: Hit) => ({
	method: hit.method,
	path: hit.path,
	status: hit.status,
	carried: hit.edgeCookie !== null,
});

describe("operational assembly: provider-declared session state on the real transports", () => {
	it("acquires on the recorded block page, re-sends once, pools the cookie and renews it on invalidity", async () => {
		const wire = await runSessionStateWire();

		// (a) First call: the cookie-less read meets the block page and its cookie;
		// the layer keeps the cookie and re-sends the same read once, carrying it.
		expect(wire.presetFirst.status).toBe(200);
		expect(wire.presetFirst.body.data).toEqual({ status: 200, outcome: null, attempts: null });
		expect(wire.presetFirst.hits.map(shape)).toEqual([
			{ method: "GET", path: "/stays/1/detail", status: 403, carried: false },
			{ method: "GET", path: "/stays/1/detail", status: 200, carried: true },
		]);
		expect(wire.presetFirst.stealthLog?.sessionState).toEqual(
			counts({ acquired: 1, reacquired: 1 }),
		);
		// Second call: one request, carrying the pooled cookie (renewed by the served read).
		expect(wire.presetSecond.hits.map(shape)).toEqual([
			{ method: "GET", path: "/stays/1/detail", status: 200, carried: true },
		]);
		expect(wire.presetSecond.stealthLog?.sessionState).toEqual(counts({ reused: 1 }));
		const firstCarried = wire.presetFirst.hits[1]?.edgeCookie;
		expect(wire.presetSecond.hits[0]?.edgeCookie).not.toBe(firstCarried);
		expect(wire.everyIssuedValue).toContain(wire.presetSecond.hits[0]?.edgeCookie ?? "");

		// (d) Outside the layer: an unlisted operation, `sessionState: false` and an
		// auth flow each send one cookie-less read even though the pool holds a cookie.
		for (const outside of [wire.unlisted, wire.optedOut]) {
			expect(outside.body.data).toEqual({ status: 403, outcome: null, attempts: null });
			expect(outside.hits.map(shape)).toEqual([
				{ method: "GET", path: "/stays/1/detail", status: 403, carried: false },
			]);
			expect(outside.stealthLog?.sessionState).toBeUndefined();
		}
		expect(wire.authFlow.status).toBe(200);
		expect(wire.authFlow.hits.map(shape)).toEqual([
			{ method: "GET", path: "/stays/1/detail", status: 403, carried: false },
		]);
		// An operation outside every declaration sends the request a provider
		// without sessionState sends.
		expect(wire.unlisted.hits[0]?.headerNames).toEqual(wire.plainSearch.hits[0]?.headerNames ?? []);
		expect(wire.plainSearch.stealthLog?.sessionState).toBeUndefined();

		// A POST in scope carries the pooled cookie.
		expect(wire.holdCarried.hits.map(shape)).toEqual([
			{ method: "POST", path: "/stays/1/hold", status: 200, carried: true },
		]);

		// (c) The carried cookie is refused: the block page's new cookie replaces it
		// and the read is re-sent once.
		expect(wire.revoked.body.data).toEqual({ status: 200, outcome: null, attempts: null });
		expect(wire.revoked.hits.map(shape)).toEqual([
			{ method: "GET", path: "/stays/1/detail", status: 403, carried: true },
			{ method: "GET", path: "/stays/1/detail", status: 200, carried: true },
		]);
		expect(wire.revoked.hits[0]?.edgeCookie).not.toBe(wire.revoked.hits[1]?.edgeCookie);
		expect(wire.revoked.stealthLog?.sessionState).toEqual(
			counts({ reused: 1, invalidated: 1, acquired: 1, reacquired: 1 }),
		);
		// A refused POST is not re-sent: the provider gets replay_required.
		expect(wire.holdRevoked.body.data).toEqual({
			status: 403,
			outcome: "replay_required",
			attempts: 1,
		});
		expect(wire.holdRevoked.hits.map(shape)).toEqual([
			{ method: "POST", path: "/stays/1/hold", status: 403, carried: true },
		]);
		// Refused again after the re-acquisition: the response comes back classified
		// and the provider's BLOCKED keeps its public shape, block page withheld.
		expect(wire.exhausted.status).toBe(502);
		expect(wire.exhausted.body.error).toMatchObject({
			code: "BLOCKED",
			details: { egress_attempts: 2 },
		});
		expect(wire.exhausted.hits.map(shape)).toEqual([
			{ method: "GET", path: "/stays/1/detail", status: 403, carried: true },
			{ method: "GET", path: "/stays/1/detail", status: 403, carried: true },
		]);
		expect(wire.exhausted.bodyText).not.toContain("RayID");
		expect(wire.exhausted.bodyText).not.toContain("challenge-platform");

		// (e) The preset is a plain declaration: the same value written by hand
		// behaves identically.
		expect(wire.presetDeclaration).toEqual(wire.directDeclaration);
		expect(wire.directFirst.hits.map(shape)).toEqual(wire.presetFirst.hits.map(shape));
		expect(wire.directSecond.hits.map(shape)).toEqual(wire.presetSecond.hits.map(shape));
		expect(wire.directFirst.stealthLog?.sessionState).toEqual(
			wire.presetFirst.stealthLog?.sessionState,
		);

		// (b) ttl: reused inside it, acquired afresh after it.
		expect(wire.ttlFirst.hits.map(shape)).toEqual(wire.presetFirst.hits.map(shape));
		expect(wire.ttlSecond.hits.map(shape)).toEqual(wire.presetSecond.hits.map(shape));
		expect(wire.ttlExpired.hits.map(shape)).toEqual([
			{ method: "GET", path: "/stays/1/detail", status: 403, carried: false },
			{ method: "GET", path: "/stays/1/detail", status: 200, carried: true },
		]);
		expect(wire.ttlExpired.stealthLog?.sessionState).toEqual(
			counts({ expired: 1, acquired: 1, reacquired: 1 }),
		);

		// idleTtl: reused while in use, acquired afresh after the idle window.
		expect(wire.idleFirst.hits.map(shape)).toEqual(wire.presetFirst.hits.map(shape));
		for (const call of [wire.idleSecond, wire.idleThird])
			expect(call.hits.map(shape)).toEqual(wire.presetSecond.hits.map(shape));
		expect(wire.idleExpired.hits.map(shape)).toEqual(wire.ttlExpired.hits.map(shape));
		expect(wire.idleExpired.stealthLog?.sessionState).toEqual(
			counts({ expired: 1, acquired: 1, reacquired: 1 }),
		);
		// maxUses 2: the re-sent first read and the second call use the state up.
		expect(wire.usesFirst.hits.map(shape)).toEqual(wire.presetFirst.hits.map(shape));
		expect(wire.usesSecond.hits.map(shape)).toEqual(wire.presetSecond.hits.map(shape));
		expect(wire.usesThird.hits.map(shape)).toEqual(wire.ttlExpired.hits.map(shape));
		expect(wire.usesThird.stealthLog?.sessionState).toEqual(
			counts({ expired: 1, acquired: 1, reacquired: 1 }),
		);

		// (g) qps omitted: three concurrent calls share one state; one acquisition,
		// the other two wait for it and send once each.
		const sharedHits = wire.sharedBurst.hits;
		expect(sharedHits.filter((hit) => hit.edgeCookie === null).map(shape)).toEqual([
			{ method: "GET", path: "/stays/1/detail", status: 403, carried: false },
		]);
		expect(sharedHits.filter((hit) => hit.status === 200)).toHaveLength(3);
		expect(new Set(sharedHits.map((hit) => hit.edgeCookie).filter(Boolean)).size).toBe(1);
		expect(
			wire.sharedBurst.calls.map((call) => call.stealthLog?.sessionState?.waited ?? 0).sort(),
		).toEqual([0, 1, 1]);
		// qps 1: each state carries one request per second, so the three concurrent
		// calls do not wait; the pool grows to three states, one per call.
		const shareHits = wire.shareBurst.hits;
		expect(shareHits.filter((hit) => hit.edgeCookie === null)).toHaveLength(3);
		const shareServed = shareHits.filter((hit) => hit.status === 200);
		expect(shareServed).toHaveLength(3);
		expect(new Set(shareServed.map((hit) => hit.edgeCookie)).size).toBe(3);
		for (const call of wire.shareBurst.calls) {
			expect(call.status).toBe(200);
			expect(call.stealthLog?.sessionState).toEqual(counts({ acquired: 1, reacquired: 1 }));
		}
		// A second later the pooled states have room again: one request, no acquisition.
		expect(wire.shareAfter.hits.map(shape)).toEqual([
			{ method: "GET", path: "/stays/1/detail", status: 200, carried: true },
		]);
		expect(wire.shareAfter.stealthLog?.sessionState).toEqual(counts({ reused: 1 }));

		// The cookie's own Expires is not a retirement rule: past it, inside the
		// declared ttl, the stored value is still carried and served.
		expect(wire.presetPastCookieExpiry.hits.map(shape)).toEqual([
			{ method: "GET", path: "/stays/1/detail", status: 200, carried: true },
		]);
		expect(wire.presetPastCookieExpiry.stealthLog?.sessionState).toEqual(counts({ reused: 1 }));

		// (f) header carry on ctx.http, acquired by the declared request first.
		const [tokenRequest, firstRead] = wire.headerFirst.hits;
		expect(wire.headerFirst.hits.map((hit) => [hit.method, hit.path, hit.status])).toEqual([
			["POST", "/guest/token", 200],
			["GET", "/api/items", 200],
		]);
		expect(tokenRequest?.authorization).toBeNull();
		expect(firstRead?.authorization).toMatch(/^Bearer guest-/);
		expect(wire.headerSecond.hits.map((hit) => [hit.method, hit.path, hit.authorization])).toEqual([
			["GET", "/api/items", firstRead?.authorization ?? ""],
		]);
		expect(wire.headerRevoked.body.data).toEqual({ status: 200, outcome: null });
		expect(wire.headerRevoked.hits.map((hit) => [hit.method, hit.path, hit.status])).toEqual([
			["GET", "/api/items", 401],
			["POST", "/guest/token", 200],
			["GET", "/api/items", 200],
		]);
		expect(wire.headerRevoked.hits[2]?.authorization).not.toBe(firstRead?.authorization);
		expect(wire.headerRevoked.httpLog?.sessionState).toEqual(
			counts({ reused: 1, invalidated: 1, acquired: 1, reacquired: 1 }),
		);

		// (f) cookie-header carry from the connection credential; a 401 is classified,
		// never re-acquired, and a connection without the key is left alone.
		expect(wire.memberOk.body.data).toEqual({ status: 200, outcome: null });
		expect(wire.memberOk.hits[0]?.cookie).toContain("member_session=member-session-ok");
		expect(wire.memberOk.hits[0]?.cookie).toContain("theme=dark");
		expect(wire.memberStale.body.data).toEqual({ status: 401, outcome: "credential_invalid" });
		expect(wire.memberStale.hits).toHaveLength(1);
		expect(wire.memberNone.body.data).toEqual({ status: 401, outcome: null });
		expect(wire.memberNone.hits[0]?.cookie).toBeNull();

		// Captured and carried values never reach logs, telemetry or responses.
		for (const value of wire.everyIssuedValue) {
			expect(wire.logText).not.toContain(value);
			for (const call of [wire.presetFirst, wire.presetSecond, wire.revoked, wire.exhausted]) {
				expect(call.bodyText).not.toContain(value);
				expect(call.telemetryHeader ?? "").not.toContain(value);
			}
		}
		expect(wire.logText).not.toContain("member-session-ok");
	}, 60_000);
});

type EgressCall = {
	status: number;
	exits: string[];
	origin: { path: string; status: number; edgeCookie: string | null }[];
};
type EgressWire = Record<
	"independentFirst" | "independentSecond" | "pinnedFirst" | "pinnedSecond",
	EgressCall
>;

// The same apps behind an operation-scoped NodeMaven mobile policy, with a local
// stand-in for the gateway; see the fixture header.
async function runSessionStateEgressWire(): Promise<EgressWire> {
	const subprocess = Bun.spawn({
		cmd: [
			process.execPath,
			new URL("./fixtures/session-state-egress-wire.ts", import.meta.url).pathname,
		],
		stderr: "pipe",
		stdout: "pipe",
	});
	const [exitCode, stdout, stderr] = await Promise.all([
		subprocess.exited,
		new Response(subprocess.stdout).text(),
		new Response(subprocess.stderr).text(),
	]);
	if (exitCode !== 0) throw new Error(`session-state egress wire fixture failed: ${stderr}`);
	return JSON.parse(stdout) as EgressWire;
}

const carrierAndSid = (username: string | undefined) => {
	const match = /-isp-([a-z_]+)-type-mobile-ipv4-true-sid-([0-9a-f]{10})$/.exec(username ?? "");
	return { carrier: match?.[1], sid: match?.[2] };
};

describe("operational assembly: session state next to operation-scoped NodeMaven mobile egress", () => {
	it("re-sends on the next carrier by default and on the acquiring exit when egress is pinned", async () => {
		const wire = await runSessionStateEgressWire();
		for (const call of Object.values(wire)) expect(call.status).toBe(200);

		// independent: the re-send moves to the next pool slot (next carrier, new sid),
		// as the provider's own retry used to; the cookie travels across exits.
		const [blocked, replayed] = wire.independentFirst.exits.map(carrierAndSid);
		expect(blocked?.carrier).toBe("sk_telecom");
		expect(replayed?.carrier).toBe("lg_uplus");
		expect(replayed?.sid).not.toBe(blocked?.sid);
		expect(
			wire.independentFirst.origin.map((hit) => [hit.status, hit.edgeCookie !== null]),
		).toEqual([
			[403, false],
			[200, true],
		]);
		expect(wire.independentSecond.exits).toHaveLength(1);
		expect(carrierAndSid(wire.independentSecond.exits[0]).sid).not.toBe(blocked?.sid);
		expect(
			wire.independentSecond.origin.map((hit) => [hit.status, hit.edgeCookie !== null]),
		).toEqual([[200, true]]);

		// pinned: the re-send and the next call reuse the exit the cookie was acquired on.
		const pinnedExit = wire.pinnedFirst.exits[0];
		expect(wire.pinnedFirst.exits).toEqual([pinnedExit ?? "", pinnedExit ?? ""]);
		expect(wire.pinnedSecond.exits).toEqual([pinnedExit ?? ""]);
		expect(wire.pinnedSecond.origin.map((hit) => [hit.status, hit.edgeCookie !== null])).toEqual([
			[200, true],
		]);
	}, 60_000);
});
