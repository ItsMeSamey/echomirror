import test from 'node:test';
import assert from 'node:assert/strict';
import { lectureNameFromText, termParts, weekNumberForDate } from '../dist/impl/naming.js';

test('week numbering is one-based from term start', () => {
  assert.equal(weekNumberForDate(new Date('2025-07-21T09:00:00Z'), new Date('2025-07-21T00:00:00Z')), 1);
  assert.equal(weekNumberForDate(new Date('2025-07-28T09:00:00Z'), new Date('2025-07-21T00:00:00Z')), 2);
});

test('compact UQ section labels yield semester metadata but not fake lecture names', () => {
  assert.deepEqual(termParts('COMP2701_S1_2026_STLUCIA_22477_IN_01'), {
    year: '2026', semester: '1', yearSemester: '2026_1',
  });
  assert.equal(lectureNameFromText('COMP2701_S1_2026_STLUCIA_22477_IN_01'), 'lecture');
});
