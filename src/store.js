import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const EMPTY_STATE = Object.freeze({
  schemaVersion: 1,
  nextUpdateId: null,
  sessions: {},
});

const PHASES = new Set(["lobby", "active", "finished"]);
const VOTING_STATUSES = new Set(["open", "tiebreak"]);

export function freshState() {
  return structuredClone(EMPTY_STATE);
}

export function validateState(state) {
  if (
    !state ||
    state.schemaVersion !== 1 ||
    !state.sessions ||
    typeof state.sessions !== "object" ||
    Array.isArray(state.sessions)
  ) {
    throw new Error("The state file has an unsupported or invalid format.");
  }
  if (
    state.nextUpdateId !== null &&
    (!Number.isSafeInteger(state.nextUpdateId) || state.nextUpdateId < 0)
  ) {
    throw new Error("The state file contains an invalid Telegram update offset.");
  }
  for (const [chatKey, session] of Object.entries(state.sessions)) {
    validateSession(chatKey, session);
  }
  return state;
}

function invalidSession(chatKey, detail) {
  throw new Error(`The saved game for chat ${chatKey} is invalid: ${detail}.`);
}

function validateVoting(chatKey, voting, playerIds) {
  if (voting == null) return;
  if (
    typeof voting !== "object" ||
    Array.isArray(voting) ||
    !VOTING_STATUSES.has(voting.status) ||
    !Number.isSafeInteger(voting.ballotNumber) ||
    voting.ballotNumber < 1 ||
    !Array.isArray(voting.candidateIds) ||
    !Array.isArray(voting.ballots)
  ) {
    invalidSession(chatKey, "invalid voting round");
  }

  const candidateIds = new Set(voting.candidateIds);
  if (
    voting.candidateIds.length < 2 ||
    candidateIds.size !== voting.candidateIds.length ||
    voting.candidateIds.some((id) => !playerIds.has(id))
  ) {
    invalidSession(chatKey, "invalid voting candidates");
  }

  const voterIds = new Set();
  for (const ballot of voting.ballots) {
    if (
      !ballot ||
      typeof ballot !== "object" ||
      Array.isArray(ballot) ||
      !playerIds.has(ballot.voterId) ||
      !candidateIds.has(ballot.candidateId) ||
      voterIds.has(ballot.voterId)
    ) {
      invalidSession(chatKey, "invalid or duplicate ballot");
    }
    voterIds.add(ballot.voterId);
  }

  if (voting.status === "tiebreak" && voting.ballots.length !== 0) {
    invalidSession(chatKey, "a tiebreak contains ballots");
  }
}

function validateVoteResult(chatKey, voteResult, playerIds) {
  if (voteResult == null) return;
  if (
    typeof voteResult !== "object" ||
    Array.isArray(voteResult) ||
    !Number.isSafeInteger(voteResult.ballotNumber) ||
    voteResult.ballotNumber < 1 ||
    !playerIds.has(voteResult.accusedId) ||
    !Array.isArray(voteResult.counts)
  ) {
    invalidSession(chatKey, "invalid voting result");
  }

  const candidateIds = new Set();
  let accusedCount = null;
  for (const entry of voteResult.counts) {
    if (
      !entry ||
      typeof entry !== "object" ||
      Array.isArray(entry) ||
      !playerIds.has(entry.candidateId) ||
      candidateIds.has(entry.candidateId) ||
      !Number.isSafeInteger(entry.count) ||
      entry.count < 0
    ) {
      invalidSession(chatKey, "invalid voting result counts");
    }
    candidateIds.add(entry.candidateId);
    if (entry.candidateId === voteResult.accusedId) accusedCount = entry.count;
  }

  if (
    accusedCount === null ||
    accusedCount < 1 ||
    voteResult.counts.some(
      (entry) => entry.candidateId !== voteResult.accusedId && entry.count >= accusedCount,
    )
  ) {
    invalidSession(chatKey, "the accused player is not the unique vote leader");
  }
}

