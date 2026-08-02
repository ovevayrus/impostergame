import {
  addPlayer,
  createLobby,
  finishRound,
  GameRuleError,
  isPlayer,
  markRoleViewed,
  parseCallbackData,
  Phase,
  removePlayer,
  reopenLobby,
  roleFor,
  startRound,
} from "./game.js";
import {
  escapeHtml,
  HELP_TEXT,
  playerMention,
  renderSession,
  roleAlertText,
  roleMessageHtml,
  RULES_TEXT,
} from "./render.js";
import { TelegramError } from "./telegram.js";

const GROUP_CHAT_TYPES = new Set(["group", "supergroup"]);
const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function commandFromText(text, botUsername) {
  if (typeof text !== "string") return null;
  const match = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:\s|$)/i.exec(text.trim());
  if (!match) return null;
  if (match[2] && botUsername && match[2].toLowerCase() !== botUsername.toLowerCase()) {
    return null;
  }
  return match[1].toLowerCase();
}

function shortCallbackText(text, maxLength = 200) {
  const characters = [...String(text)];
  if (characters.length <= maxLength) return text;
  return `${characters.slice(0, maxLength - 1).join("")}…`;
}

function threadParameter(threadId) {
  return threadId === null || threadId === undefined ? {} : { message_thread_id: threadId };
}

export class BotController {
  constructor({ api, store, wordBank, config, bot, logger = console }) {
    this.api = api;
    this.store = store;
    this.wordBank = wordBank;
    this.config = config;
    this.botId = bot.id;
    this.botUsername = bot.username;
    this.logger = logger;
    // Telegram recommends staying under 20 messages per minute in one group.
    this.autoDeliveryIntervalMs = config.autoDeliveryIntervalMs ?? 3_100;
  }

  async handleUpdate(update) {
    if (update.message) {
      await this.#handleMessage(update.message);
      return;
    }
    if (update.callback_query) {
      await this.#handleCallback(update.callback_query);
    }
  }

  async #handleMessage(message) {
    if (message.migrate_to_chat_id) {
      await this.store.migrateChat(message.chat.id, message.migrate_to_chat_id);
      return;
    }

    const command = commandFromText(message.text, this.botUsername);
    if (!command) return;

