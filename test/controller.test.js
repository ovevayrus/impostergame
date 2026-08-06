import assert from "node:assert/strict";
import test from "node:test";

import { BotController, commandFromText, shortCallbackText } from "../src/controller.js";
import { addPlayer, callbackData, createLobby, Phase, startRound } from "../src/game.js";

const people = [
  { id: 11, first_name: "Ari", is_bot: false },
  { id: 22, first_name: "Bea", is_bot: false },
  { id: 33, first_name: "Cal", is_bot: false },
];

const wordBank = [{ word: "Telescope", hint: "Galileo", category: "Object" }];

class MemoryStore {
  constructor(session = null) {
    this.session = session;
  }
  getSession(chatId) {
    return this.session?.chatId === chatId ? structuredClone(this.session) : null;
  }
  async setSession(session) {
    this.session = structuredClone(session);
  }
  async deleteSession() {
    this.session = null;
  }
  async migrateChat(oldId, newId) {
    if (this.session?.chatId !== oldId) return false;
    this.session.chatId = newId;
    return true;
  }
}

class FakeApi {
  constructor(botStatus = "member", adminIds = []) {
    this.calls = [];
    this.nextMessageId = 100;
    this.botStatus = botStatus;
    this.adminIds = adminIds;
    this.failMethods = new Set();
  }
  async call(method, params) {
    this.calls.push({ method, params: structuredClone(params) });
    if (this.failMethods.has(method)) throw new Error(`Injected ${method} failure`);
    if (method === "getChatMember") return { status: this.botStatus };
    if (method === "getChatAdministrators") {
      return this.adminIds.map((id) => ({ status: "administrator", user: { id } }));
    }
    if (method === "sendMessage") return { message_id: this.nextMessageId++ };
    return true;
  }
}

function makeController(
  session,
  { botStatus = "member", adminIds = [], autoSend = true } = {},
) {
  const api = new FakeApi(botStatus, adminIds);
  const store = new MemoryStore(session);
  const logger = { info() {}, warn() {}, error() {} };
  const controller = new BotController({
    api,
    store,
    wordBank,
    config: {
      minPlayers: 3,
      maxPlayers: 12,
      autoSendRolesIfAdmin: autoSend,
      autoDeliveryIntervalMs: 0,
    },
    bot: { id: 999, username: "ImpostorTestBot" },
    logger,
  });
  return { api, store, controller };
}

function activeSession() {
  let lobby = createLobby({ chatId: -100, creator: people[0], idFactory: () => "controller_01" });
  lobby = addPlayer(lobby, people[1]).session;
  lobby = addPlayer(lobby, people[2]).session;
  lobby.controlMessageId = 77;
  return startRound(lobby, wordBank, { randomInt: () => 0 });
}

function callback(session, from, action, argument) {
  return {
    id: `query-${from.id}`,
    from,
    data: callbackData(session, action, argument),
    message: {
      message_id: session.controlMessageId,
      chat: { id: session.chatId, type: "supergroup" },
    },
  };
}

test("command parsing handles Telegram bot suffixes", () => {
  assert.equal(commandFromText("/newgame@ImpostorTestBot", "ImpostorTestBot"), "newgame");
  assert.equal(commandFromText("/newgame@SomeOtherBot", "ImpostorTestBot"), null);
  assert.equal(commandFromText("hello", "ImpostorTestBot"), null);
});

test("callback answers are capped at Telegram's 200-character limit", () => {
  assert.equal([...shortCallbackText("x".repeat(300))].length, 200);
});

