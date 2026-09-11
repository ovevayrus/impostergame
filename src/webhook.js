import { createHash, timingSafeEqual } from "node:crypto";

import { BotController } from "./controller.js";
import { loadConfig } from "./config.js";
import { RedisStore } from "./redis-store.js";
import {
  acquireRedisLease,
  RedisRestClient,
  redisKeyPrefix,
  releaseRedisLease,
} from "./redis.js";
import { TelegramApi } from "./telegram.js";
import { loadWordBank } from "./words.js";

const WEBHOOK_SECRET_PATTERN = /^[A-Za-z0-9_-]+$/;
const WEBHOOK_SECRET_PLACEHOLDER_PATTERN =
  /(?:change[-_]?me|example|placeholder|replace[-_]?with|your[-_]?(?:secret|token))/i;
const WEBHOOK_SECRET_SINGLE_CHARACTER_PATTERN = /^(.)\1+$/;
const MIN_WEBHOOK_SECRET_LENGTH = 32;
const RETIRED_WEBHOOK_SECRET_FINGERPRINTS = new Set([
  // This value was previously published as an example and must never authenticate a webhook.
  "16ac7d6d39cd",
]);
const UPDATE_LOCK_TTL_MS = 180_000;
const CHAT_TYPES = new Set(["private", "group", "supergroup", "channel"]);

function jsonResponse(body, status = 200, extraHeaders = {}) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "no-store",
      ...extraHeaders,
    },
  });
}

function secretsMatch(expected, received) {
  if (typeof received !== "string") return false;
  const expectedBuffer = Buffer.from(expected, "utf8");
  const receivedBuffer = Buffer.from(received, "utf8");
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isTelegramUser(value) {
  return (
    isObject(value) &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    typeof value.is_bot === "boolean" &&
    typeof value.first_name === "string" &&
    value.first_name.length > 0
  );
}

function isTelegramMessage(value) {
  return (
    isObject(value) &&
    Number.isSafeInteger(value.message_id) &&
    value.message_id >= 0 &&
    isObject(value.chat) &&
    Number.isSafeInteger(value.chat.id) &&
    CHAT_TYPES.has(value.chat.type) &&
    (value.from === undefined || isTelegramUser(value.from)) &&
    (value.text === undefined || typeof value.text === "string") &&
    (value.migrate_to_chat_id === undefined || Number.isSafeInteger(value.migrate_to_chat_id))
  );
}

function isTelegramCallbackQuery(value) {
  if (
    !isObject(value) ||
    typeof value.id !== "string" ||
    value.id.length === 0 ||
    !isTelegramUser(value.from) ||
    !isTelegramMessage(value.message) ||
    typeof value.data !== "string" ||
    Buffer.byteLength(value.data, "utf8") > 64
  ) {
    return false;
  }
  return (
    value.message.message_id !== 0 ||
    (isTelegramUser(value.message.receiver_user) &&
      value.message.receiver_user.id === value.from.id)
  );
}

function isTelegramUpdate(value) {
  if (
    !isObject(value) ||
    !Number.isSafeInteger(value.update_id) ||
    value.update_id < 0
  ) {
    return false;
  }
  const hasMessage = value.message !== undefined;
  const hasCallbackQuery = value.callback_query !== undefined;
  return (
    hasMessage !== hasCallbackQuery &&
    (hasMessage
      ? isTelegramMessage(value.message)
      : isTelegramCallbackQuery(value.callback_query))
  );
}

export function readWebhookSecret(env = process.env) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET is missing.");
  }
  if (
    secret.length < MIN_WEBHOOK_SECRET_LENGTH ||
    secret.length > 256 ||
    !WEBHOOK_SECRET_PATTERN.test(secret) ||
    WEBHOOK_SECRET_PLACEHOLDER_PATTERN.test(secret) ||
    WEBHOOK_SECRET_SINGLE_CHARACTER_PATTERN.test(secret) ||
    RETIRED_WEBHOOK_SECRET_FINGERPRINTS.has(
      createHash("sha256").update(secret, "utf8").digest("hex").slice(0, 12),
    )
  ) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET must be a unique random value of 32-256 letters, numbers, underscores, or hyphens.",
    );
  }
  return secret;
}

export async function buildWebhookCore(env = process.env) {
  const config = loadConfig(env);
  const api = new TelegramApi(config.token, config.apiBaseUrl);
  const [bot, wordBank] = await Promise.all([
    api.call("getMe"),
    loadWordBank(config.wordsFile),
  ]);
  return { api, bot, config, wordBank };
}

export function createWebhookHandler({
  env = process.env,
  redisClient,
  coreLoader,
  logger = console,
} = {}) {
  let client = redisClient;
  let corePromise;

  const getCore = async () => {
    if (!corePromise) {
      corePromise = Promise.resolve()
        .then(() => (coreLoader ? coreLoader() : buildWebhookCore(env)))
        .catch((error) => {
          corePromise = null;
          throw error;
        });
    }
    return corePromise;
  };

  return async function handleTelegramWebhook(request) {
    let expectedSecret;
    try {
      expectedSecret = readWebhookSecret(env);
    } catch {
      logger.error("Webhook configuration error.");
      return jsonResponse({ ok: false, error: "Webhook is not configured." }, 500);
    }

    const receivedSecret = request.headers.get("x-telegram-bot-api-secret-token");
    if (!secretsMatch(expectedSecret, receivedSecret)) {
      return jsonResponse({ ok: false, error: "Unauthorized." }, 401);
    }

    let update;
    try {
      update = await request.json();
    } catch {
      return jsonResponse({ ok: false, error: "Request body must be JSON." }, 400);
    }
    if (!isTelegramUpdate(update)) {
      return jsonResponse({ ok: false, error: "Invalid Telegram update." }, 400);
    }

    let leaseToken;
    let lockKey;
    try {
      client ||= RedisRestClient.fromEnv(env);
      const prefix = redisKeyPrefix(env);
      lockKey = `${prefix}:update-lock`;
      leaseToken = await acquireRedisLease(client, lockKey, {
        ttlMs: UPDATE_LOCK_TTL_MS,
      });
      if (!leaseToken) {
        return jsonResponse(
          { ok: false, error: "Another update is still being processed." },
          503,
          { "retry-after": "1" },
        );
      }

      const store = new RedisStore(client, `${prefix}:state`);
      await store.init();
      const nextUpdateId = store.getNextUpdateId();
      if (nextUpdateId !== null && update.update_id < nextUpdateId) {
        return jsonResponse({ ok: true, duplicate: true });
      }

      const { api, bot, config, wordBank } = await getCore();
      const controller = new BotController({
        api,
        bot,
        config,
        logger,
        store,
        wordBank,
      });
      await controller.handleUpdate(update);
      await controller.waitForPendingTasks();
      await store.setNextUpdateId(update.update_id + 1);
      return jsonResponse({ ok: true });
    } catch {
      logger.error(`Telegram update ${update.update_id} failed.`);
      return jsonResponse({ ok: false, error: "Update processing failed." }, 500);
    } finally {
      if (leaseToken) {
        try {
          await releaseRedisLease(client, lockKey, leaseToken);
        } catch {
          logger.error("Could not release the update lock.");
        }
      }
    }
  };
}
