import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { FRESHNESS, FreshnessFooter, freshnessLevel, freshnessText } from '../src/ui/freshness.js';
import type { PollHealth } from '../src/agents/AgentPoller.js';

const health = (failures: number, lastSuccessAt: number | null = 0): PollHealth => ({ loaded: lastSuccessAt !== null, lastSuccessAt, failures });

test('before the first answer the footer says that the agents load', () => {
  assert.equal(freshnessLevel(health(0, null)), 'loading');
  assert.equal(freshnessText(health(0, null), 5000), 'Loading agents…');
});

test('a good poll shows the age of the data in seconds, then in minutes', () => {
  assert.equal(freshnessLevel(health(0, 1000)), 'ok');
  assert.equal(freshnessText(health(0, 1000), 1000), 'Updated 0 s ago');
  assert.equal(freshnessText(health(0, 1000), 4400), 'Updated 3 s ago');
  assert.equal(freshnessText(health(0, 0), 125_000), 'Updated 2 min ago');
});

test('one failed poll stays calm; two in a row turn amber; five turn red', () => {
  assert.deepEqual(FRESHNESS, { warnAfterFailures: 2, downAfterFailures: 5 });
  assert.equal(freshnessLevel(health(1)), 'ok');
  assert.equal(freshnessLevel(health(2)), 'warn');
  assert.equal(freshnessLevel(health(4)), 'warn');
  assert.equal(freshnessLevel(health(5)), 'down');
  assert.equal(freshnessText(health(2, 0), 9000), 'Updated 9 s ago · retrying');
  assert.equal(freshnessText(health(5, 0), 15_000), 'Server not reachable · updated 15 s ago');
});

test('a server that never answered turns amber at failure 2 before red at failure 5', () => {
  assert.equal(freshnessLevel(health(1, null)), 'loading');
  assert.equal(freshnessLevel(health(2, null)), 'warn');
  assert.equal(freshnessLevel(health(4, null)), 'warn');
  assert.equal(freshnessLevel(health(5, null)), 'down');
  assert.equal(freshnessText(health(2, null), 9000), 'Loading agents… · retrying');
  assert.equal(freshnessText(health(5, null), 15_000), 'Server not reachable');
});

function installFooter(t: TestContext): { element: HTMLElement; window: JSDOM['window'] } {
  const dom = new JSDOM('<!doctype html><html><body><div id="footer"></div></body></html>');
  t.after(() => dom.window.close());
  return { element: dom.window.document.getElementById('footer')!, window: dom.window };
}

test('the footer shows the text and the level, and ticks the age without a new poll', (t) => {
  const { element } = installFooter(t);
  const clock = { now: 1000 };
  let tick: () => void = () => undefined;
  const footer = new FreshnessFooter(element, () => clock.now, (callback) => { tick = callback; });

  assert.equal(element.textContent, 'Loading agents…');
  assert.equal(element.dataset.level, 'loading');

  footer.show(health(0, 1000));
  assert.equal(element.textContent, 'Updated 0 s ago');
  assert.equal(element.dataset.level, 'ok');

  clock.now = 6000;
  tick();
  assert.equal(element.textContent, 'Updated 5 s ago');

  footer.show(health(5, 1000));
  assert.equal(element.dataset.level, 'down');
  assert.equal(element.textContent, 'Server not reachable · updated 5 s ago');

  clock.now = 9000;
  footer.show(health(0, 9000));
  assert.equal(element.dataset.level, 'ok', 'a good answer clears the warning');
});

test('the footer writes text only, never markup', (t) => {
  const { element } = installFooter(t);
  new FreshnessFooter(element, () => 0, () => undefined).show(health(0, 0));

  assert.equal(element.children.length, 0);
  assert.equal(element.innerHTML, 'Updated 0 s ago');
});
