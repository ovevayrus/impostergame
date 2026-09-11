import assert from "node:assert/strict";
import test from "node:test";

import { createLobby } from "../src/game.js";
import { RedisStore } from "../src/redis-store.js";
import {
  acquireRedisLease,
  RedisRestClient,
  releaseRedisLease,
} from "../src/redis.js";
import { FakeRedis } from "../test-helpers/fake-redis.js";

const user = { id: 123, first_name: "Redis Tester", is_bot: false };

test("Redis storage persists sessions, offsets, and chat migrations", async () => {
  const redis = new FakeRedis();
  const first = new RedisStore(redis, "test:state");
  await first.init();

  const session = createLobby({
    chatId: -10,
    creator: user,
    idFactory: () => "redis_game_1",
  });
  await first.setSession(session);
  await first.setNextUpdateId(321);

  const second = new RedisStore(redis, "test:state");
  await second.init();
  assert.deepEqual(second.getSession(-10), session);
  assert.equal(second.getNextUpdateId(), 321);

  assert.equal(await second.migrateChat(-10, -10010), true);
  assert.equal(second.getSession(-10), null);
  assert.equal(second.getSession(-10010).chatId, -10010);
});

test("Redis leases are exclusive and can only be released by their owner", async () => {
  const redis = new FakeRedis();
  assert.equal(
    await acquireRedisLease(redis, "test:lock", { token: "first", ttlMs: 10_000 }),
    "first",
  );
  assert.equal(
    await acquireRedisLease(redis, "test:lock", { token: "second", ttlMs: 10_000 }),
    null,
  );
  assert.equal(await releaseRedisLease(redis, "test:lock", "second"), false);
  assert.equal(await releaseRedisLease(redis, "test:lock", "first"), true);
  assert.equal(
    await acquireRedisLease(redis, "test:lock", { token: "third", ttlMs: 10_000 }),
    "third",
  );
});

test("Redis REST client sends Upstash command arrays with bearer authentication", async () => {
  let captured;
  const client = new RedisRestClient({
    url: "https://example.upstash.io/",
    token: "test-token",
    fetchImpl: async (url, options) => {
      captured = { url, options };
      return Response.json({ result: "PONG" });
    },
  });

  assert.equal(await client.command("PING"), "PONG");
  assert.equal(captured.url, "https://example.upstash.io");
  assert.equal(captured.options.headers.authorization, "Bearer test-token");
  assert.deepEqual(JSON.parse(captured.options.body), ["PING"]);
});
