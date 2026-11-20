import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isServerRunning } from '../scripts/launcher/detect.mjs';

test('isServerRunning is true when the port answers 2xx', async () => {
  const fetchImpl = (async () => ({ status: 200 }) as Response) as typeof fetch;
  assert.equal(await isServerRunning(5173, { fetchImpl }), true);
});

test('isServerRunning is true for a non-2xx answer too (something is listening)', async () => {
  const fetchImpl = (async () => ({ status: 500 }) as Response) as typeof fetch;
  assert.equal(await isServerRunning(5173, { fetchImpl }), true);
});

test('isServerRunning is false when the connection is refused (cold start)', async () => {
  const fetchImpl = (async () => {
    throw new Error('ECONNREFUSED');
  }) as typeof fetch;
  assert.equal(await isServerRunning(5173, { fetchImpl }), false);
});

test('isServerRunning is false when the request times out', async () => {
  const fetchImpl: typeof fetch = (_input, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }) as Promise<Response>;
  assert.equal(await isServerRunning(5173, { timeoutMs: 20, fetchImpl }), false);
});
