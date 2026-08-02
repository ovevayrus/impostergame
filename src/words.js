import { readFile } from "node:fs/promises";

const DEFAULT_WORDS_URL = new URL("../data/words.json", import.meta.url);
const MAX_HINT_CHARACTERS = 60;
const SINGLE_WORD_HINT = /^[\p{Letter}\p{Mark}]+$/u;
const OVERLAP_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "its",
  "of",
  "on",
  "one",
  "or",
  "that",
  "the",
  "this",
  "to",
  "two",
  "with",
]);

function tokens(value) {
  return (
    value
      .normalize("NFKD")
      .replace(/\p{Mark}/gu, "")
      .toLocaleLowerCase("en")
      .match(/[\p{Letter}\p{Number}]+/gu) || []
  );
}

function longestSharedPiece(first, second) {
  const left = [...first];
  const right = [...second];
  let longest = "";

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const shared = [];
      while (
        leftIndex + shared.length < left.length &&
        rightIndex + shared.length < right.length &&
        left[leftIndex + shared.length] === right[rightIndex + shared.length]
      ) {
        shared.push(left[leftIndex + shared.length]);
      }
      if (shared.length > [...longest].length) longest = shared.join("");
    }
  }
  return longest;
}

export function findHintOverlap(word, hint) {
  for (const wordToken of tokens(word)) {
    for (const hintToken of tokens(hint)) {
      if (OVERLAP_STOP_WORDS.has(hintToken)) continue;

      const shorter = wordToken.length <= hintToken.length ? wordToken : hintToken;
      const longer = wordToken.length <= hintToken.length ? hintToken : wordToken;
      if (shorter.length >= 3 && longer.includes(shorter)) return shorter;

      const shared = longestSharedPiece(wordToken, hintToken);
      if ([...shared].length >= 4) return shared;
    }
  }
  return null;
}

function validateEntry(entry, index) {
  const normalized = {};
  for (const field of ["word", "hint", "category"]) {
    if (typeof entry?.[field] !== "string" || entry[field].trim() === "") {
      throw new Error(`Word-bank entry ${index + 1} needs a non-empty ${field}.`);
    }
    normalized[field] = entry[field].trim();
  }
  const hintWords = tokens(normalized.hint);
  if ([...normalized.word].length > 60 || [...normalized.category].length > 40) {
    throw new Error(`Word-bank entry ${index + 1} is too long.`);
  }
  if ([...normalized.hint].length > MAX_HINT_CHARACTERS) {
    throw new Error(
      `Word-bank entry ${index + 1} needs a shorter hint (maximum ${MAX_HINT_CHARACTERS} characters).`,
    );
  }
  if (hintWords.length !== 1 || !SINGLE_WORD_HINT.test(normalized.hint)) {
    throw new Error(`Word-bank entry ${index + 1} needs a one-word hint using letters only.`);
  }
  const answer = normalized.word.toLocaleLowerCase("en");
  const overlap = findHintOverlap(normalized.word, normalized.hint);
  if (overlap || normalized.category.toLocaleLowerCase("en") === answer) {
    throw new Error(`Word-bank entry ${index + 1} gives away its word in the hint or category.`);
  }
  return normalized;
}

export async function loadWordBank(filePath) {
  const source = filePath || DEFAULT_WORDS_URL;
  const raw = await readFile(source, "utf8");
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Could not parse the word bank at ${source}. It must be valid JSON.`);
  }
  if (!Array.isArray(parsed) || parsed.length < 3) {
    throw new Error("The word bank must contain at least 3 word/hint entries.");
  }

  const entries = parsed.map(validateEntry);
  const unique = new Set(entries.map((entry) => entry.word.toLocaleLowerCase("en")));
  if (unique.size !== entries.length) {
    throw new Error("Every word in the word bank must be unique.");
  }
  return entries;
}