    const isGroup = GROUP_CHAT_TYPES.has(message.chat.type);
    if (!isGroup) {
      if (["start", "help", "rules"].includes(command)) {
        await this.#sendText(message.chat.id, command === "rules" ? RULES_TEXT : HELP_TEXT);
      } else {
        await this.#sendText(
          message.chat.id,
          "Add me to a Telegram group, then use /newgame there. Roles do not require a private chat.",
        );
      }
      return;
    }

    switch (command) {
      case "start":
      case "help":
        await this.#sendText(message.chat.id, HELP_TEXT, message.message_thread_id);
        break;
      case "rules":
        await this.#sendText(message.chat.id, RULES_TEXT, message.message_thread_id);
        break;
      case "newgame":
      case "impostor":
        await this.#newGame(message);
        break;
      case "status":
        await this.#status(message);
        break;
      case "endgame":
        await this.#endGameCommand(message);
        break;
      case "cancelgame":
        await this.#cancelGameCommand(message);
        break;
      default:
        break;
    }
  }

  async #newGame(message) {
    if (!message.from || message.from.is_bot) {
      await this.#sendText(
        message.chat.id,
        "A named Telegram user must create the lobby.",
        message.message_thread_id,
      );
      return;
    }

    const existing = this.store.getSession(message.chat.id);
    if (existing && existing.phase !== Phase.FINISHED) {
      await this.#sendText(
        message.chat.id,
        "There is already a lobby or round in progress. Use /status to find it.",
        message.message_thread_id,
      );
      return;
    }
    if (existing) {
      await this.#removeInlineKeyboard(existing);
      await this.store.deleteSession(message.chat.id);
    }

    const session = createLobby({
      chatId: message.chat.id,
      threadId: message.message_thread_id ?? null,
      creator: message.from,
    });
    await this.store.setSession(session);
    await this.#syncControl(session);
  }

  async #status(message) {
    const session = this.store.getSession(message.chat.id);
    if (!session) {
      await this.#sendText(
        message.chat.id,
        "No game is running. Use /newgame to open a lobby.",
        message.message_thread_id,
      );
      return;
    }
    // Reposting makes /status a recovery path when the original control panel was
    // deleted, buried, or left stale by a transient Telegram/API failure.
    const refreshed = await this.#syncControl(session, { forceNew: true });
    if (refreshed.controlMessageId !== session.controlMessageId) {
      if (session.phase === Phase.FINISHED) {
        await this.#removeInlineKeyboard(session);
      } else {
        await this.#editClosed(
          session,
          "🔄 <b>This game panel was refreshed.</b> Use the latest bot message.",
        );
      }
    }
  }

  async #endGameCommand(message) {
    const session = this.store.getSession(message.chat.id);
    if (!session || session.phase !== Phase.ACTIVE) {
      await this.#sendText(
        message.chat.id,
        "There is no active round to reveal.",
        message.message_thread_id,
      );
      return;
    }
    if (!message.from || !isPlayer(session, message.from.id)) {
      await this.#sendText(
        message.chat.id,
        "Only a player in this round can reveal the answer.",
        message.message_thread_id,
      );
      return;
    }

    const finished = finishRound(session);
    await this.#postRoundResults(finished);
  }

  async #cancelGameCommand(message) {
    const session = this.store.getSession(message.chat.id);
    if (!session) {
      await this.#sendText(
        message.chat.id,
        "There is no game to cancel.",
        message.message_thread_id,
      );
      return;
    }
    const isCreator =
      session.phase === Phase.LOBBY && message.from && message.from.id === session.creatorId;
    const isAdmin =
      message.from && (await this.#isChatAdmin(message.chat.id, message.from.id));
    if (!isCreator && !isAdmin) {
      await this.#sendText(
        message.chat.id,
        "Only the lobby creator or a group administrator can cancel this game.",
        message.message_thread_id,
      );
      return;
    }

    if (session.phase === Phase.FINISHED) {
      await this.#removeInlineKeyboard(session);
    } else {
      await this.#editClosed(
        session,
        `✖️ Game cancelled by ${playerMention(
          session.players.find((player) => player.id === message.from.id) || {
            id: message.from.id,
            name: message.from.first_name || "the creator",
          },
        )}.`,
      );
    }
    await this.store.deleteSession(session.chatId);
  }

  async #handleCallback(query) {
    const parsed = parseCallbackData(query.data);
    if (!parsed || !query.message || !GROUP_CHAT_TYPES.has(query.message.chat.type)) {
      await this.#answer(query, "This game button is no longer available.", true);
      return;
    }

    const session = this.store.getSession(query.message.chat.id);
    const isPrivateEphemeralAction = ["end_confirm", "dismiss"].includes(parsed.action);
    const isExpectedMessage = isPrivateEphemeralAction
      ? query.message.message_id === 0 && query.message.receiver_user?.id === query.from.id
      : session?.controlMessageId === query.message.message_id;
    if (
      !session ||
      session.id !== parsed.gameId ||
      session.revision !== parsed.revision ||
      !isExpectedMessage
    ) {
      await this.#answer(query, "This game panel is out of date. Use /status in the group.", true);
      return;
    }

    try {
      switch (parsed.action) {
        case "join":
          await this.#join(query, session);
          break;
        case "leave":
          await this.#leave(query, session);
          break;
        case "start":
          await this.#startRound(query, session);
          break;
        case "cancel":
          await this.#cancelLobby(query, session);
          break;
        case "reveal":
          await this.#revealRole(query, session);
          break;
        case "end":
          await this.#requestFinish(query, session);
          break;
        case "end_confirm":
          await this.#finishRound(query, session);
          break;
        case "dismiss":
          await this.#dismissConfirmation(query);
          break;
        case "replay":
          await this.#replay(query, session);
          break;
        case "lobby":
          await this.#reopenLobby(query, session);
          break;
        case "close":
          await this.#closeFinished(query, session);
          break;
        default:
          await this.#answer(query, "Unknown game action.", true);
      }
    } catch (error) {
      if (error instanceof GameRuleError) {
        await this.#answer(query, error.message, true);
        return;
      }
      throw error;
    }
  }

  async #join(query, session) {
    const result = addPlayer(session, query.from, this.config.maxPlayers);
    await this.store.setSession(result.session);
    await this.#answer(query, result.added ? "You joined the game." : "You are already in the lobby.");
    await this.#syncControl(result.session);
  }

  async #leave(query, session) {
    const result = removePlayer(session, query.from.id);
    await this.store.setSession(result.session);
    await this.#answer(query, result.removed ? "You left the lobby." : "You were not in the lobby.");
    await this.#syncControl(result.session);
  }

  async #startRound(query, session) {
    const joined = addPlayer(session, query.from, this.config.maxPlayers);
    let next = joined.session;
    if (next.players.length < this.config.minPlayers) {
      await this.store.setSession(next);
      const missing = this.config.minPlayers - next.players.length;
      await this.#answer(
        query,
        `${joined.added ? "You joined. " : ""}Need ${missing} more ${
          missing === 1 ? "player" : "players"
        } to start.`,
        true,
      );
      await this.#syncControl(next);
      return;
    }

    next = startRound(next, this.wordBank, { minPlayers: this.config.minPlayers });
    await this.store.setSession(next);
    await this.#answer(query, "Round started — check your role!");
    await this.#syncControl(next);
    this.#queueAutoDelivery(next);
  }

  async #cancelLobby(query, session) {
    if (session.phase !== Phase.LOBBY) {
      throw new GameRuleError("wrong_phase", "This lobby has already ended.");
    }
    const isAdmin = await this.#isChatAdmin(session.chatId, query.from.id);
    if (query.from.id !== session.creatorId && !isAdmin) {
      throw new GameRuleError(
        "not_creator",
        "Only the lobby creator or a group administrator can cancel it.",
      );
    }

    await this.#answer(query, "Lobby cancelled.");
    await this.#editClosed(session, `✖️ Lobby cancelled by ${escapeHtml(query.from.first_name)}.`);
    await this.store.deleteSession(session.chatId);
  }

  async #revealRole(query, session) {
    const role = roleFor(session, query.from.id);
    let ephemeralAccepted = false;
    try {
      await this.api.call(
        "sendMessage",
        {
          chat_id: session.chatId,
          receiver_user_id: query.from.id,
          callback_query_id: query.id,
          text: roleMessageHtml(role),
          parse_mode: "HTML",
          protect_content: true,
          ...threadParameter(session.threadId),
        },
        { signal: AbortSignal.timeout(5_000) },
      );
      ephemeralAccepted = true;
    } catch (error) {
      this.logger.warn("Ephemeral role delivery failed; using the private callback alert fallback.");
    }

    // The alert is intentionally shown even if the ephemeral message succeeds: Telegram notes
    // that ephemeral delivery is not guaranteed, while this gives every tap a reliable fallback.
    const alertAccepted = await this.#answer(query, roleAlertText(role), true);

    const viewed = markRoleViewed(session, query.from.id);
    if ((ephemeralAccepted || alertAccepted) && viewed.changed) {
      await this.store.setSession(viewed.session);
      await this.#syncControl(viewed.session);
    }
  }

  async #requestFinish(query, session) {
    if (!isPlayer(session, query.from.id)) {
      throw new GameRuleError("not_a_player", "Only a player in this round can reveal the answer.");
    }

    try {
      await this.api.call(
        "sendMessage",
        {
          chat_id: session.chatId,
          receiver_user_id: query.from.id,
          callback_query_id: query.id,
          text: "🏁 <b>Reveal the answer to everyone?</b>\n\nThis will end the current round.",
          parse_mode: "HTML",
          protect_content: true,
          reply_markup: {
            inline_keyboard: [
              [
                {
                  text: "Reveal now",
                  callback_data: `ig:${session.id}:${session.revision}:end_confirm`,
                },
                {
                  text: "Not yet",
                  callback_data: `ig:${session.id}:${session.revision}:dismiss`,
                },
              ],
            ],
          },
          ...threadParameter(session.threadId),
        },
        { signal: AbortSignal.timeout(5_000) },
      );
      await this.#answer(query, "Private confirmation sent.");
    } catch {
      await this.#answer(
        query,
        "Confirmation could not be shown. Send /endgame in the group if you want to reveal it.",
        true,
      );
    }
  }

  async #finishRound(query, session) {
    if (!isPlayer(session, query.from.id)) {
      throw new GameRuleError("not_a_player", "Only a player in this round can reveal the answer.");
    }
    const finished = finishRound(session);
    await this.#postRoundResults(finished);
    await this.#answer(query, "Answer revealed in a new group message.");
  }

  async #dismissConfirmation(query) {
    await this.#answer(query, "The current round continues.");
    if (!query.message.ephemeral_message_id) return;
    try {
      await this.api.call("deleteEphemeralMessage", {
        chat_id: query.message.chat.id,
        receiver_user_id: query.from.id,
        ephemeral_message_id: query.message.ephemeral_message_id,
      });
    } catch {
      // The confirmation may already have expired; leaving it in place is harmless.
    }
  }

  async #replay(query, session) {
    if (!isPlayer(session, query.from.id)) {
      throw new GameRuleError("not_a_player", "Only a player from the last round can start a rematch.");
    }
    const active = startRound(session, this.wordBank, { minPlayers: this.config.minPlayers });
    const posted = await this.#syncControl(active, { forceNew: true });
    await this.#removeInlineKeyboard(session);
    await this.#answer(query, "New round started!");
    this.#queueAutoDelivery(posted);
  }

  async #reopenLobby(query, session) {
    if (!isPlayer(session, query.from.id)) {
      throw new GameRuleError("not_a_player", "Only a player from the last round can reopen the lobby.");
    }
    const lobby = reopenLobby(session);
    await this.#syncControl(lobby, { forceNew: true });
    await this.#removeInlineKeyboard(session);
    await this.#answer(query, "Lobby reopened. Players can join or leave.");
  }

  async #closeFinished(query, session) {
    if (!isPlayer(session, query.from.id)) {
      throw new GameRuleError("not_a_player", "Only a player can close this game.");
    }
    await this.#answer(query, "Game closed.");
    await this.#removeInlineKeyboard(session);
    await this.store.deleteSession(session.chatId);
  }

  async #postRoundResults(finished) {
    const posted = await this.#syncControl(finished, { forceNew: true });
    if (
      finished.controlMessageId &&
      finished.controlMessageId !== posted.controlMessageId
    ) {
      await this.#editClosed(
        finished,
        `🏁 <b>Round ${finished.round} ended.</b> The word, hint, and Impostor were revealed in a new message.`,
      );
    }
    return posted;
  }

  async #autoDeliverRoles(session) {
    if (!this.config.autoSendRolesIfAdmin) return;

    let botMembership;
    try {
      botMembership = await this.api.call("getChatMember", {
        chat_id: session.chatId,
        user_id: this.botId,
      });
    } catch {
      return;
    }
    if (!["administrator", "creator"].includes(botMembership.status)) return;

    let delivered = 0;
    for (const [index, player] of session.players.entries()) {
      if (!this.#isSameActiveRound(session)) break;

      let sent = false;
      let rateLimited = false;
      for (let attempt = 0; attempt < 2 && !sent; attempt += 1) {
        try {
          await this.api.call("sendMessage", {
            chat_id: session.chatId,
            receiver_user_id: player.id,
            text: roleMessageHtml(roleFor(session, player.id)),
            parse_mode: "HTML",
            protect_content: true,
            ...threadParameter(session.threadId),
          });
          sent = true;
        } catch (error) {
          rateLimited = error instanceof TelegramError && Boolean(error.retryAfter);
          if (rateLimited && attempt === 0) {
            await wait(Math.min(error.retryAfter, 60) * 1_000);
            if (!this.#isSameActiveRound(session)) return;
            continue;
          }
          this.logger.warn(
            "An automatic ephemeral role could not be delivered; Reveal remains available.",
          );
        }
      }
      if (sent) delivered += 1;
      if (!sent && rateLimited) break;
      if (index < session.players.length - 1 && this.autoDeliveryIntervalMs > 0) {
        await wait(this.autoDeliveryIntervalMs);
      }
    }
    if (delivered > 0) {
      this.logger.info(`Automatically delivered ${delivered} private group role(s).`);
    }
  }

  #queueAutoDelivery(session) {
    void this.#autoDeliverRoles(session).catch(() => {
      this.logger.warn("Automatic role delivery stopped; players can still use Reveal.");
    });
  }

  #isSameActiveRound(session) {
    const current = this.store.getSession(session.chatId);
    return (
      current?.phase === Phase.ACTIVE &&
      current.id === session.id &&
      current.revision === session.revision
    );
  }

  async #syncControl(session, { forceNew = false } = {}) {
    const view = renderSession(session, this.config);
    const common = {
      chat_id: session.chatId,
      text: view.text,
      parse_mode: "HTML",
      reply_markup: view.replyMarkup,
    };

    if (forceNew || !session.controlMessageId) {
      const message = await this.api.call("sendMessage", {
        ...common,
        ...threadParameter(session.threadId),
      });
      const updated = { ...session, controlMessageId: message.message_id };
      await this.store.setSession(updated);
      return updated;
    }

    try {
      await this.api.call("editMessageText", {
        ...common,
        message_id: session.controlMessageId,
      });
      return session;
    } catch (error) {
      if (error instanceof TelegramError && /message is not modified/i.test(error.description)) {
        return session;
      }
      this.logger.warn("The game panel could not be edited; sending a replacement panel.");
      const message = await this.api.call("sendMessage", {
        ...common,
        ...threadParameter(session.threadId),
      });
      const updated = { ...session, controlMessageId: message.message_id };
      await this.store.setSession(updated);
      return updated;
    }
  }

  async #editClosed(session, text) {
    if (!session.controlMessageId) return;
    try {
      await this.api.call("editMessageText", {
        chat_id: session.chatId,
        message_id: session.controlMessageId,
        text,
        parse_mode: "HTML",
        reply_markup: { inline_keyboard: [] },
      });
    } catch {
      this.logger.warn("Could not update the old game panel while closing it.");
    }
  }

  async #removeInlineKeyboard(session) {
    if (!session.controlMessageId) return;
    try {
      await this.api.call("editMessageReplyMarkup", {
        chat_id: session.chatId,
        message_id: session.controlMessageId,
        reply_markup: { inline_keyboard: [] },
      });
    } catch {
      this.logger.warn("Could not remove buttons from an old game message.");
    }
  }

  async #sendText(chatId, text, threadId = null) {
    return this.api.call("sendMessage", {
      chat_id: chatId,
      text,
      parse_mode: "HTML",
      ...threadParameter(threadId),
    });
  }

  async #isChatAdmin(chatId, userId) {
    try {
      const administrators = await this.api.call("getChatAdministrators", { chat_id: chatId });
      return administrators.some((membership) => membership.user?.id === userId);
    } catch {
      return false;
    }
  }

  async #answer(query, text, showAlert = false) {
    try {
      await this.api.call("answerCallbackQuery", {
        callback_query_id: query.id,
        text: shortCallbackText(text),
        show_alert: showAlert,
        cache_time: 0,
      });
      return true;
    } catch {
      this.logger.warn("Could not answer a Telegram callback query in time.");
      return false;
    }
  }
}

export { commandFromText, shortCallbackText };
