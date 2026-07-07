import type { Buffer } from "node:buffer";
import net from "node:net";
import tls from "node:tls";
import { TransportError } from "../errors";
import type {
	NativeNetworkClient,
	NativeNetworkConnectOptions,
	NativeNetworkConnection,
	NativeTcpEgressRule,
	NativeTlsConnectOptions,
} from "../types";

type SocketLike = net.Socket | tls.TLSSocket;
type ConnectKind = "tcp" | "tls";

function normalizeHost(host: string): string {
	return host.trim().toLowerCase();
}

function assertDeclaredEgress(
	rules: readonly NativeTcpEgressRule[],
	kind: ConnectKind,
	host: string,
	port: number,
): void {
	const normalizedHost = normalizeHost(host);
	const matchingRule = rules.find(
		(rule) => normalizeHost(rule.host) === normalizedHost && rule.ports.includes(port),
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
): NativeNetworkClient {
	return {
		async connectTcp(options: NativeNetworkConnectOptions) {
			assertDeclaredEgress(rules, "tcp", options.host, options.port);
			return createConnection(await connectSocket("tcp", options));
		},
		async connectTls(options: NativeTlsConnectOptions) {
			assertDeclaredEgress(rules, "tls", options.host, options.port);
			return createConnection(await connectSocket("tls", options));
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
	};
}
