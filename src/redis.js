import { randomUUID } from "node:crypto";

const DEFAULT_TIMEOUT_MS = 10_000;
const RELEASE_LOCK_SCRIPT =
  'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end';

export class RedisRestError extends Error {
  constructor(message, { status = null } = {}) {
    super(message);
    this.name = "RedisRestError";
    this.status = status;
  }
}

export class RedisRestClient {
  constructor({ url, token, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch }) {
    if (!url || !token) {
      throw new Error(
        "Upstash Redis credentials are missing. Connect an Upstash Redis store and set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN.",
      );
    }
    this.url = url.replace(/\/$/, "");
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.fetch = fetchImpl;
  }

  static fromEnv(env = process.env, options = {}) {
    return new RedisRestClient({
      url: env.UPSTASH_REDIS_REST_URL || env.KV_REST_API_URL,
      token: env.UPSTASH_REDIS_REST_TOKEN || env.KV_REST_API_TOKEN,
      ...options,
    });
  }

  async command(...parts) {
    let response;
    try {
      response = await this.fetch(this.url, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          "content-type": "application/json",
        },
        body: JSON.stringify(parts),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new RedisRestError(`Could not reach Upstash Redis: ${error.message}`);
    }

    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new RedisRestError("Upstash Redis returned an invalid response.", {
        status: response.status,
      });
    }
    if (!response.ok || payload.error) {
      throw new RedisRestError(
        `Upstash Redis command failed: ${payload.error || response.statusText}`,
        { status: response.status },
      );
    }
    return payload.result;
  }
}

export function redisKeyPrefix(env = process.env) {
  const environment = env.VERCEL_ENV || "default";
  const prefix = (env.IMPOSTOR_REDIS_PREFIX || `impostor:${environment}`).trim();
  if (!/^[A-Za-z0-9:_-]{1,80}$/.test(prefix)) {
    throw new Error(
      "IMPOSTOR_REDIS_PREFIX must contain only letters, numbers, colons, underscores, or hyphens.",
    );
  }
  return prefix;
}

export async function acquireRedisLease(
  client,
  key,
  { ttlMs = 180_000, token = randomUUID() } = {},
) {
  const result = await client.command("SET", key, token, "NX", "PX", String(ttlMs));
  return result === "OK" ? token : null;
}

export async function releaseRedisLease(client, key, token) {
  if (!token) return false;
  return (await client.command("EVAL", RELEASE_LOCK_SCRIPT, "1", key, token)) === 1;
}
