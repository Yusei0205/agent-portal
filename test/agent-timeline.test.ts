/**
 * The Agents Timeline's pure parts (web/src/lib/agent-timeline.js): how long something ran, and the bursts of activity
 * agents are grouped into so that a session spanning days still shows each agent's bar at a readable size.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error — plain JS module without type declarations
import { formatDuration, timelineBursts, barBox, scaleTicks, BURST_GAP_MS } from '../web/src/lib/agent-timeline.js';

const MIN = 60_000;
const span = (startMin: number, endMin: number, id = `${startMin}-${endMin}`) => ({ id, start: startMin * MIN, end: endMin * MIN });

describe('formatDuration', () => {
  it('says seconds, minutes and seconds, hours and minutes, days and hours', () => {
    assert.equal(formatDuration(0), '0s');
    assert.equal(formatDuration(400), '<1s');
    assert.equal(formatDuration(45_000), '45s');
    assert.equal(formatDuration(281_000), '4m 41s');
    assert.equal(formatDuration(60_000), '1m 0s');
    assert.equal(formatDuration(72 * MIN), '1h 12m');
    assert.equal(formatDuration((27 * 60 + 5) * MIN), '1d 3h');
  });
  it('gives nothing for a time that cannot be shown', () => {
    assert.equal(formatDuration(NaN), '');
    assert.equal(formatDuration(-5), '');
  });
});

describe('timelineBursts', () => {
  it('keeps agents that ran close together in one burst, with its own start and end', () => {
    const b = timelineBursts([span(0, 4), span(1, 6), span(8, 9)]);
    assert.equal(b.length, 1);
    assert.deepEqual([b[0].start, b[0].end, b[0].items.length, b[0].pauseBefore], [0, 9 * MIN, 3, 0]);
  });

  it('starts a new burst after a pause longer than the gap, and says how long the pause was', () => {
    const day = 24 * 60;
    const b = timelineBursts([span(0, 5), span(day, day + 11), span(day + 2, day + 9)]);
    assert.equal(b.length, 2);
    assert.equal(b[1].pauseBefore, (day - 5) * MIN);
    assert.equal(b[1].items.length, 2);
    // the second burst is scaled to its own 11 minutes, not to the day between
    assert.equal(b[1].total, 11 * MIN);
  });

  it('puts a pause of exactly the gap in the same burst, and one a second longer in a new one', () => {
    assert.equal(timelineBursts([span(0, 1), { start: MIN + BURST_GAP_MS, end: MIN + BURST_GAP_MS + 1000 }]).length, 1);
    assert.equal(timelineBursts([span(0, 1), { start: MIN + BURST_GAP_MS + 1000, end: MIN + BURST_GAP_MS + 2000 }]).length, 2);
  });

  it('orders by start whatever order the agents come in, and copes with none', () => {
    const b = timelineBursts([span(5, 6, 'late'), span(0, 1, 'early')]);
    assert.deepEqual(b[0].items.map((s: { id: string }) => s.id), ['early', 'late']);
    assert.deepEqual(timelineBursts([]), []);
  });

  it('gives an instant burst a scale to draw on', () => {
    assert.equal(timelineBursts([{ start: 5000, end: 5000 }])[0].total, 1000);
  });
});

describe('barBox', () => {
  const burst = timelineBursts([span(0, 10)])[0];

  it('places a bar by where it starts and how long it ran on the burst scale', () => {
    const { left, width } = barBox(span(2, 7), burst);
    assert.equal(left, 20);
    assert.equal(width, 50);
  });

  it('never makes a bar thinner than the minimum or lets it run past the end', () => {
    assert.equal(barBox({ start: 5 * MIN, end: 5 * MIN }, burst).width, 1.5);
    const edge = barBox({ start: 10 * MIN, end: 10 * MIN }, burst);
    assert.ok(edge.left + edge.width <= 100 + 1e-9);
  });

  it('shows a four-minute agent at a readable width on a day-long session, once bursts are used', () => {
    const day = 24 * 60;
    const bursts = timelineBursts([span(0, 5), span(day, day + 5)]);
    for (const b of bursts) assert.ok(barBox(b.items[0], b).width >= 99, 'it fills its own burst');
    // on a single axis over the whole session it would have been a sliver
    assert.ok((5 / (day + 5)) * 100 < 1);
  });
});

describe('scaleTicks', () => {
  it('labels the elapsed time at 0, 25, 50, 75 and 100% of a burst', () => {
    assert.deepEqual(scaleTicks(4 * MIN), ['0s', '1m 0s', '2m 0s', '3m 0s', '4m 0s']);
    assert.equal(scaleTicks(8 * 1000).length, 5);
  });
});
