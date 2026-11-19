/**
 * Pattern masking for text that leaves the server (the opt-in peek view).
 * It is a best effort: it hides known token shapes, private key blocks,
 * key=value secrets, long hex and base64-like runs and emails. It does not
 * replace the opt-in, the per-agent request and the line caps.
 */

const PRIVATE_KEY = /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g;

const TOKENS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}/g,
  /\bsk-ant-[A-Za-z0-9_-]{10,}/g,
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
];

const BEARER = /\b(Bearer|Basic|token)(\s+)[A-Za-z0-9._~+/-]{16,}=*/g;
const KEY_VALUE = /\b([A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key)[A-Za-z0-9_-]*)(\s*[:=]\s*)(?:"[^"\s]{4,}"|'[^'\s]{4,}'|[^\s"',;]{4,})/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}\b/g;
const LONG_HEX = /\b[0-9a-fA-F]{32,}\b/g;
const RUN = /[A-Za-z0-9+/=_-]{32,}/g;

const SECRET = '[secret]';

function charClass(char: string): number {
  if (char >= 'a' && char <= 'z') return 0;
  if (char >= 'A' && char <= 'Z') return 1;
  if (char >= '0' && char <= '9') return 2;
  return 3;
}

/**
 * True for a random-looking piece (base64, keys): long, with digits and both
 * cases, and a class change (lower, upper, digit) at almost every second
 * character. Words, kebab names and paths change class far less often.
 */
function looksRandom(piece: string): boolean {
  if (piece.length < 24 || !/[0-9]/.test(piece) || !/[a-z]/.test(piece) || !/[A-Z]/.test(piece)) return false;
  let changes = 0;
  for (let i = 1; i < piece.length; i++) if (charClass(piece[i]) !== charClass(piece[i - 1])) changes++;
  return changes / piece.length >= 0.4;
}

export function maskSecrets(text: string): string {
  let out = text.replace(PRIVATE_KEY, '[private key]');
  for (const pattern of TOKENS) out = out.replace(pattern, SECRET);
  out = out.replace(BEARER, (_match, word: string, space: string) => `${word}${space}${SECRET}`);
  out = out.replace(KEY_VALUE, (_match, key: string, sep: string) => `${key}${sep}${SECRET}`);
  out = out.replace(EMAIL, '[email]');
  out = out.replace(LONG_HEX, SECRET);
  out = out.replace(RUN, (run) => (run.split('/').some(looksRandom) ? SECRET : run));
  return out;
}
