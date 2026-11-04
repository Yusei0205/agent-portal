import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
// @ts-ignore -- a plain JS module shared with the web app
import { statusSortKey, prioritySortKey } from '../web/src/lib/ticketSort.js';

const natural = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

describe('Jira ticket sort keys', () => {
  test('a status object no longer collapses to the same text', () => {
    assert.notEqual(statusSortKey({ name: 'Done', category: 'done' }), statusSortKey({ name: 'To Do', category: 'new' }));
  });
  test('statuses sort by workflow stage, then by name', () => {
    const rows = [
      { name: 'Done', category: 'done' }, { name: 'In Review', category: 'indeterminate' }, { name: 'To Do', category: 'new' },
      { name: 'In Progress', category: 'indeterminate' }, { name: 'Closed', category: 'done' },
    ];
    const sorted = [...rows].sort((a, b) => natural.compare(statusSortKey(a)!, statusSortKey(b)!)).map((r) => r.name);
    assert.deepEqual(sorted, ['To Do', 'In Progress', 'In Review', 'Closed', 'Done']);
  });
  test('a plain-text status and a missing one are handled', () => {
    assert.equal(statusSortKey('Open'), '1-Open');
    assert.equal(statusSortKey(null), null);
  });
  test('priorities sort from most to least urgent, unknown ones last', () => {
    const sorted = ['Low', 'Highest', 'Medium', 'Lowest', 'High', 'Custom'].sort((a, b) => natural.compare(prioritySortKey(a)!, prioritySortKey(b)!));
    assert.deepEqual(sorted, ['Highest', 'High', 'Medium', 'Low', 'Lowest', 'Custom']);
    assert.equal(prioritySortKey(null), null);
  });
});
