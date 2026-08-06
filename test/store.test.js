import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { addPlayer, createLobby, finishRound, startRound } from "../src/game.js";
import { JsonStore, validateState } from "../src/store.js";

const user = { id: 123, first_name: "Store Tester", is_bot: false };
const secondUser = { id: 456, first_name: "Second Player", is_bot: false };
const thirdUser = { id: 789, first_name: "Third Player", is_bot: false };

function activeSession() {
  let session = createLobby({
    chatId: -10,
    creator: user,
    idFactory: () => "store_game_1",
  });
  session = addPlayer(session, secondUser).session;
  session = addPlayer(session, thirdUser).session;
  return startRound(
    session,
    [{ word: "Saturn", hint: "planet", category: "Space" }],
    { randomInt: () => 0 },
  );
}

function stateWith(session) {
  return {
    schemaVersion: 1,
    nextUpdateId: null,
    sessions: { [session.chatId]: session },
  };
}

test("JSON storage survives a restart and chat migration", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "impostor-store-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");

  const first = new JsonStore(file);
  await first.init();
  const session = createLobby({ chatId: -10, creator: user, idFactory: () => "store_game_1" });
  await first.setSession(session);
  await first.setNextUpdateId(987);

  const second = new JsonStore(file);
  await second.init();
  assert.deepEqual(second.getSession(-10), session);
  assert.equal(second.getNextUpdateId(), 987);

  assert.equal(await second.migrateChat(-10, -10010), true);
  assert.equal(second.getSession(-10), null);
  assert.equal(second.getSession(-10010).chatId, -10010);

  const persisted = JSON.parse(await readFile(file, "utf8"));
  assert.equal(persisted.sessions["-10010"].id, "store_game_1");
});

test("storage refuses to silently erase malformed state", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "impostor-store-bad-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");
  await writeFile(file, "not json", "utf8");

  const store = new JsonStore(file);
  await assert.rejects(() => store.init(), /not valid JSON/);
});

test("storage rejects syntactically valid state with broken structure", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "impostor-store-shape-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "state.json");
  await writeFile(
    file,
    JSON.stringify({ schemaVersion: 1, nextUpdateId: -4, sessions: null }),
    "utf8",
  );

  const store = new JsonStore(file);
  await assert.rejects(() => store.init(), /invalid format|invalid Telegram update offset/);
});

test("session validation remains compatible with legacy active and finished games", () => {
  const active = activeSession();
  delete active.voting;
  delete active.voteResult;
  assert.doesNotThrow(() => validateState(stateWith(active)));

  const finished = finishRound(active);
  delete finished.voting;
  delete finished.voteResult;
  assert.doesNotThrow(() => validateState(stateWith(finished)));
});

test("session validation accepts open voting and an empty tiebreak ballot", () => {
  const open = activeSession();
  open.voting = {
    status: "open",
    ballotNumber: 1,
    candidateIds: [123, 456, 789],
    ballots: [
      { voterId: 123, candidateId: 456 },
      { voterId: 456, candidateId: 123 },
    ],
  };
  assert.doesNotThrow(() => validateState(stateWith(open)));

  const tiebreak = activeSession();
  tiebreak.voting = {
    status: "tiebreak",
    ballotNumber: 2,
    candidateIds: [123, 456],
    ballots: [],
  };
  assert.doesNotThrow(() => validateState(stateWith(tiebreak)));
});

test("session validation rejects malformed voting rounds", () => {
  const invalidVotingRounds = [
    {
      status: "open",
      ballotNumber: 0,
      candidateIds: [123, 456],
      ballots: [],
    },
    {
      status: "open",
      ballotNumber: 1,
      candidateIds: [123, 123],
      ballots: [],
    },
    {
      status: "open",
      ballotNumber: 1,
      candidateIds: [123, 456],
      ballots: [
        { voterId: 123, candidateId: 456 },
        { voterId: 123, candidateId: 123 },
      ],
    },
    {
      status: "open",
      ballotNumber: 1,
      candidateIds: [123, 456],
      ballots: [{ voterId: 789, candidateId: 789 }],
    },
    {
      status: "tiebreak",
      ballotNumber: 2,
      candidateIds: [123, 456],
      ballots: [{ voterId: 123, candidateId: 456 }],
    },
  ];

  for (const voting of invalidVotingRounds) {
    const session = activeSession();
    session.voting = voting;
    assert.throws(() => validateState(stateWith(session)), /invalid|tiebreak/);
  }
});

test("session validation accepts only a uniquely won finished vote result", () => {
  const finished = finishRound(activeSession());
  finished.voteResult = {
    ballotNumber: 2,
    accusedId: 456,
    counts: [
      { candidateId: 123, count: 1 },
      { candidateId: 456, count: 2 },
      { candidateId: 789, count: 0 },
    ],
  };
  assert.doesNotThrow(() => validateState(stateWith(finished)));

  const invalidResults = [
    {
      ballotNumber: 1,
      accusedId: 456,
      counts: [
        { candidateId: 123, count: 2 },
        { candidateId: 456, count: 2 },
      ],
    },
    {
      ballotNumber: 1,
      accusedId: 456,
      counts: [{ candidateId: 456, count: 0 }],
    },
    {
      ballotNumber: 1,
      accusedId: 456,
      counts: [
        { candidateId: 456, count: 2 },
        { candidateId: 456, count: 1 },
      ],
    },
  ];

  for (const voteResult of invalidResults) {
    const invalid = finishRound(activeSession());
    invalid.voteResult = voteResult;
    assert.throws(() => validateState(stateWith(invalid)), /invalid|unique vote leader/);
  }
});

test("session validation enforces voting fields by game phase", () => {
  const lobby = createLobby({
    chatId: -10,
    creator: user,
    idFactory: () => "store_game_1",
  });
  lobby.voting = {
    status: "open",
    ballotNumber: 1,
    candidateIds: [123, 456],
    ballots: [],
  };
  assert.throws(() => validateState(stateWith(lobby)), /lobby contains voting data/);

  const active = activeSession();
  active.voteResult = {
    ballotNumber: 1,
    accusedId: 123,
    counts: [{ candidateId: 123, count: 1 }],
  };
  assert.throws(() => validateState(stateWith(active)), /active game contains a vote result/);

  const finished = finishRound(activeSession());
  finished.voting = {
    status: "open",
    ballotNumber: 1,
    candidateIds: [123, 456],
    ballots: [],
  };
  assert.throws(() => validateState(stateWith(finished)), /finished game contains active voting/);
});
