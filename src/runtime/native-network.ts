import { createHash } from "node:crypto";
import { Socket } from "node:net";
import { connect as connectTlsSocket, type TLSSocket } from "node:tls";

import { SocksClient } from "socks";

import { ProxyResolutionError } from "../config/loader.js";
import { TransportError } from "../errors.js";
import {
	type DynamicEgressRuleSnapshot,
	NativeEgressPolicyValidationError,
	parseNativeEgressPolicy,
	type StaticEgressRuleSnapshot,
} from "../native-egress-policy.js";
import type {
	NativeNetworkClient,
	NativeNetworkConnectInput,
	NativeNetworkConnection,
	NativeNetworkDynamicGrantOptions,
	NativeNetworkEgressGrant,
	NativeProviderConfig,
	NativeProxyDrainHandler,
	NativeProxyEgressInfo,
	NativeProxyExpiringEvent,
	NativeTcpPortRange,
	NativeTcpTlsMode,
	ProviderProxyPolicy,
	ProviderProxyProvider,
} from "../types.js";
import {
	hasNodemavenCredentials,
	nodemavenSessionWindow,
	synthesizeNodemavenProxy,
} from "./proxy-nodemaven.js";
import { redactSensitiveError } from "./request-options.js";

export type NativeNetworkErrorCode =
	| "native_connection_aborted"
	| "native_connection_closed"
	| "native_connection_failed"
	| "native_connection_idle_timeout"
	| "native_connection_timeout"
	| "native_egress_authorization_failed"
	| "native_egress_grant_expired"
	| "native_egress_grant_invalid"
	| "native_egress_grant_limit_exceeded"
	| "native_egress_input_invalid"
	| "native_egress_not_declared"
	| "native_egress_policy_invalid"
	| "native_dynamic_egress_unsupported"
	| "native_proxy_expired"
	| "native_proxy_invalid";