test("role reveal is addressed only to the player who tapped", async () => {
  const session = activeSession();
  const { api, store, controller } = makeController(session);
  await controller.handleUpdate({ callback_query: callback(session, people[1], "reveal") });

  const privateMessage = api.calls.find(
    (call) => call.method === "sendMessage" && call.params.receiver_user_id,
  );
  assert.equal(privateMessage.params.chat_id, session.chatId);
  assert.equal(privateMessage.params.receiver_user_id, people[1].id);
  assert.equal(privateMessage.params.callback_query_id, `query-${people[1].id}`);
  assert.equal(privateMessage.params.protect_content, true);
  assert.match(privateMessage.params.text, /Telescope/);

  const alert = api.calls.find((call) => call.method === "answerCallbackQuery");
  assert.equal(alert.params.show_alert, true);
  assert.match(alert.params.text, /Telescope/);

  const publicEdit = api.calls.find((call) => call.method === "editMessageText");
  assert.ok(publicEdit, "the public role-check count should update");
  assert.equal(publicEdit.params.text.includes("Telescope"), false);
  assert.deepEqual(store.session.assignment.viewedPlayerIds, [people[1].id]);
});

test("a non-player cannot retrieve any role", async () => {
  const session = activeSession();
  const outsider = { id: 44, first_name: "Outsider", is_bot: false };
  const { api, controller } = makeController(session);
  await controller.handleUpdate({ callback_query: callback(session, outsider, "reveal") });

  assert.equal(
    api.calls.some((call) => call.method === "sendMessage" && call.params.receiver_user_id),
    false,
  );
  const alert = api.calls.find((call) => call.method === "answerCallbackQuery");
  assert.match(alert.params.text, /not a player/i);
});

test("a reveal is confirmed only when at least one private response is accepted", async () => {
  const session = activeSession();
  const { api, store, controller } = makeController(session);
  api.failMethods.add("sendMessage");
  api.failMethods.add("answerCallbackQuery");

  await controller.handleUpdate({ callback_query: callback(session, people[1], "reveal") });
  assert.deepEqual(store.session.assignment.viewedPlayerIds, []);
});

test("an admin bot automatically sends each role as an ephemeral group message", async () => {
  let lobby = createLobby({ chatId: -100, creator: people[0], idFactory: () => "controller_02" });
  lobby = addPlayer(lobby, people[1]).session;
  lobby = addPlayer(lobby, people[2]).session;
  lobby.controlMessageId = 88;

  const { api, store, controller } = makeController(lobby, { botStatus: "administrator" });
  await controller.handleUpdate({ callback_query: callback(lobby, people[2], "start") });
  await controller.waitForPendingTasks();

  const deliveries = api.calls.filter(
    (call) => call.method === "sendMessage" && call.params.receiver_user_id,
  );
  assert.equal(deliveries.length, 3);
  assert.deepEqual(
    new Set(deliveries.map((call) => call.params.receiver_user_id)),
    new Set(people.map((person) => person.id)),
  );

  const publicEdit = api.calls.find((call) => call.method === "editMessageText");
  assert.equal(publicEdit.params.text.includes(store.session.assignment.word), false);
  for (const delivery of deliveries) {
    if (delivery.params.receiver_user_id === store.session.assignment.impostorId) {
      assert.equal(delivery.params.text.includes(store.session.assignment.word), false);
      assert.match(delivery.params.text, /Impostor/);
    }
  }
});

test("joined players can start a private inline poll and change their vote", async () => {
  const session = activeSession();
  const outsider = { id: 44, first_name: "Outsider", is_bot: false };
  const { api, store, controller } = makeController(session);

  await controller.handleUpdate({
    callback_query: callback(session, people[1], "start_vote"),
  });

  const voting = structuredClone(store.session);
  assert.equal(voting.phase, Phase.ACTIVE);
  assert.equal(voting.voting.status, "open");
  assert.equal(voting.voting.ballotNumber, 1);
  assert.deepEqual(voting.voting.ballots, []);
  assert.equal(voting.revision, session.revision + 1);

  const pollEdit = api.calls.find(
    (call) =>
      call.method === "editMessageText" &&
      /Who is the Impostor/i.test(call.params.text),
  );
  assert.ok(pollEdit, "the active panel should become a voting poll");
  assert.equal(pollEdit.params.text.includes(session.assignment.word), false);
  assert.equal(pollEdit.params.text.includes(session.assignment.hint), false);

  await controller.handleUpdate({
    callback_query: callback(voting, outsider, "vote", 0),
  });
  assert.deepEqual(store.session.voting.ballots, []);
  assert.match(api.calls.at(-1).params.text, /only joined players/i);

  const firstRevision = store.session.revision;
  const firstCandidate = store.session.voting.candidateIds[0];
  await controller.handleUpdate({
    callback_query: callback(store.session, people[1], "vote", 0),
  });
  assert.deepEqual(store.session.voting.ballots, [
    { voterId: people[1].id, candidateId: firstCandidate },
  ]);

  const secondCandidate = store.session.voting.candidateIds[1];
  await controller.handleUpdate({
    callback_query: callback(store.session, people[1], "vote", 1),
  });
  assert.deepEqual(store.session.voting.ballots, [
    { voterId: people[1].id, candidateId: secondCandidate },
  ]);
  assert.equal(store.session.revision, firstRevision, "changing a vote keeps poll buttons valid");
});

