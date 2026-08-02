import { setBotCommands } from "../src/bot-setup.js";
import { loadConfig } from "../src/config.js";
import { TelegramApi } from "../src/telegram.js";
import { readWebhookSecret } from "../src/webhook.js";

function webhookUrlFromEnv(env = process.env) {
  const raw = env.TELEGRAM_WEBHOOK_URL?.trim();
  if (!raw) {
    throw new Error(
      "TELEGRAM_WEBHOOK_URL is missing. Set it to https://your-project.vercel.app/api/telegram.",
    );
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("TELEGRAM_WEBHOOK_URL must be a valid HTTPS URL.");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.hash) {
    throw new Error(
      "TELEGRAM_WEBHOOK_URL must be a public HTTPS URL without credentials or a fragment.",
    );
  }
  return url.toString();
}

async function main() {
  const config = loadConfig();
  const secret = readWebhookSecret();
  const url = webhookUrlFromEnv();
  const api = new TelegramApi(config.token, config.apiBaseUrl);

  await api.call("setWebhook", {
    url,
    secret_token: secret,
    max_connections: 1,
    allowed_updates: ["message", "callback_query"],
    drop_pending_updates: false,
  });
  await setBotCommands(api);

  const info = await api.call("getWebhookInfo");
  console.info(`Telegram webhook registered: ${info.url}`);
  console.info(`Pending updates: ${info.pending_update_count ?? 0}`);
  if (info.last_error_message) {
    console.warn(`Telegram's last delivery error: ${info.last_error_message}`);
  }
}

main().catch((error) => {
  console.error(`Webhook setup failed: ${error.message}`);
  process.exitCode = 1;
});
