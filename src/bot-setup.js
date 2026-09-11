export const BOT_COMMANDS = Object.freeze([
  { command: "newgame", description: "Open an Impostor game lobby" },
  { command: "status", description: "Repost the current game panel" },
  { command: "rules", description: "Explain how to play" },
  { command: "endgame", description: "Reveal the active round" },
  { command: "cancelgame", description: "Cancel a lobby or admin-reset a game" },
  { command: "help", description: "Show bot commands" },
]);

export async function setBotCommands(api) {
  await api.call("setMyCommands", { commands: BOT_COMMANDS });
}
