import type { Buffer } from "node:buffer";
import net from "node:net";
import tls from "node:tls";
import { TransportError } from "../errors";
import type {
	NativeNetworkClient,
	NativeNetworkConnectOptions,
	NativeNetworkConnection,
	NativeNetworkDynamicGrantOptions,
	NativeTcpDynamicEgressRule,
	NativeTcpEgressRule,
	NativeTcpTlsMode,
	NativeTlsConnectOptions,
} from "../types";

type SocketLike = net.Socket | tls.TLSSocket;
type ConnectKind = "tcp" | "tls";

type NativeTcpEffectiveRule = NativeTcpEgressRule & {
	expiresAt?: number;
	revoke?: () => void;
};

const DEFAULT_DYNAMIC_GRANT_TTL_MS = 60_000;
const DEFAULT_DYNAMIC_GRANT_MAX_GRANTS = 16;

function normalizeHost(host: string): string {
	return host.trim().toLowerCase();
}

function hostMatchesSuffix(host: string, suffix: string): boolean {
	const normalizedHost = normalizeHost(host);
	const normalizedSuffix = normalizeHost(suffix).replace(/^\.+/, "");
	return normalizedHost === normalizedSuffix || normalizedHost.endsWith(`.${normalizedSuffix}`);
}

function portInRange(port: number, range: { start: number; end: number }): boolean {
	return port >= range.start && port <= range.end;
}

function tlsModeAllows(ruleMode: NativeTcpTlsMode, requestedMode: NativeTcpTlsMode): boolean {
	return ruleMode === requestedMode || ruleMode === "allowed";
}

function assertDeclaredEgress(
	rules: readonly NativeTcpEffectiveRule[],
	kind: ConnectKind,
	host: string,
	port: number,
): void {
	const now = Date.now();
	const normalizedHost = normalizeHost(host);
	const matchingRule = rules.find(
		(rule) =>
			(rule.expiresAt === undefined || rule.expiresAt > now) &&
			normalizeHost(rule.host) === normalizedHost &&
			rule.ports.includes(port),
	);

	if (!matchingRule) {
		throw new TransportError(
			`Native network egress to ${host}:${port} is not declared by provider.native.network.tcp.`,
			{ code: "native_network_egress_denied" },
		);
	}
	if (kind === "tcp" && matchingRule.tls === "required") {
		throw new TransportError(`Native TCP egress to ${host}:${port} requires TLS.`, {
			code: "native_network_tls_required",
		});
	}
	if (kind === "tls" && matchingRule.tls === "disabled") {
		throw new TransportError(
			`Native TLS egress to ${host}:${port} is disabled by the provider declaration.`,
			{ code: "native_network_tls_disabled" },
		);
	}
}

function findDynamicGrantRule(
	rules: readonly NativeTcpDynamicEgressRule[],
	grant: NativeNetworkDynamicGrantOptions,
): NativeTcpDynamicEgressRule | undefined {
	return rules.find(
		(rule) =>
			normalizeHost(rule.sourceHost) === normalizeHost(grant.sourceHost) &&
			rule.sourcePorts.includes(grant.sourcePort) &&
			rule.targetHostSuffixes.some((suffix) => hostMatchesSuffix(grant.host, suffix)) &&
			(rule.targetPorts?.includes(grant.port) === true ||
				rule.targetPortRanges?.some((range) => portInRange(grant.port, range)) === true) &&
			tlsModeAllows(rule.tls, grant.tls),
	);
}

function toNativeNetworkError(error: unknown, timeout = false): TransportError {
	if (error instanceof TransportError) return error;
	if (error instanceof Error) {
		return new TransportError(timeout ? "Native network connection timed out" : error.message, {
			code: timeout ? "native_network_timeout" : "native_network_transport_error",
			cause: error,
		});
	}
	return new TransportError("Native network transport error", {
		code: "native_network_transport_error",
	});
}

function abortError(): TransportError {
	return new TransportError("Native network connection aborted", {
		code: "native_network_aborted",
	});
}

function createConnection(socket: SocketLike): NativeNetworkConnection {
	const queue: Uint8Array[] = [];
	const waiters: Array<(chunk: Uint8Array | null) => void> = [];
	let closed = false;
	let terminalError: Error | undefined;

	const resolveNext = (chunk: Uint8Array | null) => {
		const waiter = waiters.shift();
		if (waiter) {
			waiter(chunk);
			return true;
		}
		return false;
	};

	socket.on("data", (chunk: Buffer) => {
		const copy = new Uint8Array(chunk.byteLength);
		copy.set(chunk);
		if (!resolveNext(copy)) queue.push(copy);
	});
	socket.on("end", () => {
		closed = true;
		while (resolveNext(null)) {}
	});
	socket.on("close", () => {
		closed = true;
		while (resolveNext(null)) {}
	});
	socket.on("error", (error) => {
		terminalError = error;
		closed = true;
		while (resolveNext(null)) {}
	});

	const connection: NativeNetworkConnection = {
		async write(data) {
			if (closed || socket.destroyed) {
				throw new TransportError("Native network connection is closed", {
					code: "native_network_connection_closed",
				});
			}
			await new Promise<void>((resolve, reject) => {
				socket.write(data, (error) => {
					if (error) reject(toNativeNetworkError(error));
					else resolve();
				});
			});
		},
		async read() {
			const queued = queue.shift();
			if (queued) return queued;
			if (terminalError) throw toNativeNetworkError(terminalError);
			if (closed) return null;
			const chunk = await new Promise<Uint8Array | null>((resolve) => {
				waiters.push(resolve);
			});
			if (chunk === null && terminalError) {
				throw toNativeNetworkError(terminalError);
			}
			return chunk;
		},
		chunks() {
			return connection;
		},
		async close() {
			if (socket.destroyed) return;
			await new Promise<void>((resolve) => {
				socket.end(() => resolve());
				setTimeout(() => {
					if (!socket.destroyed) socket.destroy();
					resolve();
				}, 250).unref?.();
			});
		},
		async *[Symbol.asyncIterator]() {
			while (true) {
				const chunk = await connection.read();
				if (chunk === null) return;
				yield chunk;
			}
		},
	};

	return connection;
}

