import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createServer, type Plugin, type ViteDevServer } from 'vite';
import { agentDetectorPlugin } from '../server/vitePlugin.js';
import { PORTRAIT_MAX_BYTES, portraitPathFrom, readPortrait } from '../server/portrait.js';

// Synthetic image bytes only: no test reads a real picture.
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64, 2)]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 '), Buffer.alloc(32, 3)]);

const resources: Array<{ server?: ViteDevServer; dir: string }> = [];
after(async () => {
  for (const { server, dir } of resources) {
    await server?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'agents-office-portrait-test-'));
  resources.push({ dir });
  return dir;
}

async function fileWith(name: string, bytes: Buffer): Promise<string> {
  const file = path.join(await tempDir(), name);
  await writeFile(file, bytes);
  return file;
}

interface Response { status: number; headers: http.IncomingHttpHeaders; body: Buffer }

async function portraitServer(portraitPath: string | null, beforePlugin?: Plugin) {
  const root = await tempDir();
  const server = await createServer({
    root, configFile: false, envFile: false,
    plugins: [...(beforePlugin ? [beforePlugin] : []), agentDetectorPlugin({ detect: () => [], codexHome: null, portraitPath })],
    server: { host: '127.0.0.1', port: 0, open: false, watch: null, ws: false },
    optimizeDeps: { noDiscovery: true, include: [] },
    logLevel: 'silent',
  });
  resources.push({ server, dir: root });
  await server.listen();
  const port = (server.httpServer!.address() as AddressInfo).port;
  const request = (headers: Record<string, string> = {}, method = 'GET', urlPath = '/api/portrait'): Promise<Response> =>
    new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: urlPath, method, headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      });
      req.on('error', reject);
      req.end();
    });
  return { request, origin: `http://127.0.0.1:${port}` };
}

test('the portrait path is opt-in: AGENTS_OFFICE_PORTRAIT, else none', () => {
  assert.equal(portraitPathFrom({}), null);
  assert.equal(portraitPathFrom({ AGENTS_OFFICE_PORTRAIT: '  ' }), null);
  assert.equal(portraitPathFrom({ AGENTS_OFFICE_PORTRAIT: '/tmp/me.png' }), '/tmp/me.png');
});

test('without a portrait file the route answers 204 with no body, so the browser shows the placeholder without an error', async () => {
  const { request, origin } = await portraitServer(null);
  const response = await request({ Origin: origin });
  assert.equal(response.status, 204);
  assert.equal(response.body.length, 0);
});

test('a PNG, JPEG or WebP portrait comes back with its own image type and no-store, nosniff headers', async () => {
  for (const [name, bytes, type] of [['me.png', PNG, 'image/png'], ['me.jpg', JPEG, 'image/jpeg'], ['me.webp', WEBP, 'image/webp']] as const) {
    const { request, origin } = await portraitServer(await fileWith(name, bytes));
    const response = await request({ Origin: origin });
    assert.equal(response.status, 200, name);
    assert.equal(response.headers['content-type'], type);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    assert.deepEqual(response.body, bytes);
  }
});

test('a file that is not an image, a mislabeled file, an SVG, a folder, a missing file or an oversized file is never served', async () => {
  const dir = await tempDir();
  await mkdir(path.join(dir, 'folder.png'));
  const cases = [
    await fileWith('notes.txt', Buffer.from('secret notes')),
    await fileWith('fake.png', Buffer.from('not really a png, plain text')),
    await fileWith('jpeg-named.png', JPEG),
    await fileWith('vector.svg', Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')),
    path.join(dir, 'folder.png'),
    path.join(dir, 'missing.png'),
    await fileWith('huge.png', Buffer.concat([PNG, Buffer.alloc(PORTRAIT_MAX_BYTES)])),
  ];
  for (const file of cases) {
    assert.equal(await readPortrait(file), null, path.basename(file));
    const { request, origin } = await portraitServer(file);
    const response = await request({ Origin: origin });
    assert.equal(response.status, 204, path.basename(file));
    assert.equal(response.body.length, 0);
  }
});

test('the portrait route has the same local checks as the API: other origins, other methods and remote clients get nothing', async () => {
  const file = await fileWith('me.png', PNG);
  const { request } = await portraitServer(file);
  for (const Origin of ['https://evil.example', 'http://localhost:1']) {
    const response = await request({ Origin });
    assert.equal(response.status, 403);
    assert.equal(response.body.includes(PNG.subarray(0, 8)), false);
  }
  assert.equal((await request({}, 'POST')).status, 405);
  assert.equal((await request({}, 'GET', '/api/portrait/other')).status, 404);
  const remote: Plugin = {
    name: 'synthetic-remote-client',
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        Object.defineProperty(req.socket, 'remoteAddress', { configurable: true, value: '198.51.100.10' });
        next();
      });
    },
  };
  assert.equal((await (await portraitServer(file, remote)).request()).status, 403);
});
