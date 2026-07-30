import { createHash } from "node:crypto";
import { Socket } from "node:net";
import { connect as connectTlsSocket, type TLSSocket } from "node:tls";

import { SocksClient } from "socks";

import { ProxyResolutionError } from "../config/loader.js";
import { TransportError } from "../errors.js";
import type {
	NativeNetworkClient,
	NativeNetworkConnection,
	NativeNetworkConnectInput,
	NativeNetworkDynamicGrantOptions,
	NativeNetworkEgressGrant,
	NativeProxyDrainHandler,
	NativeProxyEgressInfo,
	NativeProxyExpiringEvent,
	ProviderProxyPolicy,
	ProviderProxyProvider,
} from "../types.js";
import {
	hasNodemavenCredentials,
	nodemavenSessionWindow,
	synthesizeNodemavenProxy,
} from "./proxy-nodemaven.js";

export type NativeNetworkErrorCode =
	| "native_connection_aborted"
	| "native_connection_closed"
	| "native_connection_failed"
	| "native_connection_idle_timeout"
	| "native_connection_timeout"
	| "native_dynamic_egress_unsupported"
	| "native_proxy_expired"
	| "native_proxy_invalid";

export class NativeNetworkError extends TransportError {
	constructor(message: string, code: NativeNetworkErrorCode) {
		super(message, { code, status: 0 });
		this.name = "NativeNetworkError";
	}

	override get code(): NativeNetworkErrorCode {
		return super.code as NativeNetworkErrorCode;
	}
}

export class NativeProxyExpiredError extends NativeNetworkError {
	constructor(readonly expiresAt: string) {
		super("Native connection closed at sticky proxy expiry", "native_proxy_expired");
		this.name = "NativeProxyExpiredError";
	}
}

/** Raised when an established connection exceeds its opt-in read-idle window. */
export class NativeIdleTimeoutError extends NativeNetworkError {
	constructor() {
		super(
			"Native network socket timed out while reading.",
			"native_connection_idle_timeout",
		);
		this.name = "NativeIdleTimeoutError";
	}
}

export type NativeGatewayProxy = NativeProxyEgressInfo & {
	readonly url: string;
};

export type NativeGatewayProxySynthesisInput = {
	readonly vendor: ProviderProxyProvider;
	readonly policy: ProviderProxyPolicy;
	readonly affinityKey?: string;
	readonly now: number;
};

/** A vendor adapter in the ordered native gateway resolution chain. */
export type NativeGatewayProxySynthesizer = (
	input: NativeGatewayProxySynthesisInput,
) => NativeGatewayProxy | undefined;

export type NativeGatewayProxyResolutionInput = {
	readonly policy: ProviderProxyPolicy;
	readonly affinityKey?: string;
	readonly now?: number;
	readonly gatewaySynthesizers?: readonly NativeGatewayProxySynthesizer[];
};

export type NativeNetworkClientOptions = {
	readonly proxyPolicy?: ProviderProxyPolicy;
	readonly affinityKey?: string;
	/** Stable credential/account identity; hashed before vendor synthesis. */
	readonly credentialIdentity?: string;
	/** Vendor adapters in priority order within each policy vendor slot. */
	readonly gatewaySynthesizers?: readonly NativeGatewayProxySynthesizer[];
	/** Warning-level lifecycle diagnostic sink. */
	readonly warn?: (message: string) => void;
	/** Delegate to the deployment's native egress authorization layer. */
	readonly grantTcpEgress?: (input: NativeNetworkDynamicGrantOptions) => NativeNetworkEgressGrant;
};

function synthesizeNodemavenGateway(
	input: NativeGatewayProxySynthesisInput,
): NativeGatewayProxy | undefined {
	if (input.vendor !== "nodemaven" || !hasNodemavenCredentials()) return undefined;

	// NodeMaven defaults ctx.http to HTTP CONNECT because SOCKS5 adds ~500ms per
	// request. Native LOCO pays this once per long-lived connection and must reach
	// arbitrary destination ports, so SOCKS5 is mandatory here.
	const sessionWindow = nodemavenSessionWindow(input.policy, input.now);
	const synthesized = synthesizeNodemavenProxy({
		policy: input.policy,
		affinityKey: input.affinityKey,
		protocol: "socks5",
		poolIndex: 0,
		refreshEpoch: sessionWindow.refreshEpoch,
		now: input.now,
		expiresAt: sessionWindow.expiresAt,
	});
	return {
		url: synthesized.url,
		vendor: "nodemaven",
		sticky: synthesized.sticky,
		sessionId: synthesized.sessionId,
		expiresAt: synthesized.expiresAt,
	};
}

