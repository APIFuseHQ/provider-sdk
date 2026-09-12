import { expect, it } from "bun:test";

// Separate processes keep these native transports independent of the fetch and
// WebSocket doubles used elsewhere in the suite.
it.each([
	"cdp-success",
	"cdp-error",
	"cdp-abort",
	"cdp-held-release",
	"cdp-release-error",
	"cdp-open",
	"cdp-disable-error",
	"cdp-late-route",
	"http-pre-abort",
	"http-headers",
	"http-factory-ambient",
	"http-timeout-body",
	"http-stream-local",
	"http-stream-ambient",
	"http-buffered",
	"http-backoff",
	"http-eof",
	"http-body-error",
])("native transport lifecycle: %s", async (scenario) => {
	const child = Bun.spawn({
		cmd: [
			process.execPath,
			new URL("./fixtures/transport-lifecycle.ts", import.meta.url).pathname,
			scenario,
		],
		stdout: "pipe",
		stderr: "pipe",
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	expect({ code, stderr, stdout }).toEqual({ code: 0, stderr: "", stdout: `${scenario}: ok\n` });
}, 10_000);
