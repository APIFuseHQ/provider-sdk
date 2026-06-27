import Redis from "ioredis";

export type ProviderRedisClient = Redis;

export type ProviderRedisClientOptions = {
	readonly redisUrl: string;
	readonly timeoutMs: number;
	readonly onError: () => void;
};

type RedisTimeoutOptions<T> = {
	readonly timeoutMs: number;
	readonly onTimeout: () => T;
	readonly onError?: (error: unknown) => T;
};

export function createProviderRedisClient(
	options: ProviderRedisClientOptions,
): ProviderRedisClient {
	const redis = new Redis(options.redisUrl, {
		connectTimeout: options.timeoutMs,
		enableOfflineQueue: false,
		lazyConnect: true,
		maxRetriesPerRequest: 0,
		retryStrategy: () => null,
	});
	redis.on("error", options.onError);
	return redis;
}

export async function withRedisTimeout<T>(
	operation: () => Promise<T>,
	options: RedisTimeoutOptions<T>,
): Promise<T> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	try {
		const timeout = new Promise<T>((resolve, reject) => {
			timeoutId = setTimeout(() => {
				try {
					resolve(options.onTimeout());
				} catch (error) {
					reject(error);
				}
			}, options.timeoutMs);
		});
		const operationResult = options.onError
			? operation().catch(options.onError)
			: operation();
		return await Promise.race([operationResult, timeout]);
	} finally {
		if (timeoutId) clearTimeout(timeoutId);
	}
}

export function redisStatus(redis: ProviderRedisClient): string {
	return redis.status;
}

async function waitForRedisReady(
	redis: ProviderRedisClient,
	timeoutMs: number,
): Promise<boolean> {
	let timeoutId: ReturnType<typeof setTimeout> | undefined;
	let settled = false;

	return await new Promise<boolean>((resolve) => {
		const cleanup = () => {
			if (timeoutId) clearTimeout(timeoutId);
			redis.off("ready", onReady);
			redis.off("close", onUnavailable);
			redis.off("end", onUnavailable);
			redis.off("error", onUnavailable);
		};
		const finish = (ready: boolean) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(ready);
		};
		const onReady = () => finish(true);
		const onUnavailable = () => finish(false);

		timeoutId = setTimeout(
			() => finish(redisStatus(redis) === "ready"),
			timeoutMs,
		);
		redis.once("ready", onReady);
		redis.once("close", onUnavailable);
		redis.once("end", onUnavailable);
		redis.once("error", onUnavailable);
	});
}

export async function ensureRedisReady(
	redis: ProviderRedisClient,
	timeoutMs: number,
): Promise<boolean> {
	if (redisStatus(redis) === "ready") return true;

	if (redisStatus(redis) === "wait" || redisStatus(redis) === "end") {
		const connected = await withRedisTimeout(
			async () => {
				await redis.connect();
				return true;
			},
			{
				timeoutMs,
				onTimeout: () => false,
				onError: () => false,
			},
		);
		return connected && redisStatus(redis) === "ready";
	}

	return await waitForRedisReady(redis, timeoutMs);
}
