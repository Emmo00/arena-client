import { config } from "./config";

const USERNAME_RE = /^[a-zA-Z0-9_-]+$/;

const ADJECTIVES = [
  "silent", "iron", "swift", "amber", "crimson", "pale", "bold", "quiet",
  "lone", "calm", "bright", "dark", "fierce", "gentle", "grand", "humble",
  "jolly", "keen", "lively", "merry", "noble", "proud", "royal", "sly",
  "steel", "tame", "wild", "zesty", "quick", "brave", "wise", "sleepy",
  "nimble", "foxy", "tiny", "mighty", "shady", "daring", "eager", "spry",
];

const NOUNS = [
  "rook", "bishop", "knight", "pawn", "queen", "king", "castle", "gambit",
  "endgame", "zugzwang", "skewer", "pin", "fork", "discovery", "tempo",
  "squire", "champion", "duelist", "tactic", "checker", "outpost", "flag",
  "clock", "board", "opening", "middlegame", "defense", "attack", "counterplay",
  "stalemate", "enpassant", "capture", "deviation", "sacrifice", "fortress",
];

/** Valid username per the protocol: 3-24 chars, [a-zA-Z0-9_-]. */
export function validateUsername(username: string): boolean {
  if (typeof username !== "string") return false;
  const len = username.length;
  if (len < config.usernameMinLength || len > config.usernameMaxLength) return false;
  return USERNAME_RE.test(username);
}

export function normalizeUsername(username: string): string {
  return username.toLowerCase();
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

/** Candidate username like "silent-rook-284". Always satisfies the length rules. */
export function generateUsername(): string {
  const adj = pick(ADJECTIVES);
  const noun = pick(NOUNS);
  const suffix = Math.floor(Math.random() * 9000) + 100; // 3-4 digits
  return `${adj}-${noun}-${suffix}`;
}