async function connectSocket(
	kind: ConnectKind,
	options: NativeTlsConnectOptions,
): Promise<SocketLike> {
	return await new Promise<SocketLike>((resolve, reject) => {
		let settled = false;
		let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
		let socket: SocketLike;

		const cleanup = () => {
			if (timeoutHandle) clearTimeout(timeoutHandle);
			options.signal?.removeEventListener("abort", onAbort);
			socket.off("error", onError);
		};
		const settle = (fn: () => void) => {
			if (settled) return;
			settled = true;
			cleanup();
			fn();
		};
		const onError = (error: Error) => {
			settle(() => reject(toNativeNetworkError(error)));
		};
		const onAbort = () => {
			socket.destroy();
			settle(() => reject(abortError()));
		};

		if (options.signal?.aborted) {
			reject(abortError());
			return;
		}

		const onConnect = () => settle(() => resolve(socket));
		socket =
			kind === "tls"
				? tls.connect(
						{
							host: options.host,
							port: options.port,
							servername: options.serverName ?? options.host,
							rejectUnauthorized: options.rejectUnauthorized,
						},
						onConnect,
					)
				: net.connect({ host: options.host, port: options.port }, onConnect);

		socket.once("error", onError);
		options.signal?.addEventListener("abort", onAbort, { once: true });
		if (options.timeoutMs !== undefined) {
			timeoutHandle = setTimeout(() => {
				socket.destroy();
				settle(() => reject(toNativeNetworkError(undefined, true)));
			}, options.timeoutMs);
		}
	});
}

export function createNativeNetworkClient(
	rules: readonly NativeTcpEgressRule[] = [],
	dynamicRules: readonly NativeTcpDynamicEgressRule[] = [],
): NativeNetworkClient {
	const staticRules = [...rules];
	const dynamicGrants: NativeTcpEffectiveRule[] = [];
	const pruneExpired = () => {
		const now = Date.now();
		for (let index = dynamicGrants.length - 1; index >= 0; index -= 1) {
			const grant = dynamicGrants[index];
			if (grant?.expiresAt !== undefined && grant.expiresAt <= now) {
				dynamicGrants.splice(index, 1);
			}
		}
	};
	const effectiveRules = () => {
		pruneExpired();
		return [...staticRules, ...dynamicGrants];
	};

	return {
		async connectTcp(options: NativeNetworkConnectOptions) {
			assertDeclaredEgress(effectiveRules(), "tcp", options.host, options.port);
			return createConnection(await connectSocket("tcp", options));
		},
		async connectTls(options: NativeTlsConnectOptions) {
			assertDeclaredEgress(effectiveRules(), "tls", options.host, options.port);
			return createConnection(await connectSocket("tls", options));
		},
		grantTcpEgress(options: NativeNetworkDynamicGrantOptions) {
			const rule = findDynamicGrantRule(dynamicRules, options);
			if (!rule) {
				throw new TransportError(
					`Native dynamic TCP egress grant to ${options.host}:${options.port} is not declared by provider.native.network.dynamicTcp.`,
					{ code: "native_network_dynamic_egress_denied" },
				);
			}

			pruneExpired();
			const maxGrants = rule.maxGrants ?? DEFAULT_DYNAMIC_GRANT_MAX_GRANTS;
			if (dynamicGrants.length >= maxGrants) {
				throw new TransportError("Native dynamic TCP egress grant limit exceeded.", {
					code: "native_network_dynamic_egress_limit_exceeded",
				});
			}

			const ttlMs = options.ttlMs ?? rule.ttlMs ?? DEFAULT_DYNAMIC_GRANT_TTL_MS;
			const grant: NativeTcpEffectiveRule = {
				host: options.host,
				ports: [options.port],
				tls: options.tls,
				expiresAt: Date.now() + ttlMs,
			};
			grant.revoke = () => {
				const index = dynamicGrants.indexOf(grant);
				if (index >= 0) dynamicGrants.splice(index, 1);
			};
			dynamicGrants.push(grant);
			return { revoke: grant.revoke };
		},
	};
}

export function createUnsupportedNativeNetworkClient(
	message = "Native network runtime is not available",
): NativeNetworkClient {
	const unsupported = async (): Promise<NativeNetworkConnection> => {
		throw new TransportError(message, {
			code: "native_network_unsupported",
		});
	};
	return {
		connectTcp: unsupported,
		connectTls: unsupported,
		grantTcpEgress() {
			throw new TransportError(message, {
				code: "native_network_unsupported",
			});
		},
	};
}
