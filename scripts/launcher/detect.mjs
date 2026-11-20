// Server detection for the macOS launcher: tells a cold start (nothing answers the port) from
// a warm start (the fork's dev server already answers it), so the launcher never starts a
// second server.

/** The port the fork dev server binds, same default as vite.config.ts and bin/cli.mjs. */
export const DEFAULT_PORT = 5173;

/**
 * True when something answers HTTP on the office port. Any response (even a non-2xx one)
 * means a server is listening; a thrown error (connection refused, timeout) means it is not.
 * `fetchImpl` is injectable so tests never open a real socket.
 */
export async function isServerRunning(port = DEFAULT_PORT, { timeoutMs = 800, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`http://127.0.0.1:${port}/api/agents`, { signal: controller.signal });
    return typeof response.status === 'number';
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
