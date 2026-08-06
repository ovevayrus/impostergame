import assert from "node:assert/strict";
import test from "node:test";

import {
  addPlayer,
  callbackData,
  castVote,
  closeVoting,
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
  startTieBreakVoting,
  startVoting,
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
  assert.equal(session.voting, null);
  assert.equal(session.voteResult, null);

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

test("voting starts with every player in assignment order", () => {
  const active = startRound(lobbyWith(4), entries, { randomInt: () => 0 });
  const voting = startVoting(active);

  assert.equal(voting.phase, Phase.ACTIVE);
  assert.deepEqual(voting.voting, {
    status: "open",
    ballotNumber: 1,
    candidateIds: active.assignment.order,
    ballots: [],
  });
  assert.equal(voting.voteResult, null);
  assert.equal(voting.revision, active.revision + 1);
  assert.equal(active.voting, null, "starting a vote must not mutate the input session");
  assert.equal(roleFor(voting, users[0].id).kind, "impostor");

  assert.throws(
    () => startVoting(voting),
    (error) => error instanceof GameRuleError && error.code === "voting_already_started",
  );
  assert.throws(
    () => startVoting(lobbyWith(3)),
    (error) => error instanceof GameRuleError && error.code === "wrong_phase",
  );
});

test("each player has one changeable ballot without changing the callback revision", () => {
  const open = startVoting(startRound(lobbyWith(3), entries, { randomInt: () => 0 }));
  const [firstCandidate, secondCandidate] = open.voting.candidateIds;

  const first = castVote(open, users[0].id, firstCandidate);
  assert.equal(first.changed, true);
  assert.equal(first.session.revision, open.revision);
  assert.deepEqual(first.session.voting.ballots, [
    { voterId: users[0].id, candidateId: firstCandidate },
  ]);
  assert.deepEqual(open.voting.ballots, [], "casting a vote must not mutate the input session");

  const repeated = castVote(first.session, users[0].id, firstCandidate);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.session.revision, open.revision);
  assert.deepEqual(repeated.session.voting.ballots, first.session.voting.ballots);

  const changed = castVote(repeated.session, users[0].id, secondCandidate);
  assert.equal(changed.changed, true);
  assert.deepEqual(changed.session.voting.ballots, [
    { voterId: users[0].id, candidateId: secondCandidate },
  ]);

  const another = castVote(changed.session, users[1].id, firstCandidate);
  assert.equal(another.session.voting.ballots.length, 2);
  assert.equal(another.session.revision, open.revision);
});

test("only round players can vote and only for current candidates", () => {
  const open = startVoting(startRound(lobbyWith(3), entries, { randomInt: () => 0 }));

  assert.throws(
    () => castVote(open, 999, open.voting.candidateIds[0]),
    (error) => error instanceof GameRuleError && error.code === "not_a_player",
  );
  assert.throws(
    () => castVote(open, users[0].id, 999),
    (error) => error instanceof GameRuleError && error.code === "invalid_candidate",
  );
  assert.throws(
    () => closeVoting(open),
    (error) => error instanceof GameRuleError && error.code === "no_votes",
  );
});

test("a unique voting leader finishes the round with ordered counts", () => {
  const open = startVoting(startRound(lobbyWith(4), entries, { randomInt: () => 0 }));
  const [leader, runnerUp, third, fourth] = open.voting.candidateIds;
  let session = castVote(open, users[0].id, leader).session;
  session = castVote(session, users[1].id, leader).session;
  session = castVote(session, users[2].id, runnerUp).session;

  const finished = closeVoting(session);

  assert.equal(finished.phase, Phase.FINISHED);
  assert.equal(finished.voting, null);
  assert.equal(finished.revision, open.revision + 1);
  assert.deepEqual(finished.voteResult, {
    ballotNumber: 1,
    accusedId: leader,
    counts: [
      { candidateId: leader, count: 2 },
      { candidateId: runnerUp, count: 1 },
      { candidateId: third, count: 0 },
      { candidateId: fourth, count: 0 },
    ],
  });
});

test("a tied vote pauses for hints, then opens a narrowed tie-break ballot", () => {
  const open = startVoting(startRound(lobbyWith(4), entries, { randomInt: () => 0 }));
  const [firstCandidate, secondCandidate] = open.voting.candidateIds;
  let session = castVote(open, users[0].id, firstCandidate).session;
  session = castVote(session, users[1].id, secondCandidate).session;

  const tied = closeVoting(session);
  assert.equal(tied.phase, Phase.ACTIVE);
  assert.equal(tied.voteResult, null);
  assert.deepEqual(tied.voting, {
    status: "tiebreak",
    ballotNumber: 2,
    candidateIds: [firstCandidate, secondCandidate],
    ballots: [],
  });
  assert.equal(tied.revision, open.revision + 1);
  assert.equal(roleFor(tied, users[1].id).kind, "player");
  assert.throws(
    () => castVote(tied, users[0].id, firstCandidate),
    (error) => error instanceof GameRuleError && error.code === "voting_not_open",
  );

  const tieBreak = startTieBreakVoting(tied);
  assert.equal(tieBreak.voting.status, "open");
  assert.equal(tieBreak.voting.ballotNumber, 2);
  assert.deepEqual(tieBreak.voting.candidateIds, [firstCandidate, secondCandidate]);
  assert.equal(tieBreak.revision, tied.revision + 1);

  session = castVote(tieBreak, users[2].id, secondCandidate).session;
  const finished = closeVoting(session);
  assert.equal(finished.phase, Phase.FINISHED);
  assert.deepEqual(finished.voteResult, {
    ballotNumber: 2,
    accusedId: secondCandidate,
    counts: [
      { candidateId: firstCandidate, count: 0 },
      { candidateId: secondCandidate, count: 1 },
    ],
  });
});

