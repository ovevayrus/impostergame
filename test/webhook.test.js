import assert from "node:assert/strict";
import test from "node:test";

import { GET } from "../api/telegram.js";
import { createWebhookHandler } from "../src/webhook.js";
import { FakeRedis } from "../test-helpers/fake-redis.js";

const env = {
  TELEGRAM_WEBHOOK_SECRET: "unit-test-secret",
  IMPOSTOR_REDIS_PREFIX: "impostor:test",
};

class FakeTelegramApi {
  constructor() {
    this.calls = [];
    this.nextMessageId = 100;
  }

  async call(method, parameters) {
    this.calls.push({ method, parameters: structuredClone(parameters) });
    if (method === "sendMessage") return { message_id: this.nextMessageId++ };
    return true;
  }
}

function requestFor(update, secret = env.TELEGRAM_WEBHOOK_SECRET) {
  return new Request("https://bot.example/api/telegram", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-telegram-bot-api-secret-token": secret,
    },
    body: JSON.stringify(update),
  });
}

function newGameUpdate(updateId = 40) {
  return {
    update_id: updateId,
    message: {
      message_id: 50,
      text: "/newgame",
      from: { id: 11, first_name: "Ari", is_bot: false },
      chat: { id: -100, type: "supergroup" },
    },
  };
}

function testCore(api) {
  return {
    api,
    bot: { id: 999, username: "ImpostorTestBot" },
    config: {
      minPlayers: 3,
      maxPlayers: 12,
      autoSendRolesIfAdmin: false,
    },
    wordBank: [{ word: "Telescope", hint: "Galileo", category: "Object" }],
  };
}

const silentLogger = { error() {}, info() {}, warn() {} };

test("the Vercel route exposes a health response without loading secrets", async () => {
  const response = GET();
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    ok: true,
    service: "telegram-impostor-webhook",
  });
});

test("the webhook rejects requests without Telegram's configured secret", async () => {
  const redis = new FakeRedis();
  let coreLoads = 0;
  const handler = createWebhookHandler({
    env,
    redisClient: redis,
    coreLoader: async () => {
      coreLoads += 1;
      return testCore(new FakeTelegramApi());
    },
    logger: silentLogger,
  });

  const response = await handler(requestFor(newGameUpdate(), "wrong-secret"));
  assert.equal(response.status, 401);
  assert.equal(redis.calls.length, 0);
  assert.equal(coreLoads, 0);
});

test("the webhook persists a game and ignores a retried update", async () => {
  const redis = new FakeRedis();
  const api = new FakeTelegramApi();
  const handler = createWebhookHandler({
    env,
    redisClient: redis,
    coreLoader: async () => testCore(api),
    logger: silentLogger,
  });

  const first = await handler(requestFor(newGameUpdate()));
  assert.equal(first.status, 200);
  assert.deepEqual(await first.json(), { ok: true });

  const state = JSON.parse(redis.values.get("impostor:test:state"));
  assert.equal(state.nextUpdateId, 41);
  assert.equal(state.sessions["-100"].players[0].id, 11);
  assert.equal(api.calls.filter((call) => call.method === "sendMessage").length, 1);
  assert.equal(redis.values.has("impostor:test:update-lock"), false);

  const duplicate = await handler(requestFor(newGameUpdate()));
  assert.equal(duplicate.status, 200);
  assert.deepEqual(await duplicate.json(), { ok: true, duplicate: true });
  assert.equal(api.calls.filter((call) => call.method === "sendMessage").length, 1);
});

test("the webhook asks Telegram to retry while another update owns the lock", async () => {
  const redis = new FakeRedis();
  redis.values.set("impostor:test:update-lock", "another-request");
  const handler = createWebhookHandler({
    env,
    redisClient: redis,
    coreLoader: async () => testCore(new FakeTelegramApi()),
    logger: silentLogger,
  });

  const response = await handler(requestFor(newGameUpdate()));
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("retry-after"), "1");
  assert.equal(redis.values.get("impostor:test:update-lock"), "another-request");
});
