import { fetchJson } from '../utils/common.js';
import logger from '../utils/logger.js';
import { normalizeCourseCode, termParts } from './naming.js';
import { TOKEN_HELP } from './token.js';

export interface EnrollmentSection {
  sectionId: string;
  termStart?: string;
  courseCode?: string;
  termName?: string;
}

export interface CourseCatalogEntry {
  id: string;
  year: string;
  semester: string;
  yearSemester: string;
  course: string;
  termName?: string;
  termStart?: string;
  sectionIds: string[];
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringAt(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function nestedObject(object: JsonObject, key: string): JsonObject | undefined {
  return isObject(object[key]) ? object[key] : undefined;
}

function sectionIdFrom(object: JsonObject): string | undefined {
  const direct = stringAt(object.sectionId) || stringAt(object.sectionID);
  if (direct) return direct;

  const section = nestedObject(object, 'section');
  if (section) return stringAt(section.id) || stringAt(section.sectionId);

  if (stringAt(object.id) && (object.sectionNumber !== undefined || object.courseId !== undefined || object.termId !== undefined)) {
    return stringAt(object.id);
  }
  return undefined;
}

function metadataFrom(object: JsonObject): Omit<EnrollmentSection, 'sectionId'> {
  const course = nestedObject(object, 'course');
  const term = nestedObject(object, 'term');
  const session = term && nestedObject(term, 'session');
  const scalarStrings = Object.entries(object)
    .filter(([, value]) => typeof value === 'string')
    .map(([key, value]) => [key, String(value).trim()] as const)
    .filter(([, value]) => value.length > 0);

  const genericCourse = scalarStrings
    .map(([, value]) => value.match(/(?:^|[^a-z0-9])([a-z]{4}\d{4})(?!\d)/i)?.[1])
    .find(Boolean);
  const genericTerm = scalarStrings
    .map(([, value]) => value)
    .find(value => /(?:^|[^0-9])20\d{2}(?:[^0-9]|$)/.test(value) && /(?:semester|sem|(?:^|[_ .-])s[12](?:[_ .-]|$))/i.test(value));
  const genericStart = scalarStrings
    .filter(([key]) => /(?:term|session|start).*date|date.*(?:term|session|start)/i.test(key))
    .map(([, value]) => value)
    .find(value => !Number.isNaN(new Date(value).getTime()));

  return {
    courseCode: stringAt(course?.courseIdentifier) || stringAt(object.courseIdentifier) || stringAt(object.courseCode) || genericCourse,
    termName: stringAt(term?.name) || stringAt(object.termName) || genericTerm,
    termStart: stringAt(session?.startDate) || stringAt(term?.startDate) || stringAt(object.termStart) || stringAt(object.termStartDate) || genericStart,
  };
}

function mergeSection(current: EnrollmentSection | undefined, next: EnrollmentSection): EnrollmentSection {
  if (!current) return next;
  return {
    sectionId: current.sectionId,
    termStart: current.termStart || next.termStart,
    courseCode: current.courseCode || next.courseCode,
    termName: current.termName || next.termName,
  };
}

function collectEnrollmentSections(value: unknown, found: Map<string, EnrollmentSection>, inherited: Partial<EnrollmentSection> = {}): void {
  if (Array.isArray(value)) {
    for (const item of value) collectEnrollmentSections(item, found, inherited);
    return;
  }
  if (!isObject(value)) return;

  const localMetadata: Partial<EnrollmentSection> = { ...inherited };
  const directMetadata = metadataFrom(value);
  if (directMetadata.termStart) localMetadata.termStart = directMetadata.termStart;
  if (directMetadata.courseCode) localMetadata.courseCode = directMetadata.courseCode;
  if (directMetadata.termName) localMetadata.termName = directMetadata.termName;
  const sectionId = sectionIdFrom(value);
  if (sectionId) {
    const next: EnrollmentSection = { sectionId, ...localMetadata };
    found.set(sectionId, mergeSection(found.get(sectionId), next));
  }

  for (const child of Object.values(value)) {
    if (Array.isArray(child) || isObject(child)) collectEnrollmentSections(child, found, localMetadata);
  }
}

export function parseEnrollmentSections(payload: unknown): EnrollmentSection[] {
  const found = new Map<string, EnrollmentSection>();
  collectEnrollmentSections(payload, found);
  return [...found.values()];
}

export function buildCourseCatalog(sections: EnrollmentSection[]): CourseCatalogEntry[] {
  const grouped = new Map<string, CourseCatalogEntry>();

  for (const section of sections) {
    const parts = termParts(section.termName, section.termStart);
    const course = normalizeCourseCode(section.courseCode, `section_${section.sectionId.slice(0, 8).toLowerCase()}`);
    const baseId = `${parts.yearSemester}:${course}`;
    const existing = grouped.get(baseId);
    if (existing) {
      if (!existing.sectionIds.includes(section.sectionId)) existing.sectionIds.push(section.sectionId);
      existing.termName ||= section.termName;
      existing.termStart ||= section.termStart;
      continue;
    }

    grouped.set(baseId, {
      id: baseId,
      year: parts.year,
      semester: parts.semester,
      yearSemester: parts.yearSemester,
      course,
      termName: section.termName,
      termStart: section.termStart,
      sectionIds: [section.sectionId],
    });
  }

  return [...grouped.values()].sort((left, right) =>
    right.yearSemester.localeCompare(left.yearSemester) || left.course.localeCompare(right.course));
}

export function selectCourse(catalog: CourseCatalogEntry[], selector: string): CourseCatalogEntry {
  const needle = selector.trim().toLowerCase();
  const exact = catalog.find(course => course.id.toLowerCase() === needle);
  if (exact) return exact;

  const bySection = catalog.filter(course => course.sectionIds.some(sectionId => sectionId.toLowerCase() === needle));
  if (bySection.length === 1) return bySection[0]!;

  const byCourse = catalog.filter(course => course.course.toLowerCase() === needle);
  if (byCourse.length === 1) return byCourse[0]!;
  if (byCourse.length > 1) {
    throw new Error(`Course '${selector}' exists in multiple terms; use one of: ${byCourse.map(course => course.id).join(', ')}`);
  }

  throw new Error(`Unknown course '${selector}'. Run --list to see valid course IDs.`);
}

export async function fetchEnrollmentSections(cookie: string): Promise<EnrollmentSection[]> {
  logger.info('Fetching all Echo360 enrollments...');
  let response;
  try {
    response = await fetchJson('https://echo360.net.au/user/enrollments', {
      headers: {
        Cookie: cookie,
        accept: 'application/json',
      },
    });
  } catch (error) {
    if (error instanceof Error && (/status:\s*403\b/i.test(error.message) || /Expected JSON/i.test(error.message))) {
      throw new Error(`Echo360 rejected ./cookies with HTTP 403; the cookie is expired or invalid.\n${TOKEN_HELP}`);
    }
    throw error;
  }

  const sections = parseEnrollmentSections(response.json);
  if (!sections.length) {
    throw new Error('Echo360 returned no enrolled sections. The Echo token may be missing, invalid, or expired.');
  }

  logger.info(`Found ${sections.length} enrolled sections.`);
  return sections;
}