test("tie-break voting can only start from a paused tie", () => {
  const active = startRound(lobbyWith(3), entries, { randomInt: () => 0 });
  assert.throws(
    () => startTieBreakVoting(active),
    (error) => error instanceof GameRuleError && error.code === "no_tiebreak",
  );
  assert.throws(
    () => startTieBreakVoting(startVoting(active)),
    (error) => error instanceof GameRuleError && error.code === "no_tiebreak",
  );
});

test("another tied runoff opens a fresh extra-clue round", () => {
  const firstBallot = startVoting(
    startRound(lobbyWith(3), entries, { randomInt: () => 0 }),
  );
  const [firstCandidate, secondCandidate] = firstBallot.voting.candidateIds;
  let session = castVote(firstBallot, users[0].id, firstCandidate).session;
  session = castVote(session, users[1].id, secondCandidate).session;
  session = startTieBreakVoting(closeVoting(session));
  session = castVote(session, users[0].id, firstCandidate).session;
  session = castVote(session, users[1].id, secondCandidate).session;

  const tiedAgain = closeVoting(session);
  assert.equal(tiedAgain.phase, Phase.ACTIVE);
  assert.deepEqual(tiedAgain.voting, {
    status: "tiebreak",
    ballotNumber: 3,
    candidateIds: [firstCandidate, secondCandidate],
    ballots: [],
  });
});

test("voting fields are reset across manual finishes, rematches, and reopened lobbies", () => {
  const open = startVoting(startRound(lobbyWith(3), entries, { randomInt: () => 0 }));
  const manuallyFinished = finishRound(open);
  assert.equal(manuallyFinished.voting, null);
  assert.equal(manuallyFinished.voteResult, null);

  let voted = startVoting(startRound(manuallyFinished, entries, { randomInt: () => 0 }));
  voted = castVote(voted, users[0].id, voted.voting.candidateIds[0]).session;
  const voteFinished = closeVoting(voted);
  assert.notEqual(voteFinished.voteResult, null);

  const rematch = startRound(voteFinished, entries, { randomInt: () => 0 });
  assert.equal(rematch.voting, null);
  assert.equal(rematch.voteResult, null);

  const reopened = reopenLobby(finishRound(startVoting(rematch)));
  assert.equal(reopened.voting, null);
  assert.equal(reopened.voteResult, null);
});

test("voting tolerates active sessions saved before voting fields existed", () => {
  const legacy = startRound(lobbyWith(3), entries, { randomInt: () => 0 });
  delete legacy.voting;
  delete legacy.voteResult;

  const open = startVoting(legacy);
  assert.equal(open.voting.status, "open");
  assert.equal(open.voteResult, null);
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
  const voteValue = callbackData(session, "vote", 2);

  assert.ok(value.length <= 64);
  assert.equal(value.includes("Telescope"), false);
  assert.deepEqual(parseCallbackData(value), {
    gameId: session.id,
    revision: session.revision,
    action: "reveal",
  });
  assert.deepEqual(parseCallbackData(voteValue), {
    gameId: session.id,
    revision: session.revision,
    action: "vote",
    argument: 2,
  });
  assert.equal(parseCallbackData("not-ours"), null);
  assert.equal(parseCallbackData(`${voteValue}:-1`), null);
  assert.equal(parseCallbackData(`${voteValue}:1.5`), null);
});

test("callback arguments are non-negative safe integers within Telegram's 64-byte limit", () => {
  const largest = {
    id: "g".repeat(24),
    revision: 12_345_678,
  };
  const action = "a".repeat(20);
  const exactLimit = callbackData(largest, action, 123_456);

  assert.equal(Buffer.byteLength(exactLimit, "utf8"), 64);
  assert.equal(parseCallbackData(exactLimit).argument, 123_456);
  assert.throws(() => callbackData(largest, action, 1_234_567), RangeError);
  assert.throws(() => callbackData(largest, action, -1), TypeError);
  assert.throws(() => callbackData(largest, action, 1.5), TypeError);
  assert.throws(() => callbackData(largest, action, Number.MAX_SAFE_INTEGER + 1), TypeError);
  assert.equal(parseCallbackData(`${exactLimit}0`), null);
});
