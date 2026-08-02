import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createLobby } from "../src/game.js";
import { JsonStore } from "../src/store.js";

const user = { id: 123, first_name: "Store Tester", is_bot: false };

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