export class NativeNetworkError extends TransportError {
	constructor(message: string, code: NativeNetworkErrorCode, cause?: Error) {
		const isEgressPolicyFailure =
			code.startsWith("native_egress_") || code === "native_dynamic_egress_unsupported";
		super(message, {
			code,
			status: 0,
			...(cause ? { cause } : {}),
			...(isEgressPolicyFailure ? { category: "provider_error" as const, retryable: false } : {}),
		});
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

/** Raised before transport setup when a native destination is not authorized. */
export class NativeEgressNotDeclaredError extends NativeNetworkError {
	constructor(
		readonly host: string,
		readonly port: number,
		readonly tls: "required" | "disabled",
	) {
		super(
			`Native ${tls === "required" ? "TLS" : "TCP"} egress is not declared for ${host}:${port}`,
			"native_egress_not_declared",
		);
		this.name = "NativeEgressNotDeclaredError";
	}
}

/**
 * Raised when the destination was authorized by a grant whose TTL elapsed and
 * its expiry remains in the client's bounded recent-expiry evidence window.
 */
export class NativeEgressGrantExpiredError extends NativeNetworkError {
	constructor(
		readonly host: string,
		readonly port: number,
		readonly tls: "required" | "disabled",
		readonly expiresAt: string,
	) {
		super(
			`Native ${tls === "required" ? "TLS" : "TCP"} egress grant expired for ${host}:${port}`,
			"native_egress_grant_expired",
		);
		this.name = "NativeEgressGrantExpiredError";
	}
}

/** Raised when an established connection exceeds its opt-in read-idle window. */
export class NativeIdleTimeoutError extends NativeNetworkError {
	constructor() {
		super("Native network socket timed out while reading.", "native_connection_idle_timeout");
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
	/**
	 * Provider-declared native egress. Undefined preserves legacy unrestricted
	 * behavior; any provided declaration, including an empty object, is enforced.
	 */
	readonly egress?: NonNullable<NativeProviderConfig["network"]>;
	/** Additional deployment authorization layered on top of SDK enforcement. */
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

function failedError(cause?: Error): NativeNetworkError {
	return new NativeNetworkError("Native connection failed", "native_connection_failed", cause);
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
		const onError = (cause: Error) => finish(failedError(cause));
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

const SOCKS5_REPLY_CODES = {
	Failure: 0x01,
	NotAllowed: 0x02,
	NetworkUnreachable: 0x03,
	HostUnreachable: 0x04,
	ConnectionRefused: 0x05,
	TTLExpired: 0x06,
	CommandNotSupported: 0x07,
	AddressNotSupported: 0x08,
} as const;

function socks5ReplyCode(error: Error): number | undefined {
	const match = /Socks5 proxy rejected connection - ([A-Za-z]+)/i.exec(error.message);
	if (!match?.[1]) return undefined;
	const reply = Object.entries(SOCKS5_REPLY_CODES).find(
		([name]) => name.toLowerCase() === match[1]?.toLowerCase(),
	);
	return reply?.[1];
}

function sanitizeProxyFailureCause(
	error: Error,
	proxyUrl: string,
	credentials: { readonly userId?: string; readonly password?: string },
): Error {
	// socks' SocksClientError retains the live socket in options. It is neither
	// useful diagnostic payload nor serializable, so preserve the original error
	// while replacing only that options object with a socket-free snapshot.
	const options = Reflect.get(error, "options");
	if (options && typeof options === "object" && !Array.isArray(options)) {
		const snapshot = { ...(options as Record<string, unknown>) };
		delete snapshot.existing_socket;
		try {
			Reflect.set(error, "options", snapshot);
		} catch {
			// The recursive redactor below clones readonly diagnostics safely.
		}
	}

	const replyCode = socks5ReplyCode(error);
	if (replyCode !== undefined) {
		try {
			Object.defineProperty(error, "socks5ReplyCode", {
				value: replyCode,
				configurable: true,
				enumerable: true,
				writable: false,
			});
		} catch {
			// The reply label remains in message if an exotic error is immutable.
		}
	}

	let redactedProxyUrl = proxyUrl;
	try {
		const parsed = new URL(proxyUrl);
		parsed.username = "[REDACTED]";
		parsed.password = "[REDACTED]";
		redactedProxyUrl = parsed.toString();
	} catch {
		// parseSocks5Proxy already validated this URL; keep a defensive fallback.
	}
	return redactSensitiveError(
		error,
		[credentials.userId, credentials.password].filter(
			(value): value is string => typeof value === "string" && value.length > 0,
		),
		proxyUrl,
		redactedProxyUrl,
	);
}

async function waitForSocksHandshake(
	proxySocket: Socket,
	promise: ReturnType<typeof SocksClient.createConnection>,
	signal: AbortSignal | undefined,
	deadline: Deadline,
	sanitizeFailure: (error: Error) => Error,
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
						: failedError(
								sanitizeFailure(error instanceof Error ? error : new Error(String(error))),
							),
				),
		);
	});
}

async function connectSocksTunnel(
	proxy: NativeGatewayProxy,
	input: NativeNetworkConnectInput,
	deadline: Deadline,
	beforeDestinationConnect: () => void,
): Promise<Socket> {
	const parsed = parseSocks5Proxy(proxy.url);
	const proxySocket = await connectPlainSocket(parsed.host, parsed.port, input.signal, deadline);
	// `socks` removes its internal listeners as the handshake settles. Keep a
	// credential-free sink on the owned socket so an abort/close race cannot emit
	// an unhandled late network error between library cleanup and our wrapper.
	proxySocket.on("error", () => undefined);
	const remaining = remainingMs(deadline);
	try {
		beforeDestinationConnect();
	} catch (error) {
		proxySocket.destroy();
		throw error;
	}
	const handshake = SocksClient.createConnection({
		command: "connect",
		destination: { host: input.host, port: input.port },
		proxy: { type: 5, ...parsed },
		existing_socket: proxySocket,
		...(remaining === undefined ? {} : { timeout: Math.max(1, remaining) }),
	});
	return await waitForSocksHandshake(proxySocket, handshake, input.signal, deadline, (error) =>
		sanitizeProxyFailureCause(error, proxy.url, parsed),
	);
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
		idleTimer = setTimeout(
			() => {
				idleTimer = undefined;
				if (socket.readableEnded || socket.destroyed) return;
				closeReason = new NativeIdleTimeoutError();
				socket.destroy(closeReason);
			},
			Math.max(0, idleTimeoutMs),
		);
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
		if (terminalError) throw failedError(terminalError);
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
					if (error) reject(failedError(error));
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

type NativeConnectTls = "required" | "disabled";

type StoredEgressGrant = {
	readonly ruleIndex: number;
	readonly host: string;
	readonly port: number;
	readonly tls: NativeTcpTlsMode;
	readonly expiresAtMs?: number;
	revoked: boolean;
};

export const NATIVE_EGRESS_EXPIRED_EVIDENCE_LIMIT = 256;

function normalizeEgressHost(host: string): string {
	return host.trim().toLowerCase().replace(/\.$/, "");
}

function invalidPolicy(message: string): NativeNetworkError {
	return new NativeNetworkError(message, "native_egress_policy_invalid");
}

function matchesDnsSuffix(host: string, suffix: string): boolean {
	return host === suffix || host.endsWith(`.${suffix}`);
}

function matchesSourceHost(rule: DynamicEgressRuleSnapshot, host: string): boolean {
	const hasSelector = rule.sourceHost !== undefined || rule.sourceHostSuffixes.length > 0;
	if (!hasSelector) return false;
	return (
		host === rule.sourceHost ||
		rule.sourceHostSuffixes.some((suffix) => matchesDnsSuffix(host, suffix))
	);
}

function matchesPortSelectors(
	port: number,
	ports: readonly number[],
	ranges: readonly NativeTcpPortRange[],
): boolean {
	if (ports.length === 0 && ranges.length === 0) return false;
	return ports.includes(port) || ranges.some(({ start, end }) => port >= start && port <= end);
}

function tlsModeAllows(mode: NativeTcpTlsMode, requested: NativeConnectTls): boolean {
	return mode === "allowed" || mode === requested;
}

function grantTlsFitsRule(grant: NativeTcpTlsMode, rule: NativeTcpTlsMode): boolean {
	return (
		rule === "allowed" ||
		(grant === "required" && rule === "required") ||
		(grant === "disabled" && rule === "disabled")
	);
}

function matchesDynamicRuleSelectors(
	rule: DynamicEgressRuleSnapshot,
	input: NativeNetworkDynamicGrantOptions,
): boolean {
	const sourceHost = normalizeEgressHost(input.sourceHost);
	const targetHost = normalizeEgressHost(input.host);
	return (
		matchesSourceHost(rule, sourceHost) &&
		matchesPortSelectors(input.sourcePort, rule.sourcePorts, rule.sourcePortRanges) &&
		rule.targetHostSuffixes.some((suffix) => matchesDnsSuffix(targetHost, suffix)) &&
		matchesPortSelectors(input.port, rule.targetPorts, rule.targetPortRanges) &&
		grantTlsFitsRule(input.tls, rule.tls)
	);
}

function invalidGrant(message: string): NativeNetworkError {
	return new NativeNetworkError(message, "native_egress_grant_invalid");
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code <= 31 || code === 127) return true;
	}
	return false;
}

