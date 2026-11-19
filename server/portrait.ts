import { open, stat } from 'node:fs/promises';
import path from 'node:path';

/** The largest portrait file the server reads. */
export const PORTRAIT_MAX_BYTES = 2 * 1024 * 1024;

export type PortraitType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif';

export interface Portrait {
  type: PortraitType;
  bytes: Buffer;
}

const TYPE_BY_EXTENSION: Record<string, PortraitType> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

/** The opt-in portrait file: `AGENTS_OFFICE_PORTRAIT`, else none. */
export function portraitPathFrom(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env.AGENTS_OFFICE_PORTRAIT?.trim();
  return value ? value : null;
}

/** The image type the first bytes prove, or null. */
function sniff(bytes: Buffer): PortraitType | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (bytes.length >= 12 && bytes.toString('latin1', 0, 4) === 'RIFF' && bytes.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.toString('latin1', 0, 6))) return 'image/gif';
  return null;
}

/**
 * Read the portrait file, or null. The file must be a regular file of at most
 * `PORTRAIT_MAX_BYTES`, with a raster image extension, and its first bytes must
 * prove the same type. SVG is never served (it can hold scripts).
 */
export async function readPortrait(file: string | null): Promise<Portrait | null> {
  if (!file) return null;
  const expected = TYPE_BY_EXTENSION[path.extname(file).toLowerCase()];
  if (!expected) return null;
  try {
    const info = await stat(file);
    if (!info.isFile() || info.size === 0 || info.size > PORTRAIT_MAX_BYTES) return null;
    const handle = await open(file, 'r');
    try {
      // Read one byte past the checked size: a file that grew after the check is refused
      const buffer = Buffer.alloc(info.size + 1);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      if (bytesRead > info.size) return null;
      const bytes = buffer.subarray(0, bytesRead);
      return sniff(bytes) === expected ? { type: expected, bytes } : null;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}
