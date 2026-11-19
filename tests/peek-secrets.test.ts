import assert from 'node:assert/strict';
import { test } from 'node:test';
import { maskSecrets } from '../server/secrets.js';

// Every token below is fake: the right shape, random filler, never a real credential.
const FAKE = {
  ghp: 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8',
  pat: 'github_pat_' + '11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyzABCDEF',
  slack: 'xoxb-' + '123456789012-1234567890123-AbCdEfGhIjKlMnOpQrStUvWx',
  anthropic: 'sk-ant-' + 'api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789',
  aws: 'AKIA' + 'ABCDEFGHIJKLMNOP',
  hex: '0123456789abcdef0123456789abcdef01234567',
  base64: 'dGhpcyBpcyBhIGZha2Ugc2VjcmV0IHZhbHVlIDEyMzQ1Njc4OTA=',
  jwt: 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlX2Zha2VfdmFsdWU',
  email: 'jane.doe@example.com',
};

test('known token shapes are masked', () => {
  for (const [kind, token] of Object.entries(FAKE)) {
    const masked = maskSecrets(`before ${token} after`);
    assert.equal(masked.includes(token), false, `${kind} stays visible: ${masked}`);
    assert.match(masked, /^before \[[a-z ]+\] after$/, kind);
  }
});

test('an email is masked as [email]', () => {
  assert.equal(maskSecrets('mail jane.doe@example.com now'), 'mail [email] now');
});

test('a private key block is masked as a whole, also when it has no end line', () => {
  const block = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAA\nAAAAAAAA\n-----END OPENSSH PRIVATE KEY-----';
  assert.equal(maskSecrets(`key: ${block} done`), 'key: [private key] done');
  assert.equal(maskSecrets('-----BEGIN RSA PRIVATE KEY-----\nMIIEow'), '[private key]');
});

test('key=value and bearer secrets keep the key and lose the value', () => {
  assert.equal(maskSecrets('export API_KEY=abc123def456'), 'export API_KEY=[secret]');
  assert.equal(maskSecrets('password: "hunter2hunter2"'), 'password: [secret]');
  assert.equal(maskSecrets('Authorization: Bearer abcdefghijklmnop1234'), 'Authorization: Bearer [secret]');
});

test('ordinary text, paths, issue keys and short numbers stay as they are', () => {
  for (const text of [
    'Run the tests in /Users/someone/Developer/projects/agents-office-worktrees/80-peek-plugin',
    'Fix KTP-1453 and close #80 on agents-office',
    'The build took 12345 ms with 3 warnings',
    'implementing-the-agent-card-section-for-recent-lines',
  ]) {
    assert.equal(maskSecrets(text), text);
  }
});