function assertValidGrantInput(input: NativeNetworkDynamicGrantOptions): void {
	if (
		!normalizeEgressHost(input.sourceHost) ||
		!normalizeEgressHost(input.host) ||
		hasControlCharacter(input.sourceHost) ||
		hasControlCharacter(input.host) ||
		/\s/.test(input.sourceHost) ||
		/\s/.test(input.host) ||
		input.sourceHost.includes("://") ||
		input.host.includes("://") ||
		input.sourceHost.includes("*") ||
		input.host.includes("*")
	)
		throw invalidGrant("Native TCP egress grant hosts must be exact non-empty hostnames");
	if (
		!Number.isSafeInteger(input.sourcePort) ||
		input.sourcePort < 1 ||
		input.sourcePort > 65_535 ||
		!Number.isSafeInteger(input.port) ||
		input.port < 1 ||
		input.port > 65_535
	)
		throw invalidGrant("Native TCP egress grant ports must be integers from 1 to 65535");
	if (input.tls !== "required" && input.tls !== "allowed" && input.tls !== "disabled")
		throw invalidGrant("Native TCP egress grant tls must be required, allowed, or disabled");
	if (input.ttlMs !== undefined && (!Number.isSafeInteger(input.ttlMs) || input.ttlMs <= 0))
		throw invalidGrant("Native TCP egress grant ttlMs must be a positive integer");
}

