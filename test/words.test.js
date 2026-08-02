import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findHintOverlap, loadWordBank } from "../src/words.js";

async function temporaryBank(t, entries) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "impostor-words-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "words.json");
  await writeFile(file, JSON.stringify(entries), "utf8");
  return file;
}

test("word-bank validation normalizes surrounding whitespace", async (t) => {
  const file = await temporaryBank(t, [
    { word: " Telescope ", hint: " Galileo ", category: " Object " },
    { word: "Pizza", hint: "Delivery", category: "Food" },
    { word: "Penguin", hint: "Tuxedo", category: "Animal" },
  ]);
  const entries = await loadWordBank(file);
  assert.deepEqual(entries[0], {
    word: "Telescope",
    hint: "Galileo",
    category: "Object",
  });
});

test("word-bank validation rejects hints or categories that reveal the answer", async (t) => {
  const sameHint = await temporaryBank(t, [
    { word: "Pizza ", hint: "pizza", category: "Food" },
    { word: "Penguin", hint: "Tuxedo", category: "Animal" },
    { word: "Telescope", hint: "Galileo", category: "Object" },
  ]);
  await assert.rejects(() => loadWordBank(sameHint), /gives away/);

  const sameCategory = await temporaryBank(t, [
    { word: "Pizza", hint: "Delivery", category: "pizza" },
    { word: "Penguin", hint: "Tuxedo", category: "Animal" },
    { word: "Telescope", hint: "Galileo", category: "Object" },
  ]);
  await assert.rejects(() => loadWordBank(sameCategory), /gives away/);
});

test("hint overlap catches components such as Island and land", async (t) => {
  assert.equal(findHintOverlap("Island", "land"), "land");
  assert.equal(findHintOverlap("Island", "mainland nearby"), "land");
  assert.equal(findHintOverlap("Rainbow", "rain colours"), "rain");
  assert.equal(findHintOverlap("Skateboard", "board trick"), "board");
  assert.equal(findHintOverlap("Headphones", "sound for one listener"), null);

  const file = await temporaryBank(t, [
    { word: "Island", hint: "land", category: "Nature" },
    { word: "Penguin", hint: "Tuxedo", category: "Animal" },
    { word: "Telescope", hint: "Galileo", category: "Object" },
  ]);
  await assert.rejects(() => loadWordBank(file), /gives away/);
});

test("word-bank validation requires exactly one alphabetic hint word", async (t) => {
  for (const hint of ["empty horizon", "north-south", "clue2"]) {
    const file = await temporaryBank(t, [
      { word: "Island", hint, category: "Nature" },
      { word: "Penguin", hint: "Toboggan", category: "Animal" },
      { word: "Telescope", hint: "Galileo", category: "Object" },
    ]);
    await assert.rejects(() => loadWordBank(file), /one-word hint/);
  }
});

test("word-bank validation requires short hints", async (t) => {
  const file = await temporaryBank(t, [
    {
      word: "Island",
      hint: "x".repeat(61),
      category: "Nature",
    },
    { word: "Penguin", hint: "Tuxedo", category: "Animal" },
    { word: "Telescope", hint: "Galileo", category: "Object" },
  ]);
  await assert.rejects(() => loadWordBank(file), /shorter hint/);
});

test("the bundled word bank contains only short, non-overlapping hints", async () => {
  const entries = await loadWordBank();
  assert.equal(entries.length, 175);
  for (const entry of entries) {
    assert.equal(findHintOverlap(entry.word, entry.hint), null, entry.word);
    assert.ok(entry.hint.length <= 60, entry.word);
    assert.match(entry.hint, /^[\p{Letter}\p{Mark}]+$/u, entry.word);
  }

  const uniqueHints = new Set(entries.map((entry) => entry.hint.toLocaleLowerCase("en")));
  assert.equal(uniqueHints.size, entries.length, "Every bundled hint should be unique.");
});

test("the bundled Magnet hint avoids direct giveaway words", async () => {
  const entries = await loadWordBank();
  const magnet = entries.find((entry) => entry.word === "Magnet");
  assert.equal(magnet?.hint, "Souvenirs");
  assert.doesNotMatch(magnet.hint, /\b(?:attract\w*|metal\w*|pull\w*|stick\w*)\b/i);
});
