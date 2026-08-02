import { randomBytes, randomInt as secureRandomInt } from "node:crypto";

export const Phase = Object.freeze({
  LOBBY: "lobby",
  ACTIVE: "active",
  FINISHED: "finished",
});

export class GameRuleError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "GameRuleError";
    this.code = code;
  }
}

export function createGameId() {
  return randomBytes(9).toString("base64url");
}

export function playerFromTelegramUser(user) {
  if (!user || !Number.isSafeInteger(user.id) || user.is_bot) {
    throw new GameRuleError("invalid_player", "Only Telegram user accounts can join.");
  }

  const fullName = [user.first_name, user.last_name]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);

  return {
    id: user.id,
    name: fullName || user.username || `Player ${user.id}`,
    username: user.username?.slice(0, 32) || null,
  };
}

export function createLobby({ chatId, threadId = null, creator, idFactory = createGameId }) {
  const player = playerFromTelegramUser(creator);
  const now = new Date().toISOString();

  return {
    schemaVersion: 1,
    id: idFactory(),
    chatId,
    threadId,
    controlMessageId: null,
    creatorId: player.id,
    phase: Phase.LOBBY,
    revision: 1,
    round: 0,
    players: [player],
    assignment: null,
    recentWords: [],
    createdAt: now,
    updatedAt: now,
  };
}

function copySession(session) {
  return structuredClone(session);
}

function touch(session) {
  session.updatedAt = new Date().toISOString();
  return session;
}

function requirePhase(session, phase) {
  if (session.phase !== phase) {
    throw new GameRuleError("wrong_phase", `This action is only available during ${phase}.`);
  }
}

export function addPlayer(session, telegramUser, maxPlayers = 12) {
  requirePhase(session, Phase.LOBBY);
  const player = playerFromTelegramUser(telegramUser);
  const next = copySession(session);
  const existingIndex = next.players.findIndex((candidate) => candidate.id === player.id);

  if (existingIndex >= 0) {
    next.players[existingIndex] = player;
    if (next.creatorId === null) next.creatorId = player.id;
    return { session: touch(next), added: false };
  }
  if (next.players.length >= maxPlayers) {
    throw new GameRuleError("lobby_full", `This lobby is full (${maxPlayers} players).`);
  }

  next.players.push(player);
  if (next.creatorId === null) next.creatorId = player.id;
  return { session: touch(next), added: true };
}

export function removePlayer(session, userId) {
  requirePhase(session, Phase.LOBBY);
  const next = copySession(session);
  const originalLength = next.players.length;
  next.players = next.players.filter((player) => player.id !== userId);
  const removed = next.players.length !== originalLength;
  if (removed && next.creatorId === userId) {
    next.creatorId = next.players[0]?.id ?? null;
  }
  return { session: touch(next), removed };
}

function chooseEntry(entries, recentWords, randomInt) {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new GameRuleError("empty_word_bank", "The word bank has no entries.");
  }

  const recent = new Set(recentWords.map((word) => word.toLocaleLowerCase("en")));
  const fresh = entries.filter((entry) => !recent.has(entry.word.toLocaleLowerCase("en")));
  const choices = fresh.length > 0 ? fresh : entries;
  return choices[randomInt(choices.length)];
}

function shuffled(values, randomInt) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = randomInt(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

export function startRound(
  session,
  entries,
  { minPlayers = 3, randomInt = secureRandomInt, recentLimit = 10 } = {},
) {
  if (![Phase.LOBBY, Phase.FINISHED].includes(session.phase)) {
    throw new GameRuleError("wrong_phase", "This game has already started.");
  }
  if (session.players.length < minPlayers) {
    const needed = minPlayers - session.players.length;
    throw new GameRuleError(
      "not_enough_players",
      `Need ${needed} more ${needed === 1 ? "player" : "players"} to start.`,
    );
  }

  const next = copySession(session);
  const entry = chooseEntry(entries, next.recentWords, randomInt);
  const impostor = next.players[randomInt(next.players.length)];
  const order = shuffled(
    next.players.map((player) => player.id),
    randomInt,
  );

  next.phase = Phase.ACTIVE;
  next.revision += 1;
  next.round += 1;
  next.assignment = {
    word: entry.word,
    hint: entry.hint,
    category: entry.category,
    impostorId: impostor.id,
    order,
    viewedPlayerIds: [],
  };
  next.recentWords = [...next.recentWords, entry.word].slice(-recentLimit);
  return touch(next);
}

export function roleFor(session, userId) {
  requirePhase(session, Phase.ACTIVE);
  if (!session.players.some((player) => player.id === userId)) {
    throw new GameRuleError("not_a_player", "You are not a player in this round.");
  }

  const { assignment } = session;
  if (assignment.impostorId === userId) {
    return {
      kind: "impostor",
      hint: assignment.hint,
      category: assignment.category,
    };
  }
  return {
    kind: "player",
    word: assignment.word,
    category: assignment.category,
  };
}

export function markRoleViewed(session, userId) {
  requirePhase(session, Phase.ACTIVE);
  roleFor(session, userId);
  const next = copySession(session);
  if (next.assignment.viewedPlayerIds.includes(userId)) {
    return { session: next, changed: false };
  }
  next.assignment.viewedPlayerIds.push(userId);
  return { session: touch(next), changed: true };
}

export function finishRound(session) {
  requirePhase(session, Phase.ACTIVE);
  const next = copySession(session);
  next.phase = Phase.FINISHED;
  next.revision += 1;
  return touch(next);
}

export function reopenLobby(session) {
  requirePhase(session, Phase.FINISHED);
  const next = copySession(session);
  next.phase = Phase.LOBBY;
  next.revision += 1;
  next.assignment = null;
  return touch(next);
}

export function isPlayer(session, userId) {
  return session.players.some((player) => player.id === userId);
}

export function callbackData(session, action) {
  return `ig:${session.id}:${session.revision}:${action}`;
}

export function parseCallbackData(value) {
  if (typeof value !== "string") return null;
  const match = /^ig:([A-Za-z0-9_-]{6,24}):(\d{1,8}):([a-z_]{2,20})$/.exec(value);
  if (!match) return null;
  return { gameId: match[1], revision: Number(match[2]), action: match[3] };
}
