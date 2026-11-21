import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cutBeforePlaceholder, lastWords, maskedLine, maskSecrets } from '../server/secrets.js';
import { projectBubble, projectPeek } from '../server/seam.js';

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

test('JSON-quoted secret keys are masked', () => {
  const masked = maskSecrets('{"password": "JsonPw9xQ2", "client_secret":"Cs8kL2mN4pQ6rS8t", "access_token":"tok_abcdef12", \'apiKey\': \'Ak9zz88q\'}');
  for (const secret of ['JsonPw9xQ2', 'Cs8kL2mN4pQ6rS8t', 'tok_abcdef12', 'Ak9zz88q']) assert.equal(masked.includes(secret), false, `${secret}: ${masked}`);
  assert.match(masked, /"password": \[secret\]/);
});

test('connection-string passwords are masked for any host', () => {
  assert.equal(maskSecrets('postgres://admin:LocalPw7Zq@localhost:5432/app'), 'postgres://admin:[secret]@localhost:5432/app');
  assert.equal(maskSecrets('redis://:RedisPw1@cache/0'), 'redis://:[secret]@cache/0');
});

test('AWS secret access keys with slashes are masked', () => {
  const docs = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
  assert.equal(maskSecrets(`aws_secret ${docs} end`), 'aws_secret [secret] end');
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  let seed = 7;
  const random = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed >>> 16; };
  let leaked = 0;
  for (let i = 0; i < 200; i++) {
    const key = Array.from({ length: 40 }, () => chars[random() % 64]).join('');
    if (maskSecrets(`k ${key} e`).includes(key)) leaked++;
  }
  assert.equal(leaked, 0, `${leaked} of 200 random keys leaked`);
});

test('more token shapes: GitLab runner, deploy and trigger tokens, Slack webhooks', () => {
  for (const token of ['glrt-' + 'AbCdEf123456GhIjKl78', 'gldt-' + 'AbCdEf123456GhIjKl78', 'glptt-' + 'abcdef0123456789abcd']) {
    assert.equal(maskSecrets(`x ${token} y`), 'x [secret] y', token);
  }
  const hook = 'https://hooks.slack.com/services/' + 'T0ABCDEFG/B0ABCDEFG/abcdefghijklmnopqrstuvwx';
  assert.equal(maskSecrets(`post ${hook} now`).includes('abcdefghijklmnopqrstuvwx'), false);
});

test('command-line passwords and short bearer values are masked', () => {
  assert.equal(maskSecrets('mysql -u root -pS3cret db'), 'mysql -u root -p[secret] db');
  assert.equal(maskSecrets('tool --password S3cret --x'), 'tool --password [secret] --x');
  assert.equal(maskSecrets('tool --password=S3cret'), 'tool --password=[secret]');
  assert.equal(maskSecrets('sshpass -p S3cret ssh host'), 'sshpass -p [secret] ssh host');
  assert.equal(maskSecrets('PGPASSWORD=S3cret psql'), 'PGPASSWORD=[secret] psql');
  assert.equal(maskSecrets('Authorization: Bearer abc123'), 'Authorization: Bearer [secret]');
  assert.equal(maskSecrets('ls -la /tmp && npm -v'), 'ls -la /tmp && npm -v');
});

test('a password phrase after "password:" is masked to the end of the line', () => {
  assert.equal(maskSecrets('password: correct horse battery staple\nnext'), 'password: [secret]\nnext');
});

test('a token split across two lines is masked where both halves look like one token', () => {
  const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const masked = maskSecrets(`${token.slice(0, 20)}\n${token.slice(20)}`);
  assert.equal(masked.includes(token.slice(0, 20)) || masked.includes(token.slice(20)), false, masked);
});

test('maskedLine collapses white space before the raw cut, so no part of a token shows', () => {
  const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const line = maskedLine(`${'\n'.repeat(3980)}${token} tail`, 200);
  assert.equal(line.includes('ghp_'), false, line);
  assert.equal(line, '[secret] tail');
  const controls = maskedLine(`${'\u0001'.repeat(3990)}${token}`, 200);
  assert.equal(controls.includes('ghp_'), false, controls);
});

test('the display cut never cuts a placeholder in half', () => {
  const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  for (let pad = 190; pad <= 199; pad++) {
    const line = maskedLine(`${'x'.repeat(pad)} ${token}`, 200);
    assert.ok(line.length <= 200);
    assert.doesNotMatch(line, /\[(?!secret\])[a-z]*$/, line.slice(-12));
  }
  assert.equal(cutBeforePlaceholder('abc [secret]', 7), 'abc');
  assert.equal(cutBeforePlaceholder('abc [x] def', 7), 'abc [x]');
});

test('lastWords (issue #81 review): keeps the end, not the start, cut at a word boundary with a leading ellipsis', () => {
  const text = 'the opening sentence goes on for a while before THE ACTUAL LAST WORDS appear';
  const cut = lastWords(text, 30);
  assert.ok(cut.length <= 30, cut);
  assert.ok(cut.startsWith('…'), cut);
  assert.ok(cut.endsWith('THE ACTUAL LAST WORDS appear'), cut);
  assert.equal(cut.includes('opening sentence'), false, cut);
});

test('lastWords: text already within the limit is returned unchanged, no ellipsis added', () => {
  assert.equal(lastWords('short', 40), 'short');
  assert.equal(lastWords('exactly forty characters long, no more!', 40), 'exactly forty characters long, no more!');
});

test('lastWords: a cut that would split a mask placeholder in half drops the fragment, not half a token', () => {
  const text = `some words before the token ghp_${'a'.repeat(40)} and some words after`;
  const masked = maskSecrets(text);
  assert.ok(masked.includes('[secret]'));
  const cut = lastWords(masked, 20);
  assert.doesNotMatch(cut, /^…?[a-z]*\]/, cut);
  assert.equal(cut.includes('ecret]'), false, cut);
});

test('projectBubble keeps the last words for a text bubble, masked, within the 40-character cap', () => {
  const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const bubble = projectBubble({ kind: 'text', text: `opening words then a token ${token} then THE LAST WORDS HERE` });
  assert.ok(bubble);
  assert.ok(bubble!.text.length <= 40, bubble!.text);
  assert.ok(bubble!.text.endsWith('THE LAST WORDS HERE'), bubble!.text);
  assert.equal(bubble!.text.includes(token), false);
  assert.equal(bubble!.text.includes('opening words'), false);
});

test('projectPeek masks again and keeps only https assets without credentials', () => {
  const token = 'ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
  const peek = projectPeek({
    lines: [{ kind: 'text', text: `raw ${token}` }],
    question: `q ${token}`,
    assets: [
      { kind: 'issue', label: 'ok', url: 'https://github.com/o/r/issues/1' },
      { kind: 'issue', label: 'http', url: 'http://github.com/o/r/issues/2' },
      { kind: 'issue', label: 'js', url: 'javascript:alert(1)' },
      { kind: 'mr', label: 'creds', url: 'https://user:pw@gitlab.example/x/-/merge_requests/3' },
    ],
    skills: ['tdd', '../evil'],
    repos: ['agents-office', '/private/path'],
  });
  assert.equal(JSON.stringify(peek).includes(token), false);
  assert.equal(peek.lines[0].text, 'raw [secret]');
  assert.equal(peek.question, 'q [secret]');
  assert.deepEqual(peek.assets.map((asset) => asset.label), ['ok']);
  assert.deepEqual(peek.skills, ['tdd']);
  assert.deepEqual(peek.repos, ['agents-office']);
});
