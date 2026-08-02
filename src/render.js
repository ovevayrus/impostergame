import { callbackData, Phase } from "./game.js";

export const RULES_TEXT = [
  "🎭 <b>How to play Impostor</b>",
  "",
  "1. Everyone joins the lobby, then any group member can start.",
  "2. Most players get the same secret word. One random player is the Impostor and gets only a related hint.",
  "3. In the displayed order, each player says one word or short phrase connected to the secret word.",
  "4. Discuss who sounded suspicious. The group tries to identify the Impostor; the Impostor tries to guess the secret word.",
  "5. Tap <b>Reveal answer</b> when you are ready to finish the round.",
].join("\n");

export const HELP_TEXT = [
  "🎭 <b>Impostor Bot</b>",
  "",
  "Use /newgame in a group to open a lobby. Players join with the button and anyone can start once there are enough players.",
  "",
  "<b>Commands</b>",
  "/newgame — open a lobby",
  "/status — repost the current game panel",
  "/rules — explain the game",
  "/endgame — reveal an active round",
  "/cancelgame — cancel your lobby; group admins can reset any game",
  "",
  "Roles are shown privately inside the group. Nobody needs to start a direct chat with the bot.",
].join("\n");

export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function playerMention(player) {
  return `<a href="tg://user?id=${player.id}">${escapeHtml(player.name)}</a>`;
}

function playerById(session, userId) {
  return session.players.find((player) => player.id === userId);
}

function lobbyKeyboard(session) {
  return {
    inline_keyboard: [
      [
        { text: "➕ Join", callback_data: callbackData(session, "join") },
        { text: "➖ Leave", callback_data: callbackData(session, "leave") },
      ],
      [
        { text: "🎲 Start game", callback_data: callbackData(session, "start") },
        { text: "✖️ Cancel", callback_data: callbackData(session, "cancel") },
      ],
    ],
  };
}

function activeKeyboard(session) {
  return {
    inline_keyboard: [
      [{ text: "🔐 Reveal my role", callback_data: callbackData(session, "reveal") }],
      [{ text: "🏁 Reveal answer", callback_data: callbackData(session, "end") }],
    ],
  };
}

function finishedKeyboard(session) {
  return {
    inline_keyboard: [
      [{ text: "▶️ Keep playing", callback_data: callbackData(session, "replay") }],
      [
        { text: "👥 Reopen lobby", callback_data: callbackData(session, "lobby") },
        { text: "✖️ Close", callback_data: callbackData(session, "close") },
      ],
    ],
  };
}

export function renderLobby(session, { minPlayers, maxPlayers }) {
  const roster = session.players.length
    ? session.players
        .map((player, index) => `${index + 1}. ${playerMention(player)}`)
        .join("\n")
    : "<i>No players yet.</i>";
  const missing = Math.max(0, minPlayers - session.players.length);
  const readiness = missing
    ? `Need ${missing} more ${missing === 1 ? "player" : "players"} to start.`
    : "Ready! Any group member can press <b>Start game</b>.";

  return {
    text: [
      "🎭 <b>Impostor game lobby</b>",
      "",
      `<b>Players (${session.players.length}/${maxPlayers})</b>`,
      roster,
      "",
      readiness,
      "Tap <b>Join</b> if you want a role. The person who presses Start is joined automatically.",
    ].join("\n"),
    replyMarkup: lobbyKeyboard(session),
  };
}

export function renderActive(session) {
  const viewed = session.assignment.viewedPlayerIds.length;
  const total = session.players.length;
  const order = session.assignment.order
    .map((id, index) => `${index + 1}. ${playerMention(playerById(session, id))}`)
    .join("\n");
  const checkedLine =
    viewed === total
      ? "✅ <b>Everyone has confirmed their role with Reveal.</b>"
      : `🔐 Players who used Reveal: <b>${viewed}/${total}</b>`;

  return {
    text: [
      `🎭 <b>New round ${session.round}</b>`,
      "",
      checkedLine,
      "Tap <b>Reveal my role</b> to view it or retrieve it again. Only you can see your word or hint.",
      "",
      "<b>Clue order</b>",
      order,
      "",
      "Give one related word or short phrase each, then discuss who the Impostor might be.",
    ].join("\n"),
    replyMarkup: activeKeyboard(session),
  };
}

export function renderFinished(session) {
  const impostor = playerById(session, session.assignment.impostorId);
  return {
    text: [
      `🏁 <b>Round ${session.round} results</b>`,
      "",
      `🔐 <b>Word:</b> ${escapeHtml(session.assignment.word)}`,
      `💡 <b>Hint:</b> ${escapeHtml(session.assignment.hint)}`,
      `🕵️ <b>Impostor:</b> ${playerMention(impostor)}`,
      `🗂 <b>Category:</b> ${escapeHtml(session.assignment.category)}`,
    ].join("\n"),
    replyMarkup: finishedKeyboard(session),
  };
}

export function renderSession(session, settings) {
  if (session.phase === Phase.LOBBY) return renderLobby(session, settings);
  if (session.phase === Phase.ACTIVE) return renderActive(session);
  return renderFinished(session);
}

export function roleAlertText(role) {
  if (role.kind === "impostor") {
    return [
      "🕵️ YOU ARE THE IMPOSTOR",
      `Hint: ${role.hint}`,
      `Category: ${role.category}`,
      "Blend in and work out the secret word.",
    ].join("\n\n");
  }
  return ["🔐 YOUR SECRET WORD", role.word, `Category: ${role.category}`, "Do not show anyone."].join(
    "\n\n",
  );
}

export function roleMessageHtml(role) {
  if (role.kind === "impostor") {
    return [
      "🕵️ <b>You are the Impostor</b>",
      "",
      `<b>Hint:</b> ${escapeHtml(role.hint)}`,
      `<b>Category:</b> ${escapeHtml(role.category)}`,
      "",
      "Blend in, listen carefully, and try to work out the secret word.",
    ].join("\n");
  }
  return [
    "🔐 <b>Your secret word</b>",
    "",
    `<b>${escapeHtml(role.word)}</b>`,
    `<b>Category:</b> ${escapeHtml(role.category)}`,
    "",
    "Keep it secret. Give a related clue when it is your turn.",
  ].join("\n");
}