/** Internal canonical snapshot shared by production and SDK transport test doubles. */
export function snapshotNativeConnectInput(
	input: NativeNetworkConnectInput,
): NativeNetworkConnectInput {
	try {
		const host = input.host;
		const port = input.port;
		const serverName = input.serverName;
		const rejectUnauthorized = input.rejectUnauthorized;
		const idleTimeoutMs = input.idleTimeoutMs;
		const timeoutMs = input.timeoutMs;
		const signal = input.signal;
		const affinityKey = input.affinityKey;
		const snapshot: NativeNetworkConnectInput = {
			host,
			port,
			...(serverName === undefined ? {} : { serverName }),
			...(rejectUnauthorized === undefined ? {} : { rejectUnauthorized }),
			...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
			...(timeoutMs === undefined ? {} : { timeoutMs }),
			...(signal === undefined ? {} : { signal }),
			...(affinityKey === undefined ? {} : { affinityKey }),
		};
		if (
			typeof snapshot.host !== "string" ||
			!snapshot.host.trim() ||
			hasControlCharacter(snapshot.host) ||
			!Number.isInteger(snapshot.port) ||
			snapshot.port < 1 ||
			snapshot.port > 65_535
		)
			throw new TypeError("invalid native connection target");
		return snapshot;
	} catch {
		throw new NativeNetworkError(
			"Native connection input could not be inspected safely",
			"native_egress_input_invalid",
		);
	}
}

/** Internal canonical snapshot shared by production and SDK transport test doubles. */
export function snapshotNativeGrantInput(
	input: NativeNetworkDynamicGrantOptions,
): NativeNetworkDynamicGrantOptions {
	try {
		const sourceHost = input.sourceHost;
		const sourcePort = input.sourcePort;
		const host = input.host;
		const port = input.port;
		const tls = input.tls;
		const ttlMs = input.ttlMs;
		return {
			sourceHost,
			sourcePort,
			host,
			port,
			tls,
			...(ttlMs === undefined ? {} : { ttlMs }),
		};
	} catch {
		throw new NativeNetworkError(
			"Native TCP egress grant input could not be inspected safely",
			"native_egress_input_invalid",
		);
	}
}