const DEFAULT_GATEWAY_SYNTHESIZERS: readonly NativeGatewayProxySynthesizer[] = [
	synthesizeNodemavenGateway,
];

/** Domain-separated, process-independent affinity derived from credential identity. */
export function deriveNativeCredentialAffinityKey(credentialIdentity: string): string {
	return createHash("sha256")
		.update("apifuse-native-proxy-affinity:v1\0")
		.update(credentialIdentity)
		.digest("hex");
}

function isStickyPolicy(policy: ProviderProxyPolicy): boolean {
	return (policy.session?.affinity ?? "request") !== "request";
}

function resolveNativeVendorChain(policy: ProviderProxyPolicy): ProviderProxyProvider[] {
	const declared = policy.providers?.length
		? policy.providers
		: policy.provider
			? [policy.provider]
			: (["nodemaven"] as const);
	const chain: ProviderProxyProvider[] = [];
	for (const vendor of declared) {
		if (!chain.includes(vendor)) chain.push(vendor);
	}
	return chain;
}

/** Resolve the first configured native gateway without invoking an allocator API. */
export function resolveNativeGatewayProxy(
	input: NativeGatewayProxyResolutionInput,
): NativeGatewayProxy | undefined {
	if (input.policy.mode === "disabled") return undefined;
	const synthesizers = input.gatewaySynthesizers ?? DEFAULT_GATEWAY_SYNTHESIZERS;
	const now = input.now ?? Date.now();
	for (const vendor of resolveNativeVendorChain(input.policy)) {
		for (const synthesize of synthesizers) {
			const resolved = synthesize({
				vendor,
				policy: input.policy,
				affinityKey: input.affinityKey,
				now,
			});
			if (resolved && resolved.vendor === vendor) return resolved;
		}
	}
	return undefined;
}

function proxyRequiredError(policy: ProviderProxyPolicy): ProxyResolutionError {
	const chain = resolveNativeVendorChain(policy).filter(
		(vendor): vendor is "smartproxy" | "nodemaven" =>
			vendor === "smartproxy" || vendor === "nodemaven",
	);
	return new ProxyResolutionError(
		"PROXY_REQUIRED",
		`Native proxy egress is required but no gateway vendor in [${chain.join(", ") || "none"}] resolved.`,
		{ vendorChain: chain },
	);
}

type Deadline = number | undefined;

function deadlineFrom(timeoutMs: number | undefined): Deadline {
	if (timeoutMs === undefined) return undefined;
	return Date.now() + Math.max(0, timeoutMs);
}

function remainingMs(deadline: Deadline): number | undefined {
	return deadline === undefined ? undefined : Math.max(0, deadline - Date.now());
}

function abortError(): NativeNetworkError {
	return new NativeNetworkError("Native connection was aborted", "native_connection_aborted");
}

function timeoutError(): NativeNetworkError {
	return new NativeNetworkError("Native connection timed out", "native_connection_timeout");
}

function failedError(): NativeNetworkError {
	return new NativeNetworkError("Native connection failed", "native_connection_failed");
}

function assertCanStart(signal: AbortSignal | undefined, deadline: Deadline): void {
	if (signal?.aborted) throw abortError();
	if (deadline !== undefined && deadline <= Date.now()) throw timeoutError();
}

