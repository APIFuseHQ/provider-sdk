import { describe, expect, it } from "bun:test";

import type {
	NativeNetworkClient,
	NativeNetworkConnection,
	NativeNetworkConnectInput,
	NativeProviderConfig,
	NativeProviderContext,
	NativeTcpEgressGrant,
	ProviderContext,
	ProviderFileRef,
	ProviderFilesContext,
	ProviderResolvedFile,
} from "@apifuse/provider-sdk";
import type {
	NativeNetworkClient as ProviderEntryNativeNetworkClient,
	ProviderFilesContext as ProviderEntryFilesContext,
} from "@apifuse/provider-sdk/provider";

// Consumer contract fixture copied from apifuse-provider-kakaotalk@174df59.
// Keep these declarations independent from the SDK types: the assignments
// below prove the bridge can be replaced by public package imports.
type KakaoProviderFileRef = {
	readonly type: "request_file";
	readonly id: string;
	readonly filename: string;
	readonly mime_type?: string;
	readonly size: number;
	readonly sha256?: string;
};

type KakaoProviderResolvedFile = Omit<KakaoProviderFileRef, "mime_type"> & {
	readonly mimeType?: string;
	arrayBuffer(): Promise<ArrayBuffer>;
	bytes(): Promise<Uint8Array>;
	stream(): ReadableStream<Uint8Array>;
};

interface KakaoProviderFilesContext {
	has(input: string | KakaoProviderFileRef): boolean;
	resolve(input: string | KakaoProviderFileRef): Promise<KakaoProviderResolvedFile>;
}

type KakaoNativeNetworkConnectInput = {
	readonly host: string;
	readonly port: number;
	readonly serverName?: string;
	readonly rejectUnauthorized?: boolean;
	readonly idleTimeoutMs?: number;
	readonly timeoutMs?: number;
};

interface KakaoNativeNetworkConnection {
	read(): Promise<Uint8Array | null>;
	write(data: Uint8Array): Promise<void>;
	close(): Promise<void>;
}

interface KakaoNativeTcpEgressGrant {
	revoke(): void;
}

interface KakaoNativeNetworkClient {
	connectTcp(input: KakaoNativeNetworkConnectInput): Promise<KakaoNativeNetworkConnection>;
	connectTls(input: KakaoNativeNetworkConnectInput): Promise<KakaoNativeNetworkConnection>;
	grantTcpEgress(input: unknown): KakaoNativeTcpEgressGrant;
}

type KakaoNativeProviderContext = {
	readonly network: KakaoNativeNetworkClient;
};

const bridgeFileRef: KakaoProviderFileRef = {
	type: "request_file",
	id: "photo",
	filename: "photo.jpg",
	mime_type: "image/jpeg",
	size: 4,
	sha256: "fixture-hash",
};

const bridgeResolvedFile: KakaoProviderResolvedFile = {
	type: "request_file",
	id: "photo",
	filename: "photo.jpg",
	mimeType: "image/jpeg",
	size: 4,
	sha256: "fixture-hash",
	async arrayBuffer() {
		return new ArrayBuffer(0);
	},
	async bytes() {
		return new Uint8Array();
	},
	stream() {
		return new ReadableStream<Uint8Array>();
	},
};

const bridgeFiles: KakaoProviderFilesContext = {
	has: () => true,
	resolve: async () => bridgeResolvedFile,
};

const bridgeConnection: KakaoNativeNetworkConnection = {
	read: async () => null,
	write: async () => {},
	close: async () => {},
};

const bridgeNetwork: KakaoNativeNetworkClient = {
	connectTcp: async () => bridgeConnection,
	connectTls: async () => bridgeConnection,
	grantTcpEgress: () => ({ revoke() {} }),
};

const bridgeNative: KakaoNativeProviderContext = {
	network: bridgeNetwork,
};

// Compile-only public-surface witnesses.
const publicFileRef: ProviderFileRef = bridgeFileRef;
const publicResolvedFile: ProviderResolvedFile = bridgeResolvedFile;
const publicFiles: ProviderFilesContext = bridgeFiles;
const providerEntryFiles: ProviderEntryFilesContext = bridgeFiles;
const publicConnection: NativeNetworkConnection = bridgeConnection;
const publicConnectInput: NativeNetworkConnectInput = {
	host: "booking-loco.kakao.com",
	port: 443,
	timeoutMs: 15_000,
	idleTimeoutMs: 60_000,
};
const publicGrant: NativeTcpEgressGrant = bridgeNetwork.grantTcpEgress({});
const publicNetwork: NativeNetworkClient = bridgeNetwork;
const providerEntryNetwork: ProviderEntryNativeNetworkClient = bridgeNetwork;
const publicNative: NativeProviderContext = bridgeNative;

const kakaoNativeDeclaration = {
	network: {
		tcp: [{ host: "booking-loco.kakao.com", ports: [443], tls: "required" }],
		dynamicTcp: [
			{
				sourceHostSuffixes: ["kakao.com"],
				sourcePortRanges: [{ start: 1, end: 65_535 }],
				targetHostSuffixes: ["kakao.com"],
				targetPortRanges: [{ start: 1, end: 65_535 }],
				tls: "disabled",
				ttlMs: 60_000,
				maxGrants: 16,
			},
		],
	},
} as const satisfies NativeProviderConfig;
const publicNativeDeclaration: NativeProviderConfig = kakaoNativeDeclaration;

function contextCapabilities(ctx: ProviderContext): {
	readonly files: ProviderFilesContext | undefined;
	readonly native: NativeProviderContext | undefined;
} {
	return { files: ctx.files, native: ctx.native };
}

describe("public native runtime contracts", () => {
	it("accepts the KakaoTalk bridge shapes from both core entrypoints", async () => {
		expect(publicConnectInput.idleTimeoutMs).toBe(60_000);
		expect(publicFileRef.mime_type).toBe("image/jpeg");
		expect((await publicResolvedFile.bytes()).byteLength).toBe(0);
		expect(publicFiles.has(publicFileRef)).toBe(true);
		expect(providerEntryFiles.has("photo")).toBe(true);
		await expect(publicConnection.read()).resolves.toBeNull();
		expect(typeof publicGrant.revoke).toBe("function");
		expect(publicNetwork).toBe(providerEntryNetwork);
		expect(publicNative.network).toBe(bridgeNetwork);
	});

	it("types the native declaration and optional runtime capabilities", () => {
		expect(publicNativeDeclaration.network?.tcp?.[0]?.host).toBe("booking-loco.kakao.com");
		expect(contextCapabilities({} as ProviderContext)).toEqual({
			files: undefined,
			native: undefined,
		});
	});
});
