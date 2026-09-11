import { callbackData, Phase } from "./game.js";

export const RULES_TEXT = [
  "🎭 <b>How to play Impostor</b>",
  "",
  "1. Everyone joins the lobby, then any group member can start.",
  "2. Most players get the same secret word. One random player is the Impostor and gets only a related hint.",
  "3. In the displayed order, each player says one word or short phrase connected to the secret word.",
  "4. Discuss who sounded suspicious. The group tries to identify the Impostor; the Impostor tries to guess the secret word.",
  "5. Tap <b>Start voting</b>. Each player privately votes for the person they think is the Impostor.",
  "6. If the vote is tied, each tied player gives one new clue word aloud, then the group holds a tie-break vote.",
  "7. The bot announces whether the Impostor was caught, shows the final tally, and reveals the answer.",
].join("\n");

export const HELP_TEXT = [
  "🎭 <b>Impostor Bot</b>",
  "",
  "<b>Commands</b>",
  "/newgame: open a lobby",
  "/status: repost the game panel",
  "/rules: explain the game",
  "/endgame: skip voting and reveal the answer",
  "/cancelgame: cancel the current game",
  "",
  "Roles appear privately in the group. Use <b>Reveal my role</b> if you need to see yours again.",
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

function truncateButtonText(value, maxLength = 64) {
  const characters = Array.from(String(value));
  if (characters.length <= maxLength) return characters.join("");
  return `${characters.slice(0, maxLength - 1).join("")}…`;
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
      [{ text: "🗳 Start voting", callback_data: callbackData(session, "start_vote") }],
      [{ text: "🏁 Reveal answer", callback_data: callbackData(session, "end") }],
    ],
  };
}

function openVotingKeyboard(session) {
  const candidateRows = session.voting.candidateIds.map((candidateId, candidateIndex) => {
    const candidate = playerById(session, candidateId);
    return [
      {
        text: truncateButtonText(`🗳 Vote for ${candidate.name}`),
        callback_data: callbackData(session, "vote", candidateIndex),
      },
    ];
  });

  return {
    inline_keyboard: [
      ...candidateRows,
      [{ text: "🔐 Reveal my role", callback_data: callbackData(session, "reveal") }],
      [{ text: "✅ Finish voting", callback_data: callbackData(session, "finish_vote") }],
    ],
  };
}

function tiebreakKeyboard(session) {
  return {
    inline_keyboard: [
      [{ text: "🗳 Start tie-break vote", callback_data: callbackData(session, "runoff") }],
      [{ text: "🔐 Reveal my role", callback_data: callbackData(session, "reveal") }],
    ],
  };
}

function finishedKeyboard(session) {
  return {
    inline_keyboard: [
      [{ text: "▶️ Start new round", callback_data: callbackData(session, "replay") }],
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
  if (session.voting?.status === "open") {
    const votesCast = new Set(session.voting.ballots.map((ballot) => ballot.voterId)).size;
    const total = session.players.length;
    const ballotLabel =
      session.voting.ballotNumber === 1
        ? "Impostor vote"
        : `Tie-break vote ${session.voting.ballotNumber - 1}`;

    return {
      text: [
        `🗳 <b>Who is the Impostor? Round ${session.round}</b>`,
        `<b>${ballotLabel}</b>`,
        "",
        `Votes: <b>${votesCast}/${total}</b>`,
        "Choose a player below. Votes stay hidden until the ballot closes.",
        "",
        "Voting ends when everyone votes, or a player can finish it early.",
      ].join("\n"),
      replyMarkup: openVotingKeyboard(session),
    };
  }

  if (session.voting?.status === "tiebreak") {
    const tiedPlayers = session.voting.candidateIds
      .map((id, index) => `${index + 1}. ${playerMention(playerById(session, id))}`)
      .join("\n");

    return {
      text: [
        "⚖️ <b>The vote is tied: extra clue</b>",
        "",
        "<b>Give one more clue in this order</b>",
        tiedPlayers,
        "",
        "Do not reveal your assigned word or hint.",
        "",
        "When everyone has spoken, start the tie-break vote.",
      ].join("\n"),
      replyMarkup: tiebreakKeyboard(session),
    };
  }

  const viewed = session.assignment.viewedPlayerIds.length;
  const total = session.players.length;
  const order = session.assignment.order
    .map((id, index) => `${index + 1}. ${playerMention(playerById(session, id))}`)
    .join("\n");
  const checkedLine =
    viewed === total
      ? "✅ <b>Everyone has checked their role.</b>"
      : `🔐 Roles checked: <b>${viewed}/${total}</b>`;

  return {
    text: [
      `🎭 <b>New round ${session.round}</b>`,
      "",
      checkedLine,
      "Use <b>Reveal my role</b> whenever you need to see it again.",
      "",
      "<b>Clue order</b>",
      order,
      "",
      "Give your clues, talk it over, then start voting.",
    ].join("\n"),
    replyMarkup: activeKeyboard(session),
  };
}

export function renderFinished(session) {
  const impostor = playerById(session, session.assignment.impostorId);
  const revealLines = [
    `🔐 <b>Word:</b> ${escapeHtml(session.assignment.word)}`,
    `💡 <b>Hint:</b> ${escapeHtml(session.assignment.hint)}`,
    `🕵️ <b>Actual Impostor:</b> ${playerMention(impostor)}`,
    `🗂 <b>Category:</b> ${escapeHtml(session.assignment.category)}`,
  ];

  if (!session.voteResult) {
    return {
      text: [
        `🏁 <b>Round ${session.round} results</b>`,
        "",
        "Voting was skipped, so there was no group verdict.",
        "",
        ...revealLines,
      ].join("\n"),
      replyMarkup: finishedKeyboard(session),
    };
  }

  const accused = playerById(session, session.voteResult.accusedId);
  const caught = session.voteResult.accusedId === session.assignment.impostorId;
  const tally = session.voteResult.counts
    .map(({ candidateId, count }) => {
      const player = playerById(session, candidateId);
      const voteLabel = count === 1 ? "vote" : "votes";
      return `${playerMention(player)}: <b>${count}</b> ${voteLabel}`;
    })
    .join("\n");

  return {
    text: [
      `🏁 <b>Round ${session.round} results</b>`,
      "",
      caught
        ? "✅ <b>The Impostor has been caught!</b>"
        : "❌ <b>The Impostor hasn't been caught.</b>",
      `🗳 <b>The group voted for:</b> ${playerMention(accused)}`,
      "",
      `<b>Final tally, ballot ${session.voteResult.ballotNumber}</b>`,
      tally,
      "",
      ...revealLines,
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