test("a unanimous poll catches the Impostor and offers a new round", async () => {
  const session = activeSession();
  const { api, store, controller } = makeController(session);

  await controller.handleUpdate({
    callback_query: callback(session, people[1], "start_vote"),
  });
  const impostorIndex = store.session.voting.candidateIds.indexOf(
    store.session.assignment.impostorId,
  );

  for (const player of people) {
    await controller.handleUpdate({
      callback_query: callback(store.session, player, "vote", impostorIndex),
    });
  }

  assert.equal(store.session.phase, Phase.FINISHED);
  assert.equal(store.session.voteResult.accusedId, session.assignment.impostorId);
  const result = api.calls.find(
    (call) =>
      call.method === "sendMessage" &&
      !call.params.receiver_user_id &&
      /has been caught/i.test(call.params.text),
  );
  assert.ok(result, "the bot should publicly announce the caught outcome");
  assert.match(result.params.text, /Telescope/);
  assert.match(result.params.reply_markup.inline_keyboard[0][0].text, /Start new round/);
});

test("a tied poll runs an extra-clue round and a runoff before resolving", async () => {
  const session = activeSession();
  const { api, store, controller } = makeController(session);

  await controller.handleUpdate({
    callback_query: callback(session, people[0], "start_vote"),
  });
  for (const [index, player] of people.entries()) {
    await controller.handleUpdate({
      callback_query: callback(store.session, player, "vote", index),
    });
  }

  assert.equal(store.session.phase, Phase.ACTIVE);
  assert.equal(store.session.voting.status, "tiebreak");
  assert.equal(store.session.voting.ballotNumber, 2);
  assert.equal(store.session.voting.candidateIds.length, 3);
  assert.deepEqual(store.session.voting.ballots, []);
  const tiePanel = api.calls.find(
    (call) =>
      call.method === "sendMessage" &&
      !call.params.receiver_user_id &&
      /extra clue/i.test(call.params.text),
  );
  assert.ok(tiePanel);
  assert.equal(tiePanel.params.text.includes(session.assignment.word), false);
  assert.equal(tiePanel.params.text.includes(session.assignment.hint), false);

  await controller.handleUpdate({
    callback_query: callback(store.session, people[1], "runoff"),
  });
  assert.equal(store.session.voting.status, "open");
  const impostorIndex = store.session.voting.candidateIds.indexOf(
    store.session.assignment.impostorId,
  );
  const otherIndex = impostorIndex === 0 ? 1 : 0;

  await controller.handleUpdate({
    callback_query: callback(store.session, people[0], "vote", impostorIndex),
  });
  await controller.handleUpdate({
    callback_query: callback(store.session, people[1], "vote", impostorIndex),
  });
  await controller.handleUpdate({
    callback_query: callback(store.session, people[2], "vote", otherIndex),
  });

  assert.equal(store.session.phase, Phase.FINISHED);
  assert.equal(store.session.voteResult.ballotNumber, 2);
  assert.equal(store.session.voteResult.accusedId, session.assignment.impostorId);
});

