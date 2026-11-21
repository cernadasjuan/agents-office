import assert from 'node:assert/strict';
import net from 'node:net';
import { test } from 'node:test';
import { isOfficeHtml, probeOffice } from '../scripts/launcher/detect.mjs';

const OFFICE_HTML = '<!doctype html><html><head><title>Agents Office</title></head><body><div id="ui-panel"></div></body></html>';

function jsonResponse(status: number, text = ''): Response {
  return { status, text: async () => text } as unknown as Response;
}

test('isOfficeHtml is true only for this office’s own index.html', () => {
  assert.equal(isOfficeHtml(OFFICE_HTML), true);
  assert.equal(isOfficeHtml('<title>Agents Office</title>'), false, 'title alone is not enough');
  assert.equal(isOfficeHtml('<div id="ui-panel"></div>'), false, 'the id alone is not enough');
  assert.equal(isOfficeHtml('<title>Some Other Vite App</title><div id="ui-panel"></div>'), false);
  assert.equal(isOfficeHtml(''), false);
});

test('probeOffice: reachable and the office, on a 2xx answer with the office markers (warm start)', async () => {
  const fetchImpl = (async () => jsonResponse(200, OFFICE_HTML)) as typeof fetch;
  assert.deepEqual(await probeOffice(5173, { fetchImpl }), { reachable: true, isOffice: true });
});

test('probeOffice: reachable and the office even on a non-2xx answer, as long as the markers are there', async () => {
  const fetchImpl = (async () => jsonResponse(500, OFFICE_HTML)) as typeof fetch;
  assert.deepEqual(await probeOffice(5173, { fetchImpl }), { reachable: true, isOffice: true });
});

test('probeOffice: reachable but not the office when another app answers on the port', async () => {
  const fetchImpl = (async () => jsonResponse(200, '<title>Some Other Vite App</title>')) as typeof fetch;
  assert.deepEqual(await probeOffice(5173, { fetchImpl }), { reachable: true, isOffice: false });
});

test('probeOffice: not reachable when the connection is refused (cold start)', async () => {
  const fetchImpl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  assert.deepEqual(await probeOffice(5173, { fetchImpl }), { reachable: false, isOffice: false });
});

test('probeOffice: not reachable when the request times out (a slow office never misreads as down)', async () => {
  const fetchImpl: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }) as Promise<Response>;
  assert.deepEqual(await probeOffice(5173, { timeoutMs: 20, fetchImpl }), { reachable: false, isOffice: false });
});

test('probeOffice: headers and body have independent budgets — slow headers do not eat into the body read', async () => {
  // Headers take almost the entire headers budget to arrive; the body then reads instantly.
  // With one shared budget this would fail (the body read starting with no time left). With
  // the two budgets split, the body gets its own full window once the headers land, so a
  // slow-but-live office still counts as the office for Gabriel.
  const fetchImpl: typeof fetch = async (_input, init) => {
    await new Promise((resolve) => setTimeout(resolve, 30));
    if (init?.signal?.aborted) throw new Error('aborted before headers arrived');
    return jsonResponse(200, OFFICE_HTML);
  };
  assert.deepEqual(await probeOffice(5173, { timeoutMs: 40, bodyTimeoutMs: 40, fetchImpl }), { reachable: true, isOffice: true });
});

test('probeOffice: reachable but not the office when the body read itself fails (headers arrived, the body did not)', async () => {
  const fetchImpl = (async () => ({
    status: 200,
    text: async () => {
      throw new Error('body read reset');
    },
  })) as unknown as typeof fetch;
  assert.deepEqual(await probeOffice(5173, { fetchImpl }), { reachable: true, isOffice: false });
});

/**
 * The real-world case the mock above stands in for: something is listening on the port and
 * answers with valid HTTP headers (status 200, `Content-Length` promising more than it ever
 * sends), then never sends the rest of the body and never closes the connection. A real
 * `fetch()` resolves the headers, but reading the body hangs until `probeOffice`'s own
 * `AbortController` fires. Binds to an OS-assigned port (never 5173), never writes past the
 * header line itself, and closes the raw socket in `finally` so nothing lingers.
 *
 * `timeoutMs` (the headers budget) is left generous and default-sized: real headers land in a
 * single loopback write, so even full-suite CPU contention leaves it comfortable. `bodyTimeoutMs`
 * (the body budget) is set tiny and given on its own: `probeOffice` only starts that timer once
 * the headers above have actually arrived, so this never races header delivery against anything
 * — it is a deterministic, injected budget for a body that never arrives, not a guess at how
 * long the round trip might take under load.
 */
test('probeOffice: a raw TCP server that sends headers then stalls the body counts as reachable, not down', async () => {
  const sockets: net.Socket[] = [];
  const server = net.createServer((socket) => {
    sockets.push(socket);
    socket.write('HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: 1000\r\n\r\n<ht');
    // Deliberately never writes the rest of the body and never ends the socket.
  });
  // Server readiness is explicit: this resolves only on the `listening` event, so `probeOffice`
  // below never connects before the OS has actually bound and accepted on the port.
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a bound TCP address');
  try {
    const result = await probeOffice(address.port, { bodyTimeoutMs: 50 });
    assert.deepEqual(result, { reachable: true, isOffice: false });
  } finally {
    // `server.close()` alone waits forever for a connection nobody ever ends; the stalled
    // socket above is exactly that connection, so it is destroyed by hand first.
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