/** Internal authorization seam shared by production and SDK transport test doubles. */
export function createNativeEgressAuthorization(options: NativeNetworkClientOptions): {
	assertConnect(input: NativeNetworkConnectInput, tls: NativeConnectTls): void;
	grant(input: NativeNetworkDynamicGrantOptions): NativeNetworkEgressGrant;
} {
	let declared: boolean;
	let staticRules: readonly StaticEgressRuleSnapshot[];
	let dynamicRules: readonly DynamicEgressRuleSnapshot[];
	let delegate: NativeNetworkClientOptions["grantTcpEgress"];
	try {
		const policy = options.egress;
		delegate = options.grantTcpEgress;
		if (delegate !== undefined && typeof delegate !== "function")
			throw invalidPolicy("Native egress delegate must be a function");
		declared = policy !== undefined;
		const snapshot = declared
			? parseNativeEgressPolicy(policy)
			: { staticRules: [], dynamicRules: [] };
		staticRules = snapshot.staticRules;
		dynamicRules = snapshot.dynamicRules;
	} catch (error) {
		if (error instanceof NativeNetworkError) throw error;
		if (error instanceof NativeEgressPolicyValidationError) throw invalidPolicy(error.message);
		throw invalidPolicy("Native egress policy could not be inspected safely");
	}
	const grants: StoredEgressGrant[] = [];
	const expiredEvidence = new Map<string, StoredEgressGrant>();
	const grantKey = (grant: Pick<StoredEgressGrant, "host" | "port" | "tls">): string =>
		`${grant.host}\0${grant.port}\0${grant.tls}`;
	const recordExpired = (grant: StoredEgressGrant): void => {
		const key = grantKey(grant);
		expiredEvidence.delete(key);
		expiredEvidence.set(key, grant);
		while (expiredEvidence.size > NATIVE_EGRESS_EXPIRED_EVIDENCE_LIMIT) {
			const oldest = expiredEvidence.keys().next().value;
			if (typeof oldest !== "string") break;
			expiredEvidence.delete(oldest);
		}
	};
	const purgeInactive = (now: number): void => {
		const live: StoredEgressGrant[] = [];
		for (const grant of grants) {
			if (grant.revoked) continue;
			if (grant.expiresAtMs !== undefined && now >= grant.expiresAtMs) {
				recordExpired(grant);
				continue;
			}
			live.push(grant);
		}
		grants.length = 0;
		grants.push(...live);
	};

	const assertConnect = (input: NativeNetworkConnectInput, tls: NativeConnectTls): void => {
		if (!declared) return;
		const host = normalizeEgressHost(input.host);
		const now = Date.now();
		purgeInactive(now);
		if (
			staticRules.some(
				(rule) =>
					rule.host === host && rule.ports.includes(input.port) && tlsModeAllows(rule.tls, tls),
			)
		)
			return;
		const matching = grants.filter(
			(grant) =>
				!grant.revoked &&
				grant.host === host &&
				grant.port === input.port &&
				tlsModeAllows(grant.tls, tls),
		);
		if (matching.length > 0) return;
		const expired = [...expiredEvidence.values()]
			.filter(
				(grant) =>
					grant.host === host && grant.port === input.port && tlsModeAllows(grant.tls, tls),
			)
			.sort((left, right) => (right.expiresAtMs ?? 0) - (left.expiresAtMs ?? 0))[0];
		if (expired?.expiresAtMs !== undefined)
			throw new NativeEgressGrantExpiredError(
				input.host,
				input.port,
				tls,
				new Date(expired.expiresAtMs).toISOString(),
			);
		throw new NativeEgressNotDeclaredError(input.host, input.port, tls);
	};

	const grantLocal = (input: NativeNetworkDynamicGrantOptions): NativeNetworkEgressGrant => {
		assertValidGrantInput(input);
		const ruleIndex = dynamicRules.findIndex((rule) => matchesDynamicRuleSelectors(rule, input));
		if (ruleIndex < 0)
			throw new NativeNetworkError(
				`Native TCP egress grant is not declared for ${input.host}:${input.port} (${input.tls})`,
				"native_egress_not_declared",
			);
		const rule = dynamicRules[ruleIndex];
		if (!rule) throw invalidGrant("Native TCP egress declaration is missing its matched rule");
		if (input.ttlMs !== undefined && rule.ttlMs !== undefined && input.ttlMs > rule.ttlMs)
			throw invalidGrant(
				`Native TCP egress grant ttlMs ${input.ttlMs} exceeds declared maximum ${rule.ttlMs}`,
			);
		const now = Date.now();
		const targetHost = normalizeEgressHost(input.host);
		purgeInactive(now);
		const activeForRule = grants.filter(
			(grant) =>
				grant.ruleIndex === ruleIndex &&
				!grant.revoked &&
				(grant.expiresAtMs === undefined || now < grant.expiresAtMs),
		).length;
		if (rule.maxGrants !== undefined && activeForRule >= rule.maxGrants)
			throw new NativeNetworkError(
				`Native TCP egress grant limit exceeded for declaration ${ruleIndex}`,
				"native_egress_grant_limit_exceeded",
			);
		const ttlMs = input.ttlMs ?? rule.ttlMs;
		const expiresAtMs = ttlMs === undefined ? undefined : now + ttlMs;
		if (expiresAtMs !== undefined && (!Number.isFinite(expiresAtMs) || expiresAtMs > 8.64e15))
			throw invalidGrant("Native TCP egress grant expiry exceeds the supported date range");
		const stored: StoredEgressGrant = {
			ruleIndex,
			host: targetHost,
			port: input.port,
			tls: input.tls,
			...(expiresAtMs === undefined ? {} : { expiresAtMs }),
			revoked: false,
		};
		expiredEvidence.delete(grantKey(stored));
		grants.push(stored);
		return {
			revoke() {
				stored.revoked = true;
			},
		};
	};

	return {
		assertConnect,
		grant(input) {
			if (!declared) {
				if (delegate) {
					try {
						const delegated = delegate(input);
						if (!delegated || typeof delegated.revoke !== "function")
							throw new TypeError("Native egress delegate returned an invalid grant");
						return delegated;
					} catch (error) {
						if (error instanceof NativeNetworkError) throw error;
						throw new NativeNetworkError(
							"Deployment native egress authorization failed",
							"native_egress_authorization_failed",
						);
					}
				}
				throw new NativeNetworkError(
					"Dynamic native egress authorization is not configured",
					"native_dynamic_egress_unsupported",
				);
			}
			const local = grantLocal(input);
			let delegated: NativeNetworkEgressGrant | undefined;
			try {
				delegated = delegate?.(Object.freeze({ ...input }));
				if (delegated !== undefined && typeof delegated.revoke !== "function")
					throw new TypeError("Native egress delegate returned an invalid grant");
			} catch (error) {
				local.revoke();
				if (error instanceof NativeNetworkError) throw error;
				throw new NativeNetworkError(
					"Deployment native egress authorization failed",
					"native_egress_authorization_failed",
				);
			}
			let revoked = false;
			return {
				revoke() {
					if (revoked) return;
					revoked = true;
					local.revoke();
					try {
						delegated?.revoke();
					} catch (error) {
						if (error instanceof NativeNetworkError) throw error;
						throw new NativeNetworkError(
							"Deployment native egress grant revocation failed",
							"native_egress_authorization_failed",
						);
					}
				},
			};
		},
	};
}