test("players can finish a partial ballot after a private confirmation", async () => {
  const session = activeSession();
  const { api, store, controller } = makeController(session);
  await controller.handleUpdate({
    callback_query: callback(session, people[0], "start_vote"),
  });
  await controller.handleUpdate({
    callback_query: callback(store.session, people[0], "vote", 1),
  });

  const voting = structuredClone(store.session);
  await controller.handleUpdate({
    callback_query: callback(voting, people[0], "finish_vote"),
  });
  const confirmation = api.calls.find(
    (call) =>
      call.method === "sendMessage" &&
      call.params.receiver_user_id === people[0].id &&
      /Finish voting now/i.test(call.params.text),
  );
  assert.ok(confirmation);

  await controller.handleUpdate({
    callback_query: {
      id: "query-finish-vote",
      from: people[0],
      data: confirmation.params.reply_markup.inline_keyboard[0][0].callback_data,
      message: {
        message_id: 0,
        ephemeral_message_id: 789,
        receiver_user: people[0],
        chat: { id: session.chatId, type: "supergroup" },
      },
    },
  });

  assert.equal(store.session.phase, Phase.FINISHED);
  assert.equal(store.session.voteResult.counts.reduce((sum, entry) => sum + entry.count, 0), 1);
  const missedResult = api.calls.find(
    (call) =>
      call.method === "sendMessage" &&
      !call.params.receiver_user_id &&
      /hasn't been caught/i.test(call.params.text),
  );
  assert.ok(missedResult, "an incorrect group verdict should announce that the Impostor escaped");
});

test("revealing the answer requires a private second tap", async () => {
  const session = activeSession();
  const { api, store, controller } = makeController(session);
  await controller.handleUpdate({ callback_query: callback(session, people[1], "end") });

  assert.equal(store.session.phase, Phase.ACTIVE);
  const confirmation = api.calls.find(
    (call) =>
      call.method === "sendMessage" &&
      call.params.receiver_user_id === people[1].id &&
      call.params.reply_markup,
  );
  assert.ok(confirmation, "a private confirmation should be sent");
  assert.equal(
    confirmation.params.reply_markup.inline_keyboard[0][1].text,
    "Not yet",
  );
  const confirmData = confirmation.params.reply_markup.inline_keyboard[0][0].callback_data;
  assert.equal(
    api.calls.some(
      (call) =>
        call.method === "sendMessage" &&
        !call.params.receiver_user_id &&
        call.params.text.includes("Telescope"),
    ),
    false,
    "the answer must not be public before confirmation",
  );

  await controller.handleUpdate({
    callback_query: {
      id: "query-confirm",
      from: people[1],
      data: confirmData,
      message: {
        message_id: 0,
        ephemeral_message_id: 456,
        receiver_user: people[1],
        chat: { id: session.chatId, type: "supergroup" },
      },
    },
  });

  assert.equal(store.session.phase, Phase.FINISHED);
  const publicReveal = api.calls.find(
    (call) =>
      call.method === "sendMessage" &&
      !call.params.receiver_user_id &&
      call.params.text.includes("Telescope"),
  );
  assert.ok(publicReveal, "the answer should be posted as a new public message");
  assert.match(publicReveal.params.text, /Galileo/);
  assert.match(publicReveal.params.text, /Ari/);
  assert.notEqual(store.session.controlMessageId, session.controlMessageId);

  const oldPanelEdit = api.calls.find(
    (call) =>
      call.method === "editMessageText" && call.params.message_id === session.controlMessageId,
  );
  assert.equal(oldPanelEdit.params.text.includes("Telescope"), false);
});

test("the endgame command also posts word, hint, and Impostor in a new public message", async () => {
  const session = activeSession();
  const { api, store, controller } = makeController(session);
  await controller.handleUpdate({
    message: {
      message_id: 902,
      text: "/endgame",
      from: people[1],
      chat: { id: session.chatId, type: "supergroup" },
    },
  });

  assert.equal(store.session.phase, Phase.FINISHED);
  const result = api.calls.find(
    (call) =>
      call.method === "sendMessage" &&
      !call.params.receiver_user_id &&
      call.params.text.includes("Telescope"),
  );
  assert.ok(result);
  assert.match(result.params.text, /Galileo/);
  assert.match(result.params.text, /Ari/);
});