function validateSession(chatKey, session) {
  if (!session || typeof session !== "object" || Array.isArray(session)) {
    invalidSession(chatKey, "expected an object");
  }
  if (
    session.schemaVersion !== 1 ||
    !Number.isSafeInteger(session.chatId) ||
    String(session.chatId) !== chatKey ||
    typeof session.id !== "string" ||
    !/^[A-Za-z0-9_-]{6,24}$/.test(session.id) ||
    !PHASES.has(session.phase) ||
    !Number.isSafeInteger(session.revision) ||
    session.revision < 1 ||
    !Number.isSafeInteger(session.round) ||
    session.round < 0
  ) {
    invalidSession(chatKey, "invalid identity or game phase");
  }
  if (
    (session.threadId !== null &&
      (!Number.isSafeInteger(session.threadId) || session.threadId < 0)) ||
    (session.controlMessageId !== null &&
      (!Number.isSafeInteger(session.controlMessageId) || session.controlMessageId < 1))
  ) {
    invalidSession(chatKey, "invalid Telegram message identifiers");
  }
  if (!Array.isArray(session.players)) invalidSession(chatKey, "players must be an array");

  const playerIds = new Set();
  for (const player of session.players) {
    if (
      !player ||
      !Number.isSafeInteger(player.id) ||
      typeof player.name !== "string" ||
      player.name.length === 0 ||
      (player.username !== null && typeof player.username !== "string") ||
      playerIds.has(player.id)
    ) {
      invalidSession(chatKey, "invalid or duplicate player");
    }
    playerIds.add(player.id);
  }
  if (
    session.creatorId !== null &&
    (!Number.isSafeInteger(session.creatorId) || !playerIds.has(session.creatorId))
  ) {
    invalidSession(chatKey, "the lobby creator is not in the roster");
  }
  if (
    !Array.isArray(session.recentWords) ||
    session.recentWords.some((word) => typeof word !== "string")
  ) {
    invalidSession(chatKey, "invalid recent-word history");
  }

  if (session.phase === "lobby") {
    if (session.assignment !== null) invalidSession(chatKey, "a lobby contains a role assignment");
    if (session.voting != null || session.voteResult != null) {
      invalidSession(chatKey, "a lobby contains voting data");
    }
    return;
  }

  const assignment = session.assignment;
  if (
    !assignment ||
    typeof assignment.word !== "string" ||
    typeof assignment.hint !== "string" ||
    typeof assignment.category !== "string" ||
    !playerIds.has(assignment.impostorId) ||
    !Array.isArray(assignment.order) ||
    !Array.isArray(assignment.viewedPlayerIds)
  ) {
    invalidSession(chatKey, "invalid role assignment");
  }
  const orderIds = new Set(assignment.order);
  if (
    orderIds.size !== playerIds.size ||
    assignment.order.some((id) => !playerIds.has(id)) ||
    new Set(assignment.viewedPlayerIds).size !== assignment.viewedPlayerIds.length ||
    assignment.viewedPlayerIds.some((id) => !playerIds.has(id))
  ) {
    invalidSession(chatKey, "invalid clue order or role-view list");
  }

  if (session.phase === "active") {
    if (session.voteResult != null) invalidSession(chatKey, "an active game contains a vote result");
    validateVoting(chatKey, session.voting, playerIds);
    return;
  }

  if (session.voting != null) invalidSession(chatKey, "a finished game contains active voting");
  validateVoteResult(chatKey, session.voteResult, playerIds);
}

export class JsonStore {
  constructor(filePath) {
    this.filePath = path.resolve(filePath);
    this.state = freshState();
  }

  async init() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const raw = await readFile(this.filePath, "utf8");
      this.state = validateState(JSON.parse(raw));
    } catch (error) {
      if (error.code !== "ENOENT") {
        if (error instanceof SyntaxError) {
          throw new Error(
            `The state file at ${this.filePath} is not valid JSON. Move it aside and restart the bot.`,
          );
        }
        throw error;
      }
      await this.#persist(freshState());
    }
  }

  getSession(chatId) {
    const session = this.state.sessions[String(chatId)];
    return session ? structuredClone(session) : null;
  }

  async setSession(session) {
    const next = structuredClone(this.state);
    next.sessions[String(session.chatId)] = structuredClone(session);
    validateState(next);
    await this.#persist(next);
  }

  async deleteSession(chatId) {
    const next = structuredClone(this.state);
    delete next.sessions[String(chatId)];
    await this.#persist(next);
  }

  async migrateChat(oldChatId, newChatId) {
    const next = structuredClone(this.state);
    const session = next.sessions[String(oldChatId)];
    if (!session) return false;
    delete next.sessions[String(oldChatId)];
    session.chatId = newChatId;
    next.sessions[String(newChatId)] = session;
    validateState(next);
    await this.#persist(next);
    return true;
  }

  getNextUpdateId() {
    return this.state.nextUpdateId;
  }

  async setNextUpdateId(updateId) {
    const next = structuredClone(this.state);
    next.nextUpdateId = updateId;
    validateState(next);
    await this.#persist(next);
  }

  async #persist(nextState) {
    const temporaryPath = `${this.filePath}.${process.pid}.tmp`;
    const serialized = `${JSON.stringify(nextState, null, 2)}\n`;
    await writeFile(temporaryPath, serialized, { encoding: "utf8", mode: 0o600 });
    try {
      await rename(temporaryPath, this.filePath);
      this.state = nextState;
    } catch (error) {
      await unlink(temporaryPath).catch(() => {});
      throw error;
    }
  }
}