async function waitForSocketEvent(
	socket: Socket | TLSSocket,
	event: "connect" | "secureConnect",
	signal: AbortSignal | undefined,
	deadline: Deadline,
): Promise<void> {
	assertCanStart(signal, deadline);
	await new Promise<void>((resolve, reject) => {
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			socket.off(event, onReady);
			socket.off("error", onError);
			socket.off("close", onClose);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (error?: Error) => {
			cleanup();
			if (error) {
				socket.on("error", () => undefined);
				socket.destroy();
				reject(error);
			} else resolve();
		};
		const onReady = () => finish();
		const onError = () => finish(failedError());
		const onClose = () => finish(failedError());
		const onAbort = () => finish(abortError());

		socket.once(event, onReady);
		socket.once("error", onError);
		socket.once("close", onClose);
		signal?.addEventListener("abort", onAbort, { once: true });
		const remaining = remainingMs(deadline);
		if (remaining !== undefined) timer = setTimeout(() => finish(timeoutError()), remaining);
	});
}

async function connectPlainSocket(
	host: string,
	port: number,
	signal: AbortSignal | undefined,
	deadline: Deadline,
): Promise<Socket> {
	assertCanStart(signal, deadline);
	const socket = new Socket();
	const ready = waitForSocketEvent(socket, "connect", signal, deadline);
	socket.connect({ host, port });
	await ready;
	return socket;
}

function parseSocks5Proxy(proxyUrl: string): {
	host: string;
	port: number;
	userId?: string;
	password?: string;
} {
	let parsed: URL;
	try {
		parsed = new URL(proxyUrl);
	} catch {
		throw new NativeNetworkError("Native proxy URL is invalid", "native_proxy_invalid");
	}
	const port = Number(parsed.port);
	if (parsed.protocol !== "socks5:" || !parsed.hostname || !Number.isInteger(port) || port <= 0) {
		throw new NativeNetworkError("Native proxy URL is invalid", "native_proxy_invalid");
	}
	try {
		return {
			host: parsed.hostname,
			port,
			...(parsed.username ? { userId: decodeURIComponent(parsed.username) } : {}),
			...(parsed.password ? { password: decodeURIComponent(parsed.password) } : {}),
		};
	} catch {
		throw new NativeNetworkError("Native proxy URL is invalid", "native_proxy_invalid");
	}
}

async function waitForSocksHandshake(
	proxySocket: Socket,
	promise: ReturnType<typeof SocksClient.createConnection>,
	signal: AbortSignal | undefined,
	deadline: Deadline,
): Promise<Socket> {
	assertCanStart(signal, deadline);
	return await new Promise<Socket>((resolve, reject) => {
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | undefined;
		const cleanup = () => {
			if (timer) clearTimeout(timer);
			signal?.removeEventListener("abort", onAbort);
		};
		const finish = (error: Error | undefined, socket?: Socket) => {
			if (settled) return;
			settled = true;
			cleanup();
			if (error) {
				proxySocket.destroy();
				reject(error);
			} else if (socket) resolve(socket);
			else reject(failedError());
		};
		const onAbort = () => finish(abortError());
		signal?.addEventListener("abort", onAbort, { once: true });
		const remaining = remainingMs(deadline);
		if (remaining !== undefined) timer = setTimeout(() => finish(timeoutError()), remaining);
		void promise.then(
			(result) => finish(undefined, result.socket),
			(error) =>
				finish(
					error instanceof Error && /\b(?:timed out|timeout)\b/i.test(error.message)
						? timeoutError()
						: failedError(),
				),
		);
	});
}

async function connectSocksTunnel(
	proxy: NativeGatewayProxy,
	input: NativeNetworkConnectInput,
	deadline: Deadline,
): Promise<Socket> {
	const parsed = parseSocks5Proxy(proxy.url);
	const proxySocket = await connectPlainSocket(parsed.host, parsed.port, input.signal, deadline);
	// `socks` removes its internal listeners as the handshake settles. Keep a
	// credential-free sink on the owned socket so an abort/close race cannot emit
	// an unhandled late network error between library cleanup and our wrapper.
	proxySocket.on("error", () => undefined);
	const remaining = remainingMs(deadline);
	const handshake = SocksClient.createConnection({
		command: "connect",
		destination: { host: input.host, port: input.port },
		proxy: { type: 5, ...parsed },
		existing_socket: proxySocket,
		...(remaining === undefined ? {} : { timeout: Math.max(1, remaining) }),
	});
	return await waitForSocksHandshake(proxySocket, handshake, input.signal, deadline);
}

