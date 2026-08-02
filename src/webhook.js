import { timingSafeEqual } from "node:crypto";

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
const UPDATE_LOCK_TTL_MS = 180_000;

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

function isTelegramUpdate(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    Number.isSafeInteger(value.update_id) &&
    value.update_id >= 0
  );
}

export function readWebhookSecret(env = process.env) {
  const secret = env.TELEGRAM_WEBHOOK_SECRET?.trim();
  if (!secret) {
    throw new Error("TELEGRAM_WEBHOOK_SECRET is missing.");
  }
  if (secret.length > 256 || !WEBHOOK_SECRET_PATTERN.test(secret)) {
    throw new Error(
      "TELEGRAM_WEBHOOK_SECRET must be 1-256 letters, numbers, underscores, or hyphens.",
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
    } catch (error) {
      logger.error(`Webhook configuration error: ${error.message}`);
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
    } catch (error) {
      logger.error(`Telegram update ${update.update_id} failed: ${error.message}`);
      return jsonResponse({ ok: false, error: "Update processing failed." }, 500);
    } finally {
      if (leaseToken) {
        try {
          await releaseRedisLease(client, lockKey, leaseToken);
        } catch (error) {
          logger.error(`Could not release the update lock: ${error.message}`);
        }
      }
    }
  };
}
