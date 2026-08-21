import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEnrollmentSections } from '../dist/impl/catalog.js';

test('parses nested Echo enrollment records and deduplicates sections', () => {
  const payload = {
    status: 'ok',
    data: [{
      section: { id: 'section-a', sectionNumber: '1', courseId: 'course-a', termId: 'term-a' },
      course: { courseIdentifier: 'COMP4403' },
      term: { name: 'Semester 1, 2026', session: { startDate: '2026-02-23T00:00:00Z' } },
    }, {
      sectionId: 'section-a',
    }, {
      sectionId: 'section-b',
      courseIdentifier: 'CSSE2310',
      termName: 'Semester 2, 2025',
      termStart: '2025-07-21T00:00:00Z',
    }],
  };

  assert.deepEqual(parseEnrollmentSections(payload), [
    { sectionId: 'section-a', termStart: '2026-02-23T00:00:00Z', courseCode: 'COMP4403', termName: 'Semester 1, 2026' },
    { sectionId: 'section-b', termStart: '2025-07-21T00:00:00Z', courseCode: 'CSSE2310', termName: 'Semester 2, 2025' },
  ]);
});


test('inherits course and term metadata into nested enrollment objects', () => {
  const payload = {
    courseIdentifier: 'COMP3506',
    termName: 'Semester 1, 2025',
    termStart: '2025-02-24T00:00:00Z',
    enrollment: { sectionId: 'nested-section' },
  };
  assert.deepEqual(parseEnrollmentSections(payload), [{
    sectionId: 'nested-section',
    termStart: '2025-02-24T00:00:00Z',
    courseCode: 'COMP3506',
    termName: 'Semester 1, 2025',
  }]);
});

import { buildCourseCatalog, selectCourse } from '../dist/impl/catalog.js';

test('groups sections into stable course IDs and selects by ID or unique code', () => {
  const catalog = buildCourseCatalog([
    { sectionId: 'a', courseCode: 'COMP4403', termName: 'Semester 1, 2026', termStart: '2026-02-23T00:00:00Z' },
    { sectionId: 'b', courseCode: 'COMP4403', termName: 'Semester 1, 2026', termStart: '2026-02-23T00:00:00Z' },
    { sectionId: 'c', courseCode: 'CSSE2310', termName: 'Semester 2, 2025', termStart: '2025-07-21T00:00:00Z' },
  ]);
  assert.equal(catalog[0].id, '2026_1:comp4403');
  assert.deepEqual(catalog[0].sectionIds, ['a', 'b']);
  assert.equal(selectCourse(catalog, '2026_1:comp4403').course, 'comp4403');
  assert.equal(selectCourse(catalog, 'csse2310').id, '2025_2:csse2310');
});

test('extracts UQ course and term from compact enrollment labels', () => {
  const catalog = buildCourseCatalog(parseEnrollmentSections({
    data: [{
      sectionId: 'section-compact',
      label: 'COMP2701_S1_2026_STLUCIA_22477_IN_01',
    }],
  }));

  assert.equal(catalog[0].id, '2026_1:comp2701');
  assert.equal(catalog[0].yearSemester, '2026_1');
});

test('HTTP 403 from enrollment fetch is reported as an invalid ./cookies credential', async () => {
  const { fetchEnrollmentSections } = await import('../dist/impl/catalog.js');
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('Forbidden', { status: 403 });
  try {
    await assert.rejects(fetchEnrollmentSections('session=abc'), error => {
      assert.match(error.message, /rejected \.\/cookies with HTTP 403/i);
      assert.match(error.message, /opens a browser/i);
      return true;
    });
  } finally {
    globalThis.fetch = originalFetch;
  }
});
