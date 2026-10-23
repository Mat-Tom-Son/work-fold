/**
 * Spelling guesses from macOS itself. Electron's right-click details often
 * come back with no suggestions on macOS even when the word is underlined
 * (electron/electron#24455), so the page's menu asks the system spell checker
 * directly, the way Chrome's own menu does.
 */
import { execFile } from "node:child_process";

const script = `ObjC.import("AppKit");
function run(argv) {
  const word = argv[0];
  const guesses = $.NSSpellChecker.sharedSpellChecker.guessesForWordRangeInStringLanguageInSpellDocumentWithTag($.NSMakeRange(0, word.length), word, $(), 0);
  return JSON.stringify(ObjC.deepUnwrap(guesses) || []);
}`;

/** Up to `limit` guesses for a misspelled word, or none when macOS has none or does not answer in time. */
export function macSpellingGuesses(word: string, limit = 5, timeoutMs = 1_000): Promise<string[]> {
  // An argument that starts with a dash would read as an option.
  if (process.platform !== "darwin" || !word || word.length > 100 || word.startsWith("-")) return Promise.resolve([]);
  return new Promise((resolve) => {
    execFile("/usr/bin/osascript", ["-l", "JavaScript", "-e", script, word], { timeout: timeoutMs }, (error, stdout) => {
      if (error) {
        resolve([]);
        return;
      }
      try {
        const guesses: unknown = JSON.parse(stdout.trim() || "[]");
        resolve(Array.isArray(guesses) ? guesses.filter((guess): guess is string => typeof guess === "string" && guess.length > 0).slice(0, limit) : []);
      } catch {
        resolve([]);
      }
    });
  });
}