test("Start new round posts a fresh panel, preserves results, and redistributes roles", async () => {
  const session = activeSession();
  const { api, store, controller } = makeController(session, {
    botStatus: "administrator",
  });
  await controller.handleUpdate({
    message: {
      message_id: 903,
      text: "/endgame",
      from: people[1],
      chat: { id: session.chatId, type: "supergroup" },
    },
  });

  const finished = structuredClone(store.session);
  const resultMessageId = finished.controlMessageId;
  const resultMessage = api.calls.find(
    (call) =>
      call.method === "sendMessage" &&
      !call.params.receiver_user_id &&
      call.params.text.includes("Telescope"),
  );
  assert.equal(
    resultMessage.params.reply_markup.inline_keyboard[0][0].text,
    "▶️ Start new round",
  );
  await controller.handleUpdate({
    callback_query: callback(finished, people[1], "replay"),
  });
  await controller.waitForPendingTasks();

  assert.equal(store.session.phase, Phase.ACTIVE);
  assert.notEqual(store.session.controlMessageId, resultMessageId);
  const newRoundMessage = api.calls.find(
    (call) =>
      call.method === "sendMessage" &&
      !call.params.receiver_user_id &&
      /New round 2/.test(call.params.text),
  );
  assert.ok(newRoundMessage, "Start new round should post a new public round message");
  assert.equal(newRoundMessage.params.text.includes("Telescope"), false);
  assert.equal(newRoundMessage.params.text.includes("Galileo"), false);
  assert.ok(
    newRoundMessage.params.reply_markup.inline_keyboard.flat().some(
      (button) => /Reveal my role/.test(button.text),
    ),
  );

  const privateRoles = api.calls.filter(
    (call) => call.method === "sendMessage" && call.params.receiver_user_id,
  );
  assert.equal(privateRoles.length, people.length);
  assert.deepEqual(
    new Set(privateRoles.map((call) => call.params.receiver_user_id)),
    new Set(people.map((person) => person.id)),
  );
  assert.ok(privateRoles.every((call) => call.params.protect_content === true));
  assert.deepEqual(
    store.session.players.map((player) => player.id),
    people.map((person) => person.id),
  );
  assert.ok(
    api.calls.some(
      (call) =>
        call.method === "editMessageReplyMarkup" &&
        call.params.message_id === resultMessageId,
    ),
    "the old result buttons should be disabled",
  );
  assert.equal(
    api.calls.some(
      (call) =>
        call.method === "editMessageText" && call.params.message_id === resultMessageId,
    ),
    false,
    "the public result text must not be overwritten",
  );
});

test("status reposts a fresh working control panel", async () => {
  const session = activeSession();
  const { api, store, controller } = makeController(session);
  await controller.handleUpdate({
    message: {
      message_id: 900,
      text: "/status",
      from: people[0],
      chat: { id: session.chatId, type: "supergroup" },
    },
  });

  const repost = api.calls.find(
    (call) => call.method === "sendMessage" && call.params.reply_markup?.inline_keyboard,
  );
  assert.ok(repost);
  assert.equal(store.session.controlMessageId, 100);
  assert.equal(repost.params.text.includes("Telescope"), false);
});

test("a group administrator can reset an orphaned active game", async () => {
  const session = activeSession();
  const administrator = { id: 44, first_name: "Admin", is_bot: false };
  const { api, store, controller } = makeController(session, {
    adminIds: [administrator.id],
  });
  await controller.handleUpdate({
    message: {
      message_id: 901,
      text: "/cancelgame",
      from: administrator,
      chat: { id: session.chatId, type: "supergroup" },
    },
  });

  assert.equal(store.session, null);
  const closedPanel = api.calls.find((call) => call.method === "editMessageText");
  assert.match(closedPanel.params.text, /cancelled/i);
});
