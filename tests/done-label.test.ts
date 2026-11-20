import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACTIVITY_LABELS, activityLabel, activityLabelFor, STUCK_LABEL } from '../src/agents/AgentData.js';

test('a subagent at rest has finished its task: it reads "Done"', () => {
  assert.equal(activityLabel({ activity: 'idle', extras: { parentId: 'main' } }), 'Done');
  assert.equal(activityLabelFor('idle', true), 'Done');
});

test('a main agent at rest, or a busy subagent, keeps the activity label', () => {
  assert.equal(activityLabel({ activity: 'idle' }), ACTIVITY_LABELS.idle);
  assert.equal(activityLabel({ activity: 'idle', extras: {} }), 'Taking a break');
  assert.equal(activityLabel({ activity: 'testing', extras: { parentId: 'main' } }), 'Running tests');
});

test('a stuck agent reads "Stuck?" in the panel row, in place of its activity', () => {
  assert.equal(activityLabel({ activity: 'implementing', extras: { stuck: true } }), STUCK_LABEL);
  assert.equal(activityLabel({ activity: 'implementing', extras: { stuck: false } }), 'Implementing');
  assert.equal(activityLabel({ activity: 'implementing', extras: {} }), 'Implementing');
});
