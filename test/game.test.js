import assert from "node:assert/strict";
import test from "node:test";

import {
  addPlayer,
  callbackData,
  createLobby,
  finishRound,
  GameRuleError,
  markRoleViewed,
  parseCallbackData,
  Phase,
  removePlayer,
  reopenLobby,
  roleFor,
  startRound,
} from "../src/game.js";

const users = [
  { id: 101, first_name: "Alice", is_bot: false },
  { id: 202, first_name: "Bob", is_bot: false },
  { id: 303, first_name: "Cara", is_bot: false },
  { id: 404, first_name: "Dan", is_bot: false },
];

const entries = [
  { word: "Telescope", hint: "Galileo", category: "Object" },
  { word: "Pizza", hint: "Delivery", category: "Food" },
  { word: "Penguin", hint: "Tuxedo", category: "Animal" },
];

function lobbyWith(count = 3) {
  let session = createLobby({ chatId: -1001, creator: users[0], idFactory: () => "game_test_01" });
  for (const user of users.slice(1, count)) {
    session = addPlayer(session, user, 12).session;
  }
  return session;
}

test("a lobby includes its creator and join/leave is idempotent", () => {
  let session = lobbyWith(1);
  assert.deepEqual(session.players.map((player) => player.id), [101]);

  let result = addPlayer(session, users[1], 3);
  assert.equal(result.added, true);
  session = result.session;

  result = addPlayer(session, { ...users[1], first_name: "Bobby" }, 3);
  assert.equal(result.added, false);
  assert.equal(result.session.players[1].name, "Bobby");

  const removed = removePlayer(result.session, users[1].id);
  assert.equal(removed.removed, true);
  assert.deepEqual(removed.session.players.map((player) => player.id), [101]);
  assert.equal(removePlayer(removed.session, 999).removed, false);
});

test("lobby ownership transfers when its creator leaves", () => {
  let session = lobbyWith(2);
  session = removePlayer(session, users[0].id).session;
  assert.equal(session.creatorId, users[1].id);

  session = removePlayer(session, users[1].id).session;
  assert.equal(session.creatorId, null);

  session = addPlayer(session, users[2]).session;
  assert.equal(session.creatorId, users[2].id);
});

test("a round requires the configured minimum number of players", () => {
  assert.throws(
    () => startRound(lobbyWith(2), entries, { minPlayers: 3, randomInt: () => 0 }),
    (error) => error instanceof GameRuleError && error.code === "not_enough_players",
  );
});

test("a round assigns exactly one impostor and one shared word", () => {
  const session = startRound(lobbyWith(4), entries, {
    minPlayers: 3,
    randomInt: () => 0,
  });

  assert.equal(session.phase, Phase.ACTIVE);
  assert.equal(session.assignment.word, "Telescope");
  assert.equal(session.assignment.impostorId, users[0].id);
  assert.equal(new Set(session.assignment.order).size, 4);

  const roles = session.players.map((player) => roleFor(session, player.id));
  assert.equal(roles.filter((role) => role.kind === "impostor").length, 1);
  assert.equal(roles.filter((role) => role.word === "Telescope").length, 3);
  assert.equal("word" in roles[0], false, "the impostor's role must not contain the answer");
});

test("viewing a role is idempotent and does not change the callback revision", () => {
  const active = startRound(lobbyWith(3), entries, { randomInt: () => 0 });
  const first = markRoleViewed(active, users[1].id);
  const second = markRoleViewed(first.session, users[1].id);

  assert.equal(first.changed, true);
  assert.equal(second.changed, false);
  assert.deepEqual(second.session.assignment.viewedPlayerIds, [users[1].id]);
  assert.equal(second.session.revision, active.revision);
});

test("a rematch avoids recently used words while alternatives exist", () => {
  const first = startRound(lobbyWith(3), entries, { randomInt: () => 0 });
  const finished = finishRound(first);
  const second = startRound(finished, entries, { randomInt: () => 0 });

  assert.equal(first.assignment.word, "Telescope");
  assert.equal(second.assignment.word, "Pizza");
  assert.equal(second.round, 2);
});

test("finished rounds can reopen the lobby without losing players", () => {
  const active = startRound(lobbyWith(3), entries, { randomInt: () => 0 });
  const lobby = reopenLobby(finishRound(active));

  assert.equal(lobby.phase, Phase.LOBBY);
  assert.equal(lobby.assignment, null);
  assert.equal(lobby.players.length, 3);
  assert.equal(lobby.round, 1);
});

test("callback data is opaque, bounded, and round-trips", () => {
  const session = lobbyWith(3);
  const value = callbackData(session, "reveal");

  assert.ok(value.length <= 64);
  assert.equal(value.includes("Telescope"), false);
  assert.deepEqual(parseCallbackData(value), {
    gameId: session.id,
    revision: session.revision,
    action: "reveal",
  });
  assert.equal(parseCallbackData("not-ours"), null);
});
