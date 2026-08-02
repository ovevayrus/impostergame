import path from "node:path";

function integerSetting(env, name, fallback, { min, max }) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;

  const value = Number(raw);
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function booleanSetting(env, name, fallback) {
  const raw = env[name];
  if (raw === undefined || raw === "") return fallback;
  if (/^(1|true|yes|on)$/i.test(raw)) return true;
  if (/^(0|false|no|off)$/i.test(raw)) return false;
  throw new Error(`${name} must be true or false.`);
}

export function loadConfig(env = process.env) {
  const token = env.TELEGRAM_BOT_TOKEN?.trim();
  if (!token) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is missing. Copy .env.example to .env and add the token from @BotFather.",
    );
  }

  const minPlayers = integerSetting(env, "MIN_PLAYERS", 3, { min: 3, max: 20 });
  const maxPlayers = integerSetting(env, "MAX_PLAYERS", 12, {
    min: minPlayers,
    max: 20,
  });

  return {
    token,
    apiBaseUrl: (env.TELEGRAM_API_BASE_URL || "https://api.telegram.org").replace(/\/$/, ""),
    dataFile: path.resolve(env.DATA_FILE || ".data/state.json"),
    wordsFile: env.WORDS_FILE ? path.resolve(env.WORDS_FILE) : undefined,
    minPlayers,
    maxPlayers,
    autoSendRolesIfAdmin: booleanSetting(env, "AUTO_SEND_ROLES_IF_ADMIN", true),
    pollTimeoutSeconds: integerSetting(env, "POLL_TIMEOUT_SECONDS", 25, {
      min: 1,
      max: 50,
    }),
  };
}
