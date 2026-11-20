import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTIVITY_LABELS, activityLabel, activityLabelFor } from '../src/agents/AgentData.js';

test('a subagent at rest has finished its task: it reads "Done"', () => {
  assert.equal(activityLabel({ activity: 'idle', extras: { parentId: 'main' } }), 'Done');
  assert.equal(activityLabelFor('idle', true), 'Done');
});

test('a main agent at rest, or a busy subagent, keeps the activity label', () => {
  assert.equal(activityLabel({ activity: 'idle' }), ACTIVITY_LABELS.idle);
  assert.equal(activityLabel({ activity: 'idle', extras: {} }), 'Taking a break');
  assert.equal(activityLabel({ activity: 'testing', extras: { parentId: 'main' } }), 'Running tests');
});
