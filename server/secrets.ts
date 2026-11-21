/**
 * Pattern masking for text that leaves the server (the opt-in peek view).
 * It is a best effort: it hides known token shapes, private key blocks,
 * key=value and command-line secrets, connection-string passwords, long hex
 * and base64-like runs and emails. It does not replace the opt-in, the
 * per-agent request and the line caps.
 */

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

const TOKEN_PREFIX = String.raw`(?:gh[pousr]_|github_pat_|gl(?:pat|rt|dt|ptt|soat|ft|imt|cbt|oas|agent)-|xox[abposr]-|sk-ant-|sk-|(?:sk|rk|pk)_(?:live|test)_|npm_|hf_|AKIA|ASIA|AIza|eyJ)`;

/** A known token prefix at the end of a line, with the rest of the token on the next line. */
const SPLIT_TOKEN = new RegExp(String.raw`\b${TOKEN_PREFIX}[A-Za-z0-9_.-]*\r?\n[ \t]*[A-Za-z0-9_.-]{4,}`, 'g');

const TOKENS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bgl(?:pat|rt|dt|ptt|soat|ft|imt|cbt|oas|agent)-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bnpm_[A-Za-z0-9]{20,}/g,
  /\bhf_[A-Za-z0-9]{20,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

const SLACK_WEBHOOK = /https:\/\/hooks\.slack\.com\/(?:services|workflows|triggers)\/[A-Za-z0-9/_-]+/g;
/** `scheme://user:password@host`, any host. */
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]*:)([^\s@/]+)(@)/gi;
const BEARER = /\b(Bearer|Basic)(\s+)[A-Za-z0-9._~+/-]{4,}=*/g;
const TOKEN_WORD = /\b(token)(\s+)[A-Za-z0-9._~+/-]{16,}=*/g;
const MYSQL_PASSWORD = /\b(mysql|mysqldump|mysqladmin|mariadb)\b([^\n|;&]*?\s-p)([^\s-]\S*)/g;
const SSHPASS = /\b(sshpass\s+-p\s*)(\S+)/g;
const PASSWORD_FLAG = /(--(?:password|passwd|pass)\s+)(?!-)(\S+)/gi;
/** `password: a phrase with spaces` up to the end of the line (an unquoted value). */
const PASSWORD_PHRASE = /\b([A-Za-z0-9_-]*(?:password|passwd|passphrase)[A-Za-z0-9_-]*)([ \t]*:[ \t]*)(?!["'[\s])([^\n]+)/gi;
/** `key=value`, `key: value`, `"key": "value"` and `'key': 'value'` for secret-like keys. */
const KEY_VALUE = /(["']?)\b([A-Za-z0-9_-]*(?:password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key)[A-Za-z0-9_-]*)(["']?\s*[:=]\s*)(?:"[^"\n]{3,}"|'[^'\n]{3,}'|[^\s"',;}]{3,})/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const LONG_HEX = /\b[0-9a-fA-F]{32,}\b/g;
const RUN = /[A-Za-z0-9+/=_-]{32,}/g;

const SECRET = '[secret]';
const PLACEHOLDER = /^\[(?:secret|email|private key)\]/;
const MAX_RAW = 4000;

function charClass(char: string): number {
  if (char >= 'a' && char <= 'z') return 0;
  if (char >= 'A' && char <= 'Z') return 1;
  if (char >= '0' && char <= '9') return 2;
  return 3;
}

/**
 * True for a random-looking piece (base64, keys): long, both cases, a digit or
 * a base64 sign, and a class change (lower, upper, digit, sign) at almost every
 * second character, or few repeated characters. Words, kebab names and paths
 * change class far less often and repeat more.
 */
function looksRandom(piece: string): boolean {
  if (piece.length < 24 || !/[0-9+/]/.test(piece) || !/[a-z]/.test(piece) || !/[A-Z]/.test(piece)) return false;
  let changes = 0;
  for (let i = 1; i < piece.length; i++) if (charClass(piece[i]) !== charClass(piece[i - 1])) changes++;
  // Random keys also repeat few characters; paths and names repeat many.
  return changes / piece.length >= 0.4 || new Set(piece).size / piece.length >= 0.6;
}

export function maskSecrets(text: string): string {
  let out = text.replace(PRIVATE_KEY, '[private key]');
  out = out.replace(SPLIT_TOKEN, SECRET);
  for (const pattern of TOKENS) out = out.replace(pattern, SECRET);
  out = out.replace(SLACK_WEBHOOK, `https://hooks.slack.com/${SECRET}`);
  out = out.replace(URL_PASSWORD, (_m, head: string, _pw: string, at: string) => `${head}${SECRET}${at}`);
  out = out.replace(BEARER, (_m, word: string, space: string) => `${word}${space}${SECRET}`);
  out = out.replace(TOKEN_WORD, (_m, word: string, space: string) => `${word}${space}${SECRET}`);
  out = out.replace(MYSQL_PASSWORD, (_m, program: string, args: string) => `${program}${args}${SECRET}`);
  out = out.replace(SSHPASS, (_m, flag: string) => `${flag}${SECRET}`);
  out = out.replace(PASSWORD_FLAG, (_m, flag: string) => `${flag}${SECRET}`);
  out = out.replace(PASSWORD_PHRASE, (_m, key: string, sep: string) => `${key}${sep}${SECRET}`);
  out = out.replace(KEY_VALUE, (_m, quote: string, key: string, sep: string) => `${quote}${key}${sep}${SECRET}`);
  out = out.replace(EMAIL, '[email]');
  out = out.replace(LONG_HEX, SECRET);
  out = out.replace(RUN, (run) => (looksRandom(run) || run.split('/').some(looksRandom) ? SECRET : run));
  return out;
}

/** Cut to `max` characters, but never inside a mask placeholder: cut before it instead. */
export function cutBeforePlaceholder(text: string, max: number): string {
  if (text.length <= max) return text;
  let cut = text.slice(0, max);
  const open = cut.lastIndexOf('[');
  if (open >= 0 && !cut.includes(']', open) && PLACEHOLDER.test(text.slice(open))) cut = cut.slice(0, open);
  return cut.trimEnd();
}

/**
 * Keeps the END of `text`, not the start (issue #81 review: a speech bubble shows "the last
 * few words", not the opening sentence `cutBeforePlaceholder` was built for). Cuts at a word
 * boundary and marks the cut with a leading ellipsis, the ellipsis itself counted in `max`.
 * Never shows a mask placeholder split in half: a `]` with no matching `[` before it (the
 * tail end of a placeholder like `[secret]`) drops along with the rest of that word, the same
 * "never show part of a token" rule `cutBeforePlaceholder` keeps.
 */
export function lastWords(text: string, max: number): string {
  if (text.length <= max) return text;
  const ELLIPSIS = '…';
  let tail = text.slice(text.length - Math.max(1, max - ELLIPSIS.length));
  const space = tail.indexOf(' ');
  if (space >= 0 && space < tail.length - 1) tail = tail.slice(space + 1);
  const close = tail.indexOf(']');
  if (close >= 0 && tail.indexOf('[') === -1) {
    const next = tail.indexOf(' ', close);
    tail = next >= 0 ? tail.slice(next + 1) : '';
  }
  return tail.length > 0 ? `${ELLIPSIS}${tail}` : ELLIPSIS;
}

/**
 * One display line of at most `max` characters: white space and control
 * characters collapse first (newlines kept for the multi-line rules), then the
 * raw cut, then the mask, then the display cut. A cut never shows part of a token.
 * `cut` picks which end to keep: the default `cutBeforePlaceholder` keeps the start;
 * `lastWords` keeps the end (issue #81's bubbles).
 */
export function maskedLine(value: unknown, max: number, cut: (text: string, max: number) => string = cutBeforePlaceholder): string {
  const raw = String(value ?? '')
    .replace(/[\s\u0000-\u001f\u007f]*\n[\s\u0000-\u001f\u007f]*/g, '\n')
    .replace(/[\t\v\f\r \u0000-\u0009\u000b-\u001f\u007f]+/g, ' ')
    .slice(0, MAX_RAW);
  const masked = maskSecrets(raw).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
  return cut(masked, max);
}
