const ANSI_ESCAPE_RE =
  // Covers CSI, OSC, and a few single-character control sequences used by TUIs.
  /[\u001B\u009B](?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\u0007\u001B]*(?:\u0007|\u001B\\))/g;
// OSC title sequences that may survive partial ANSI stripping (e.g. "0;✳ Claude Code")
const OSC_TITLE_REMNANT_RE = /^\d+;/;
const OTHER_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const BOX_DRAWING_ONLY_RE = /^[\s\u2500-\u257f]+$/u;
// Braille spinner chars, misc TUI symbols
const SPINNER_ONLY_RE = /^[\s\u2800-\u28ff✢✳✽⠂⠄⠈⠐⠠·•◦…]+$/u;
const UI_PATTERNS = [
  // Codex chrome
  /^OpenAI Codex\b/i,
  /^model:\s/i,
  /^directory:\s/i,
  /^tip:\s/i,
  /^for shortcuts$/i,
  /\bcontext left\b/i,
  /\b100% left\b/i,
  /\bImplement \{feature\}/i,
  /\besc to interrupt\b/i,
  /^Working\s*\(/i,
  /^Pouncing/i,
  /^Indexing/i,
  // Claude chrome
  /^✳\s*Claude\s*Code/i,
  /^[✢✳⠂·•]?\s*Actioning/i,
  /^[✢✳⠂·•]?\s*Frosting/i,
  /^[✢✳⠂·•]?\s*Thinking/i,
  /^[✢✳⠂·•]?\s*Reading/i,
  /^[✢✳⠂·•]?\s*Writing/i,
  /^[✢✳⠂·•]?\s*Searching/i,
  /^❯\s*$/,
  // Generic status pattern: 1-2 words ending in … (Moseying…, Determining…, etc.)
  /^\w+…$/,
  /^\w+\s+\w+…$/,
];
const INLINE_UI_REPLACEMENTS = [
  /⏵⏵\s*bypass\s*permissions\s*on.*shift\+tab.*$/iu,
  /\besc to interrupt\b.*$/i,
  /Working\s*\(\d+s\s*•[^)]*\)/i,
  // Trailing status words: "...text ✽Determining…" or "...text ◦•Wng2•"
  /[✢✳✽◦•·]+\s*\w*…?\s*$/u,
];

/** Does the line contain at least two real words (letters only, 2+ chars each)? */
function hasProse(line: string): boolean {
  const words = line.match(/[a-zA-Z]{2,}/g);
  return !!words && words.length >= 2 && line.length >= 15;
}

function isUiNoiseLine(line: string): boolean {
  const normalized = line.trim();
  if (!normalized) return true;
  if (BOX_DRAWING_ONLY_RE.test(normalized)) return true;
  if (SPINNER_ONLY_RE.test(normalized)) return true;
  if (/^[>›❯?_\s]+$/.test(normalized)) return true;
  // Short fragments without spaces are TUI corruption, not real text
  if (normalized.length < 8 && !/\s/.test(normalized)) return true;
  // OSC title remnants like "0;✳ Claude Code" or "0;⠂ Review exponential..."
  if (OSC_TITLE_REMNANT_RE.test(normalized)) return true;
  const deChromed = normalized.replace(/^[\u2500-\u257f\u2800-\u28ff✢✳✽⠂·•◦…\s>›?_❯]+/u, "");
  // Explicit UI patterns always count as noise
  if (UI_PATTERNS.some((pattern) => pattern.test(deChromed))) return true;
  // If what remains after chrome stripping isn't prose, it's noise
  if (!hasProse(deChromed)) return true;
  return false;
}

/** Quick check: does a raw output chunk contain anything meaningful after stripping? */
export function hasMeaningfulContent(raw: string): boolean {
  const stripped = raw
    .replace(ANSI_ESCAPE_RE, "")
    .replace(OTHER_CONTROL_RE, "")
    .replace(/\r\n?/g, "\n");
  const lines = stripped.split("\n");
  for (const line of lines) {
    let cleaned = line.replace(/\s+/g, " ").trim();
    for (const pattern of INLINE_UI_REPLACEMENTS) {
      cleaned = cleaned.replace(pattern, "");
    }
    cleaned = cleaned.trim();
    if (!isUiNoiseLine(cleaned)) return true;
  }
  return false;
}

export function sanitizeOutput(raw: string): string {
  const cleaned = raw
    .replace(/\r\n?/g, "\n")
    .replace(ANSI_ESCAPE_RE, "")
    .replace(OTHER_CONTROL_RE, "");

  const lines = cleaned
    .split("\n")
    .map((line) => {
      let normalized = line;
      for (const pattern of INLINE_UI_REPLACEMENTS) {
        normalized = normalized.replace(pattern, "");
      }
      return normalized.replace(/\s+/g, " ").trim();
    })
    .filter((line) => !isUiNoiseLine(line));

  const deduped: string[] = [];
  for (const line of lines) {
    if (deduped[deduped.length - 1] !== line) {
      deduped.push(line);
    }
  }

  return deduped.join("\n").trim();
}

export function snippet(text: string, max = 200): string {
  return text.replace(/\s+/g, " ").trim().slice(0, max).toLowerCase();
}
