import { freshState, validateState } from "./store.js";

export class RedisStore {
  constructor(client, key) {
    if (!client || typeof client.command !== "function") {
      throw new Error("RedisStore requires a Redis REST client.");
    }
    if (!key) throw new Error("RedisStore requires a state key.");
    this.client = client;
    this.key = key;
    this.state = freshState();
  }

  async init() {
    let raw = await this.client.command("GET", this.key);
    if (raw === null) {
      const initial = freshState();
      const created = await this.client.command(
        "SET",
        this.key,
        JSON.stringify(initial),
        "NX",
      );
      if (created === "OK") {
        this.state = initial;
        return;
      }
      raw = await this.client.command("GET", this.key);
    }

    if (typeof raw !== "string") {
      throw new Error("The Redis game state is missing or has an unsupported format.");
    }
    try {
      this.state = validateState(JSON.parse(raw));
    } catch (error) {
      if (error instanceof SyntaxError) {
        throw new Error("The Redis game state is not valid JSON.");
      }
      throw error;
    }
  }

  getSession(chatId) {
    const session = this.state.sessions[String(chatId)];
    return session ? structuredClone(session) : null;
  }

  async setSession(session) {
    const next = structuredClone(this.state);
    next.sessions[String(session.chatId)] = structuredClone(session);
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
    await this.#persist(next);
    return true;
  }

  getNextUpdateId() {
    return this.state.nextUpdateId;
  }

  async setNextUpdateId(updateId) {
    const next = structuredClone(this.state);
    next.nextUpdateId = updateId;
    await this.#persist(next);
  }

  async #persist(nextState) {
    validateState(nextState);
    await this.client.command("SET", this.key, JSON.stringify(nextState));
    this.state = nextState;
  }
}
