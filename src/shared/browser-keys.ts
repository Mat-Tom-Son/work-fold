/**
 * Key presses a Worker asks for ("Enter", "Tab Tab", "Meta+A") as Chrome
 * DevTools Protocol `Input.dispatchKeyEvent` parameters.
 */

export interface BrowserKeyPress {
  key: string;
  code: string;
  keyCode: number;
  /** The character typed, absent with Control or Meta held. */
  text?: string;
  /** Alt 1, Control 2, Meta 4, Shift 8, as the protocol counts them. */
  modifiers: number;
  /** macOS editing commands the page cannot see as keys (select all, copy, paste). */
  commands?: string[];
}

const modifierBits: Record<string, number> = { alt: 1, option: 1, control: 2, ctrl: 2, meta: 4, cmd: 4, command: 4, shift: 8 };

const namedKeys: Record<string, { key: string; code: string; keyCode: number; text?: string }> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  up: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  down: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  left: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  right: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

const punctuation: Record<string, { code: string; keyCode: number; shifted?: string }> = {
  ",": { code: "Comma", keyCode: 188, shifted: "<" },
  ".": { code: "Period", keyCode: 190, shifted: ">" },
  "/": { code: "Slash", keyCode: 191, shifted: "?" },
  ";": { code: "Semicolon", keyCode: 186, shifted: ":" },
  "'": { code: "Quote", keyCode: 222, shifted: "\"" },
  "[": { code: "BracketLeft", keyCode: 219, shifted: "{" },
  "]": { code: "BracketRight", keyCode: 221, shifted: "}" },
  "-": { code: "Minus", keyCode: 189, shifted: "_" },
  "=": { code: "Equal", keyCode: 187, shifted: "+" },
  "`": { code: "Backquote", keyCode: 192, shifted: "~" },
  "\\": { code: "Backslash", keyCode: 220, shifted: "|" },
};

/** macOS sends these shortcuts to the browser as editing commands, not keys. */
const macCommands: Record<string, string> = {
  a: "selectAll",
  c: "copy",
  v: "paste",
  x: "cut",
  z: "undo",
};

/** One combination such as "Shift+Tab" or "Meta+A". */
export function parseBrowserKey(combo: string): BrowserKeyPress {
  const parts = combo === "+" ? ["+"] : combo.split("+").map((part) => part.trim());
  // "Control++" means Control and the plus key.
  if (combo.length > 1 && combo.endsWith("++")) parts.splice(parts.length - 2, 2, "+");
  const name = parts.pop() ?? "";
  if (!name) throw new Error(`"${combo}" names no key.`);
  let modifiers = 0;
  for (const part of parts) {
    const bit = modifierBits[part.toLowerCase()];
    if (bit === undefined) throw new Error(`"${part}" is not a modifier. Use Alt, Control, Meta, or Shift.`);
    modifiers |= bit;
  }
  const shift = (modifiers & 8) !== 0;
  const commandHeld = (modifiers & 6) !== 0;
  const named = namedKeys[name.toLowerCase()];
  let press: BrowserKeyPress;
  if (named) {
    press = { key: named.key, code: named.code, keyCode: named.keyCode, modifiers, ...(named.text ? { text: named.text } : {}) };
  } else if (/^f([1-9]|1[0-2])$/i.test(name)) {
    const number = Number(name.slice(1));
    press = { key: `F${number}`, code: `F${number}`, keyCode: 111 + number, modifiers };
  } else if (/^[a-z]$/i.test(name)) {
    // "Meta+A" means Command and the A key, so a capital letter does not add Shift.
    const lower = name.toLowerCase();
    const typed = shift ? lower.toUpperCase() : lower;
    press = { key: typed, code: `Key${lower.toUpperCase()}`, keyCode: lower.toUpperCase().charCodeAt(0), text: typed, modifiers };
    const command = macCommands[lower];
    if (command && (modifiers & 4) !== 0 && !(modifiers & 3)) press.commands = [shift && lower === "z" ? "redo" : command];
  } else if (/^[0-9]$/.test(name)) {
    press = { key: name, code: `Digit${name}`, keyCode: name.charCodeAt(0), text: name, modifiers };
  } else if (punctuation[name]) {
    const entry = punctuation[name]!;
    const typed = shift && entry.shifted ? entry.shifted : name;
    press = { key: typed, code: entry.code, keyCode: entry.keyCode, text: typed, modifiers };
  } else if (name === "+") {
    press = { key: "+", code: "Equal", keyCode: 187, text: "+", modifiers: modifiers | 8 };
  } else {
    throw new Error(`"${name}" is not a key this browser knows. Use a letter, a digit, punctuation, F1–F12, or a name such as Enter, Tab, Escape, Backspace, Delete, Space, ArrowDown, Home, or PageDown.`);
  }
  if (commandHeld) delete press.text;
  return press;
}

/** A sequence such as "Tab Tab Enter": combinations separated by spaces. */
export function parseBrowserKeys(keys: string): BrowserKeyPress[] {
  const combos = keys.trim().split(/\s+/).filter(Boolean);
  if (!combos.length) throw new Error("Name at least one key, for example Enter or Meta+A.");
  return combos.map(parseBrowserKey);
}