async function upgradeTls(
	socket: Socket | undefined,
	input: NativeNetworkConnectInput,
	deadline: Deadline,
): Promise<TLSSocket> {
	assertCanStart(input.signal, deadline);
	const tlsSocket = socket
		? connectTlsSocket({
				socket,
				servername: input.serverName ?? input.host,
				rejectUnauthorized: input.rejectUnauthorized,
			})
		: connectTlsSocket({
				host: input.host,
				port: input.port,
				servername: input.serverName ?? input.host,
				rejectUnauthorized: input.rejectUnauthorized,
			});
	await waitForSocketEvent(tlsSocket, "secureConnect", input.signal, deadline);
	return tlsSocket;
}

export function createNativeNetworkConnection(
	socket: Socket | TLSSocket,
	proxy: NativeGatewayProxy | undefined,
	options: NativeNetworkClientOptions,
	idleTimeoutMs?: number,
): NativeNetworkConnection {
	const warn = options.warn ?? console.warn;
	let terminalError: Error | undefined;
	let closeReason: NativeNetworkError | undefined;
	let drainHandler: NativeProxyDrainHandler | undefined;
	let idleTimer: ReturnType<typeof setTimeout> | undefined;
	let expiringTimer: ReturnType<typeof setTimeout> | undefined;
	let hardExpiryTimer: ReturnType<typeof setTimeout> | undefined;
	let lifecycleSettled = false;
	let settleLifecycle: () => void = () => undefined;
	const lifecycleCutoff = new Promise<void>((resolve) => {
		settleLifecycle = resolve;
	});
	const clearIdleTimer = () => {
		if (idleTimer) clearTimeout(idleTimer);
		idleTimer = undefined;
	};
	const resetIdleTimer = () => {
		clearIdleTimer();
		if (idleTimeoutMs === undefined || socket.readableEnded || socket.destroyed) return;
		idleTimer = setTimeout(() => {
			idleTimer = undefined;
			if (socket.readableEnded || socket.destroyed) return;
			closeReason = new NativeIdleTimeoutError();
			socket.destroy(closeReason);
		}, Math.max(0, idleTimeoutMs));
		idleTimer.unref?.();
	};
	const clearLifecycle = () => {
		clearIdleTimer();
		if (lifecycleSettled) return;
		lifecycleSettled = true;
		if (expiringTimer) clearTimeout(expiringTimer);
		if (hardExpiryTimer) clearTimeout(hardExpiryTimer);
		settleLifecycle();
	};
	socket.on("error", (error) => {
		terminalError = error;
	});
	socket.once("end", clearIdleTimer);
	socket.once("close", clearLifecycle);
	resetIdleTimer();

	const expiresAt = proxy?.sticky ? proxy.expiresAt : undefined;
	const leadSeconds = options.proxyPolicy?.session?.drainLeadSeconds;
	const expiresAtMs = expiresAt ? Date.parse(expiresAt) : Number.NaN;
	if (
		expiresAt &&
		Number.isFinite(expiresAtMs) &&
		typeof leadSeconds === "number" &&
		Number.isFinite(leadSeconds) &&
		leadSeconds >= 0
	) {
		const event: NativeProxyExpiringEvent = {
			expiresAt,
			leadSeconds,
			reason: "sticky_expiry",
		};
		const remaining = Math.max(0, expiresAtMs - Date.now());
		const leadDelay = Math.max(0, remaining - leadSeconds * 1_000);
		expiringTimer = setTimeout(() => {
			expiringTimer = undefined;
			const handler = drainHandler;
			if (!handler) {
				warn("Native sticky proxy is expiring without a drain handler");
				return;
			}
			void (async () => {
				try {
					await Promise.race([Promise.resolve(handler(event)), lifecycleCutoff]);
				} catch {
					// Drain failures do not bypass the hard-expiry fail-safe.
				}
			})();
		}, leadDelay);
		expiringTimer.unref?.();
		hardExpiryTimer = setTimeout(() => {
			hardExpiryTimer = undefined;
			if (socket.destroyed) return;
			closeReason = new NativeProxyExpiredError(expiresAt);
			settleLifecycle();
			socket.destroy();
		}, remaining);
		hardExpiryTimer.unref?.();
	}

	const read = async (): Promise<Uint8Array | null> => {
		if (closeReason) throw closeReason;
		if (terminalError) throw failedError();
		const chunk = socket.read() as Buffer | null;
		if (chunk) {
			resetIdleTimer();
			return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
		}
		if (socket.readableEnded || socket.destroyed) return null;
		await new Promise<void>((resolve) => {
			const cleanup = () => {
				socket.off("readable", onReadable);
				socket.off("end", onDone);
				socket.off("close", onDone);
				socket.off("error", onDone);
			};
			const onReadable = () => {
				cleanup();
				resolve();
			};
			const onDone = () => {
				cleanup();
				resolve();
			};
			socket.once("readable", onReadable);
			socket.once("end", onDone);
			socket.once("close", onDone);
			socket.once("error", onDone);
		});
		return await read();
	};

	return {
		get closeReason() {
			return closeReason;
		},
		...(proxy
			? {
					proxy: {
						vendor: proxy.vendor,
						sticky: proxy.sticky,
						sessionId: proxy.sessionId,
						expiresAt: proxy.expiresAt,
					},
				}
			: {}),
		read,
		onExpiring: (handler) => {
			drainHandler = handler;
		},
		write: async (data) => {
			if (closeReason) throw closeReason;
			if (socket.destroyed) {
				throw new NativeNetworkError("Native connection is closed", "native_connection_closed");
			}
			await new Promise<void>((resolve, reject) => {
				socket.write(data, (error) => {
					if (error) reject(failedError());
					else resolve();
				});
			});
		},
		close: async () => {
			if (socket.closed || socket.destroyed) {
				clearLifecycle();
				return;
			}
			await new Promise<void>((resolve) => {
				socket.once("close", () => resolve());
				socket.destroy();
			});
		},
	};
}

