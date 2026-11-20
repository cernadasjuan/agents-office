import assert from 'node:assert/strict';
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
