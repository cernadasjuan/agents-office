import assert from 'node:assert/strict';
import { test } from 'node:test';
import { JSDOM } from 'jsdom';
import { FloorSwitch } from '../src/ui/FloorSwitch.js';
import { ALL_FLOORS } from '../src/floors/FloorRegistry.js';

function mount(): { root: HTMLElement } {
  const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>');
  const root = dom.window.document.getElementById('root')!;
  return { root };
}

test('opens with "all floors" first, then the focused floor and general (always offered, even with zero other agents known yet)', () => {
  const { root } = mount();
  new FloorSwitch(root, 'agents-office', { onSelect: () => undefined });
  const options = Array.from(root.querySelectorAll('option')).map((o) => o.textContent);
  assert.deepEqual(options, [ALL_FLOORS, 'agents-office', 'general']);
});

test('"all floors" shows as selected when it is the focused choice', () => {
  const { root } = mount();
  const switcher = new FloorSwitch(root, ALL_FLOORS, { onSelect: () => undefined });
  switcher.render([{ floor: 'agents-office' }, { floor: 'widget-service' }]);

  const options = Array.from(root.querySelectorAll('option'));
  assert.deepEqual(options.map((o) => o.value), [ALL_FLOORS, 'agents-office', 'widget-service', 'general']);
  assert.equal(options.find((o) => o.value === ALL_FLOORS)!.selected, true);
});

test('render lists "all floors" first, then every floor with a tracked session, general last, keeping the focused one selected', () => {
  const { root } = mount();
  const switcher = new FloorSwitch(root, 'agents-office', { onSelect: () => undefined });

  switcher.render([{ floor: 'agents-office' }, { floor: 'widget-service' }, {}]);

  const options = Array.from(root.querySelectorAll('option'));
  assert.deepEqual(options.map((o) => o.value), [ALL_FLOORS, 'agents-office', 'widget-service', 'general']);
  assert.equal(options.find((o) => o.value === 'agents-office')!.selected, true);
  assert.equal(options.find((o) => o.value === 'widget-service')!.selected, false);
  assert.equal(options.find((o) => o.value === ALL_FLOORS)!.selected, false);
});

test('a floor the user just switched to still shows as the selected option, even with zero sessions yet', () => {
  const { root } = mount();
  const switcher = new FloorSwitch(root, 'widget-service', { onSelect: () => undefined });

  switcher.render([{ floor: 'agents-office' }]);

  const options = Array.from(root.querySelectorAll('option'));
  assert.ok(options.some((o) => o.value === 'widget-service' && o.selected));
});

test('choosing a different floor calls onSelect once with that floor name', () => {
  const { root } = mount();
  let chosen: string | null = null;
  const switcher = new FloorSwitch(root, 'agents-office', { onSelect: (floor) => { chosen = floor; } });
  switcher.render([{ floor: 'agents-office' }, { floor: 'widget-service' }]);

  const select = root.querySelector('select')!;
  select.value = 'widget-service';
  select.dispatchEvent(new (root.ownerDocument.defaultView as unknown as { Event: typeof Event }).Event('change'));

  assert.equal(chosen, 'widget-service');
});

test('re-choosing the already-focused floor does not call onSelect (a same-floor no-op)', () => {
  const { root } = mount();
  let calls = 0;
  const switcher = new FloorSwitch(root, 'agents-office', { onSelect: () => { calls++; } });
  switcher.render([{ floor: 'agents-office' }]);

  const select = root.querySelector('select')!;
  select.value = 'agents-office';
  select.dispatchEvent(new (root.ownerDocument.defaultView as unknown as { Event: typeof Event }).Event('change'));

  assert.equal(calls, 0);
});
