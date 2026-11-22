import assert from 'node:assert/strict';
import { test } from 'node:test';
import { componentForRepo } from '../src/addons/building/componentWing.js';

test('a frontend/portal repo maps to the portal wing', () => {
  assert.equal(componentForRepo('app-front-portal'), 'portal');
});

test('an agent/office/proxi repo maps to the agents wing', () => {
  assert.equal(componentForRepo('agents-office'), 'agents');
  assert.equal(componentForRepo('app-agent-hub'), 'agents');
  assert.equal(componentForRepo('proxi-hermes'), 'agents');
});

test('a DAC/terraform/infra repo maps to the infra wing', () => {
  assert.equal(componentForRepo('grp-dac-proximity-report'), 'infra');
  assert.equal(componentForRepo('klever-terraform-infra'), 'infra');
});

test('everything else, including an unmapped backend service, falls to the tooling default wing', () => {
  assert.equal(componentForRepo('app-proximity-report'), 'tooling');
  assert.equal(componentForRepo('claude-dev-settings'), 'tooling');
  assert.equal(componentForRepo(undefined), 'tooling');
});

test('infra is checked before the other wings, for a repo name that could match more than one', () => {
  // A DAC whose own name happens to carry "agent" too: deploy plumbing is the more specific signal.
  assert.equal(componentForRepo('grp-dac-agent-config'), 'infra');
});
