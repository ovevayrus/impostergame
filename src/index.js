import { loadConfig } from "./config.js";
import { BotController } from "./controller.js";
import { JsonStore } from "./store.js";
import { TelegramApi, TelegramError } from "./telegram.js";
import { loadWordBank } from "./words.js";

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function configureBot(api) {
  await api.call("deleteWebhook", { drop_pending_updates: false });
  await api.call("setMyCommands", {
    commands: [
      { command: "newgame", description: "Open an Impostor game lobby" },
      { command: "status", description: "Repost the current game panel" },
      { command: "rules", description: "Explain how to play" },
      { command: "endgame", description: "Reveal the active round" },
      { command: "cancelgame", description: "Cancel a lobby or admin-reset a game" },
      { command: "help", description: "Show bot commands" },
    ],
  });
}

async function main() {
  const config = loadConfig();
  const api = new TelegramApi(config.token, config.apiBaseUrl);
  const store = new JsonStore(config.dataFile);
  const wordBank = await loadWordBank(config.wordsFile);
  await store.init();

  const bot = await api.call("getMe");
  await configureBot(api);
  const controller = new BotController({ api, store, wordBank, config, bot });
  console.info(`Impostor bot @${bot.username} is running.`);

  let stopping = false;
  let activeRequest = null;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    activeRequest?.abort();
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  let offset = store.getNextUpdateId();
  while (!stopping) {
    activeRequest = new AbortController();
    try {
      const updates = await api.call(
        "getUpdates",
        {
          offset: offset ?? undefined,
          timeout: config.pollTimeoutSeconds,
          allowed_updates: ["message", "callback_query"],
        },
        { signal: activeRequest.signal },
      );

      for (const update of updates) {
        try {
          await controller.handleUpdate(update);
        } catch (error) {
          console.error(`Update ${update.update_id} failed: ${error.message}`);
        } finally {
          offset = update.update_id + 1;
          await store.setNextUpdateId(offset);
        }
      }
    } catch (error) {
      if (stopping && error.name === "AbortError") break;
      const waitSeconds =
        error instanceof TelegramError && error.retryAfter
          ? Math.min(error.retryAfter, 60)
          : 2;
      console.error(`Polling error: ${error.message}. Retrying in ${waitSeconds}s.`);
      await delay(waitSeconds * 1000);
    } finally {
      activeRequest = null;
    }
  }

  console.info("Impostor bot stopped.");
}

main().catch((error) => {
  console.error(`Startup failed: ${error.message}`);
  process.exitCode = 1;
});
