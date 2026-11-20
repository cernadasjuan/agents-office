// Server detection for the macOS launcher: tells a cold start (nothing answers the port) from
// a warm start (the fork's dev server already answers it) from a port busy with some other
// app, so the launcher never starts a second server and never opens the wrong one.
//
// Checks the office root `/`, not `/api/agents`: the agents endpoint can take over 400 ms
// when herdr enrichment runs, which could read a live, slow office as not running. The root
// page is static HTML vite serves at once, so a ~1 s timeout is generous, not tight.

/** The port the fork dev server binds, same default as vite.config.ts and bin/cli.mjs. */
export const DEFAULT_PORT = 5173;

// Two independent markers from index.html. Both must match: either alone could appear on an
// unrelated page by coincidence (a generic app also named "Agents Office" in its <title>, or
// a dashboard that happens to use the same element id).
const OFFICE_TITLE = '<title>Agents Office</title>';
const OFFICE_PANEL_ID = 'id="ui-panel"';

/** True when a page body is this office's own `index.html`, not some other app on the port. */
export function isOfficeHtml(html) {
  return typeof html === 'string' && html.includes(OFFICE_TITLE) && html.includes(OFFICE_PANEL_ID);
}

/**
 * Probes the office port. `reachable` is false only on a connection error or a timeout before
 * any answer arrives at all (the cold-start case: nothing is listening). `isOffice` is true
 * only when a reachable answer is this office's own HTML (the warm-start case); a reachable
 * answer that is not the office's HTML means another app already holds the port.
 *
 * A server that sends headers, then stalls or resets mid-body (a body-read failure, caught
 * separately below) still counts as `reachable`, not down: something is listening on the
 * port, the launcher just could not read enough of it to confirm the office. `fetchImpl` is
 * injectable so tests never open a real socket, except the one test that deliberately does,
 * against a raw TCP server that stalls its body on purpose.
 */
export async function probeOffice(port = DEFAULT_PORT, { timeoutMs = 1000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let response;
    try {
      response = await fetchImpl(`http://127.0.0.1:${port}/`, { signal: controller.signal });
    } catch {
      return { reachable: false, isOffice: false };
    }
    if (typeof response.status !== 'number') return { reachable: false, isOffice: false };
    try {
      const html = typeof response.text === 'function' ? await response.text() : '';
      return { reachable: true, isOffice: isOfficeHtml(html) };
    } catch {
      return { reachable: true, isOffice: false };
    }
  } finally {
    clearTimeout(timer);
  }
}
