import { ConfigurationError, decodeMasterKey } from "./key-derivation.js";

export interface KeyRingOptions {
	env: NodeJS.ProcessEnv;
	envPrefix?: string;
	acceptListVar?: string;
	writerVersionVar?: string;
}

export interface KeyRingEntry {
	version: number;
	key: Buffer;
}

export interface KeyRing {
	accept(version: number): KeyRingEntry;
	activeWriter(): KeyRingEntry;
	versions(): number[];
	purgeVersion(version: number, isActiveInStore: (v: number) => Promise<boolean>): Promise<void>;
}

const DEFAULT_KEY_PREFIX = "APIFUSE__KEYRING__MASTER_KEY_V";
const DEFAULT_ACCEPT_LIST_VAR = "APIFUSE__KEYRING__MASTER_KEY_ACCEPT_LIST";
const DEFAULT_WRITER_VERSION_VAR = "APIFUSE__KEYRING__MASTER_KEY_WRITER_VERSION";

function parseAcceptList(raw: string | undefined): number[] {
	if (!raw || raw.trim().length === 0) {
		throw new ConfigurationError(
			`accept-list env var is empty; expected comma-separated master key versions`,
		);
	}

	const parts = raw
		.split(",")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
	const versions: number[] = [];
	for (const part of parts) {
		const v = Number.parseInt(part, 10);
		if (!Number.isInteger(v) || v <= 0 || String(v) !== part) {
			throw new ConfigurationError(
				`accept-list contains invalid version "${part}"; expected positive integers`,
			);
		}
		versions.push(v);
	}

	if (versions.length === 0) {
		throw new ConfigurationError("accept-list is empty after parsing");
	}

	return versions;
}

function parseWriterVersion(raw: string | undefined, acceptList: number[]): number {
	if (!raw || raw.trim().length === 0) {
		throw new ConfigurationError("writer-version env var is empty");
	}
	const trimmed = raw.trim();
	const v = Number.parseInt(trimmed, 10);
	if (!Number.isInteger(v) || v <= 0 || String(v) !== trimmed) {
		throw new ConfigurationError(`writer-version "${trimmed}" is not a positive integer`);
	}
	if (!acceptList.includes(v)) {
		throw new ConfigurationError(
			`writer-version ${v} is not in the accept-list [${acceptList.join(", ")}]`,
		);
	}
	return v;
}

/**
 * @internal Trusted loaders only; not re-exported to provider-importable paths.
 *
 * Loads master keys from the external-secret-manager-injected env (one entry per
 * accepted version). Caller must keep the resulting {@link KeyRing} alive for the
 * process lifetime; rotation requires a restart (or an explicit reload utility
 * added later).
 */
export function loadKeyRing(options: KeyRingOptions): KeyRing {
	const env = options.env;
	const prefix = options.envPrefix ?? DEFAULT_KEY_PREFIX;
	const acceptListVar = options.acceptListVar ?? DEFAULT_ACCEPT_LIST_VAR;
	const writerVersionVar = options.writerVersionVar ?? DEFAULT_WRITER_VERSION_VAR;

	const acceptList = parseAcceptList(env[acceptListVar]);
	const writerVersion = parseWriterVersion(env[writerVersionVar], acceptList);

	const entries = new Map<number, KeyRingEntry>();
	for (const version of acceptList) {
		const raw = env[`${prefix}${version}`];
		if (raw === undefined) {
			throw new ConfigurationError(`${prefix}${version} is missing (listed in accept-list)`);
		}
		const key = decodeMasterKey(raw);
		entries.set(version, { version, key });
	}

	return {
		accept(version) {
			const entry = entries.get(version);
			if (!entry) {
				throw new ConfigurationError(
					`version ${version} is not accepted; accept-list is [${acceptList.join(", ")}]`,
				);
			}
			return entry;
		},

		activeWriter() {
			const entry = entries.get(writerVersion);
			if (!entry) {
				throw new ConfigurationError(
					`writer version ${writerVersion} is missing from accept-list entries`,
				);
			}
			return entry;
		},

		versions() {
			return [...acceptList];
		},

		async purgeVersion(version, isActiveInStore) {
			if (!entries.has(version)) {
				return;
			}
			const active = await isActiveInStore(version);
			if (active) {
				throw new ConfigurationError(
					`cannot purge master-key version ${version}: active connection rows still reference it`,
				);
			}
			entries.delete(version);
		},
	};
}
