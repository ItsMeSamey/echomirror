import test from 'node:test';
import assert from 'node:assert/strict';
import { planCourseLectures } from '../dist/impl/mirror.js';

function lesson(id, date, name) {
  return {
    lesson: {
      lesson: { id, sectionId: 's1', displayName: name, name, createdAt: date, timing: { start: date } },
      hasVideo: true,
      startTimeUTC: date,
    },
    type: 'SyllabusLessonType',
  };
}

test('lecture numbers reset within each teaching week after sorting', () => {
  const course = {
    id: '2026_1:comp4403', year: '2026', semester: '1', yearSemester: '2026_1', course: 'comp4403',
    termStart: '2026-02-23T00:00:00Z', sectionIds: ['s1'],
  };
  const result = planCourseLectures(course, [
    lesson('b', '2026-02-24T10:00:00Z', 'Lecture 2 - Parsing'),
    lesson('a', '2026-02-23T10:00:00Z', 'Lecture 1 - Introduction'),
    lesson('c', '2026-03-02T10:00:00Z', 'Lecture 3 - Semantics'),
  ]);
  assert.deepEqual(result.map(item => [item.id, item.weekNumber, item.lectureNumber, item.lectureName]), [
    ['a', 1, 1, 'introduction'],
    ['b', 1, 2, 'parsing'],
    ['c', 2, 1, 'semantics'],
  ]);
});

test('infers year/semester from lesson dates when enrollment term metadata is missing', () => {
  const course = {
    id: 'unknown_unknown:comp2701', year: 'unknown', semester: 'unknown', yearSemester: 'unknown_unknown', course: 'comp2701',
    sectionIds: ['s1'],
  };
  const result = planCourseLectures(course, [
    lesson('a', '2026-02-23T10:00:00Z', 'COMP2701_S1_2026_STLUCIA_22477_IN_01'),
    lesson('b', '2026-03-09T10:00:00Z', 'COMP2701_S1_2026_STLUCIA_22477_IN_01'),
  ]);
  assert.deepEqual(result.map(item => [item.yearSemester, item.weekNumber, item.lectureName]), [
    ['2026_1', 1, 'lecture'],
    ['2026_1', 3, 'lecture'],
  ]);
});
