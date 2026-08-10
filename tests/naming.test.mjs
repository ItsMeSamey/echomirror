import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRecordingPath, weekNumberForDate, yearSemesterFromData, courseCodeFromData } from '../dist/impl/naming.js';

const data = {
  context: { courseId: 'x' },
  sectionInfo: {
    label: 'COMP4403',
    course: { courseIdentifier: 'COMP4403', courseName: 'Compilers and Interpreters' },
    term: { name: 'Semester 2, 2025', session: { startDate: '2025-07-21T00:00:00Z' } },
  },
  lesson: { displayName: 'Lecture 1 - Introduction', name: 'Lecture 1' },
  viewEmbedInfo: { mediaName: 'Introduction' },
  title: 'Lecture 1 - Introduction',
};

test('UQ output path matches mirror convention', () => {
  assert.equal(yearSemesterFromData(data), '2025_2');
  assert.equal(courseCodeFromData(data), 'comp4403');
  assert.equal(buildRecordingPath(data, { weekNumber: 1, lectureNumber: 1, syllabusName: 'Lecture 1 - Introduction' }),
    '2025_2/comp4403/recordings/01_01_introduction.mp4');
});

test('week numbering is one-based from term start', () => {
  assert.equal(weekNumberForDate(new Date('2025-07-21T09:00:00Z'), new Date('2025-07-21T00:00:00Z')), 1);
  assert.equal(weekNumberForDate(new Date('2025-07-28T09:00:00Z'), new Date('2025-07-21T00:00:00Z')), 2);
});

import { lectureNameFromText, termParts } from '../dist/impl/naming.js';

test('compact UQ section labels yield semester metadata but not fake lecture names', () => {
  assert.deepEqual(termParts('COMP2701_S1_2026_STLUCIA_22477_IN_01'), {
    year: '2026', semester: '1', yearSemester: '2026_1',
  });
  assert.equal(lectureNameFromText('COMP2701_S1_2026_STLUCIA_22477_IN_01'), 'lecture');
});