async function resolveConnectionProxy(
	options: NativeNetworkClientOptions,
	input: NativeNetworkConnectInput,
): Promise<NativeGatewayProxy | undefined> {
	const policy = options.proxyPolicy;
	if (!policy || policy.mode === "disabled") return undefined;
	const explicitAffinityKey = input.affinityKey ?? options.affinityKey;
	const affinityKey =
		explicitAffinityKey ??
		(isStickyPolicy(policy) && options.credentialIdentity !== undefined
			? deriveNativeCredentialAffinityKey(options.credentialIdentity)
			: undefined);
	const resolved = resolveNativeGatewayProxy({
		policy,
		affinityKey,
		gatewaySynthesizers: options.gatewaySynthesizers,
	});
	if (!resolved && policy.mode === "required") throw proxyRequiredError(policy);
	return resolved;
}

/** Create the SDK byte-stream runtime; deployment egress authorization stays delegated. */
export function createNativeNetworkClient(
	options: NativeNetworkClientOptions = {},
): NativeNetworkClient {
	return {
		connectTcp: async (input) => {
			const deadline = deadlineFrom(input.timeoutMs);
			assertCanStart(input.signal, deadline);
			const proxy = await resolveConnectionProxy(options, input);
			const socket = proxy
				? await connectSocksTunnel(proxy, input, deadline)
				: await connectPlainSocket(input.host, input.port, input.signal, deadline);
			return createNativeNetworkConnection(socket, proxy, options, input.idleTimeoutMs);
		},
		connectTls: async (input) => {
			const deadline = deadlineFrom(input.timeoutMs);
			assertCanStart(input.signal, deadline);
			const proxy = await resolveConnectionProxy(options, input);
			const tunnel = proxy ? await connectSocksTunnel(proxy, input, deadline) : undefined;
			const socket = await upgradeTls(tunnel, input, deadline);
			return createNativeNetworkConnection(socket, proxy, options, input.idleTimeoutMs);
		},
		grantTcpEgress: (input) => {
			if (options.grantTcpEgress) return options.grantTcpEgress(input);
			throw new NativeNetworkError(
				"Dynamic native egress authorization is not configured",
				"native_dynamic_egress_unsupported",
			);
		},
	};
}