/** Create the SDK byte-stream runtime with provider-declared egress enforcement. */
export function createNativeNetworkClient(
	options: NativeNetworkClientOptions = {},
): NativeNetworkClient {
	const egress = createNativeEgressAuthorization(options);
	return {
		connectTcp: async (input) => {
			const request = snapshotNativeConnectInput(input);
			egress.assertConnect(request, "disabled");
			const deadline = deadlineFrom(request.timeoutMs);
			assertCanStart(request.signal, deadline);
			const proxy = await resolveConnectionProxy(options, request);
			egress.assertConnect(request, "disabled");
			const socket = proxy
				? await connectSocksTunnel(proxy, request, deadline, () =>
						egress.assertConnect(request, "disabled"),
					)
				: await connectPlainSocket(request.host, request.port, request.signal, deadline);
			return createNativeNetworkConnection(socket, proxy, options, request.idleTimeoutMs);
		},
		connectTls: async (input) => {
			const request = snapshotNativeConnectInput(input);
			egress.assertConnect(request, "required");
			const deadline = deadlineFrom(request.timeoutMs);
			assertCanStart(request.signal, deadline);
			const proxy = await resolveConnectionProxy(options, request);
			egress.assertConnect(request, "required");
			const tunnel = proxy
				? await connectSocksTunnel(proxy, request, deadline, () =>
						egress.assertConnect(request, "required"),
					)
				: undefined;
			const socket = await upgradeTls(tunnel, request, deadline);
			return createNativeNetworkConnection(socket, proxy, options, request.idleTimeoutMs);
		},
		grantTcpEgress: (input) => egress.grant(snapshotNativeGrantInput(input)),
	};
}
