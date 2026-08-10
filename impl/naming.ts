import path from 'node:path';
import type { Echo360Data } from './downloader_schema.js';

export interface LessonNamingHint {
  weekNumber: number;
  lectureNumber: number;
  syllabusName?: string;
}

export function asciiSlug(value: string, fallback: string): string {
  const cleaned = value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .replace(/_+/g, '_');
  return (cleaned || fallback).slice(0, 100);
}

function stripLectureBoilerplate(value: string): string {
  return value
    .replace(/\b(?:week|wk)\s*0*\d+\b/gi, ' ')
    .replace(/\b(?:lecture|lec|class|recording|session)\s*0*\d+[a-z]?\b/gi, ' ')
    .replace(/\b(?:semester|sem)\s*[12]\b/gi, ' ')
    .replace(/\b\d{4}[-/]\d{1,2}[-/]\d{1,2}\b/g, ' ')
    .replace(/\b\d{1,2}[:.]\d{2}(?::\d{2})?\b/g, ' ')
    .replace(/^[\s:|\-–—_]+|[\s:|\-–—_]+$/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeCourseCode(value: string | undefined, fallback = 'course'): string {
  if (value) {
    const uqCode = value.match(/\b([a-z]{4}\d{4})\b/i)?.[1];
    if (uqCode) return uqCode.toLowerCase();
    return asciiSlug(value, fallback);
  }
  return fallback;
}

export interface TermParts {
  year: string;
  semester: string;
  yearSemester: string;
}

export function termParts(termName?: string, termStart?: string): TermParts {
  const start = termStart ? new Date(termStart) : undefined;
  const startIsValid = Boolean(start && !Number.isNaN(start.getTime()));
  const yearFromName = termName?.match(/(?:^|[^0-9])(20\d{2})(?:[^0-9]|$)/)?.[1];
  const year = yearFromName || (startIsValid ? String(start!.getUTCFullYear()) : 'unknown');

  const semesterMatch = termName?.match(/(?:^|[^a-z0-9])(?:semester|sem|s)[ _.-]*([12])(?:[^0-9]|$)/i)?.[1];
  const semester = semesterMatch || (startIsValid ? (start!.getUTCMonth() < 6 ? '1' : '2') : 'unknown');
  return { year, semester, yearSemester: `${year}_${semester}` };
}

export function courseCodeFromData(data: Echo360Data): string {
  const candidates = [
    data.sectionInfo?.course?.courseIdentifier,
    data.sectionInfo?.course?.courseName,
    data.sectionInfo?.label,
    data.context?.courseId,
  ].filter(Boolean) as string[];

  return normalizeCourseCode(candidates[0], 'course');
}

export function yearSemesterFromData(data: Echo360Data): string {
  return termParts(data.sectionInfo?.term?.name, data.sectionInfo?.term?.session?.startDate).yearSemester;
}

export function lectureNameFromText(value: string | undefined): string {
  if (!value) return 'lecture';

  // Echo's default UQ schedule names look like COMP2701_S1_2026_STLUCIA_22477_IN_01.
  // They identify the section/capture source, not the lecture topic, so do not bake
  // them into every filename.
  const compact = value.trim();
  if (/^[a-z]{4}\d{4}[ _.-]+s[12][ _.-]+20\d{2}(?:[ _.-]+[a-z0-9]+){2,}$/i.test(compact)) {
    return 'lecture';
  }

  const stripped = stripLectureBoilerplate(value);
  const slug = asciiSlug(stripped, 'lecture');
  return /^(lecture|class|recording|session)$/.test(slug) ? 'lecture' : slug;
}

export function lectureNameFromData(data: Echo360Data, syllabusName?: string): string {
  const candidates = [
    syllabusName,
    data.lesson?.displayName,
    data.lesson?.name,
    data.viewEmbedInfo?.mediaName,
    data.title,
  ].filter(Boolean) as string[];

  for (const candidate of candidates) {
    const name = lectureNameFromText(candidate);
    if (name !== 'lecture') return name;
  }

  return 'lecture';
}

export function buildRecordingPath(data: Echo360Data, hint: LessonNamingHint): string {
  const week = String(Math.max(1, hint.weekNumber)).padStart(2, '0');
  const lecture = String(Math.max(1, hint.lectureNumber)).padStart(2, '0');
  const name = lectureNameFromData(data, hint.syllabusName);
  return path.join(
    yearSemesterFromData(data),
    courseCodeFromData(data),
    'recordings',
    `${week}_${lecture}_${name}.mp4`,
  );
}

export function weekNumberForDate(date: Date, termStart: Date): number {
  if (Number.isNaN(date.getTime()) || Number.isNaN(termStart.getTime())) return 1;
  const day = 24 * 60 * 60 * 1000;
  const dateDay = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const startDay = Date.UTC(termStart.getUTCFullYear(), termStart.getUTCMonth(), termStart.getUTCDate());
  return Math.max(1, Math.floor((dateDay - startDay) / (7 * day)) + 1);
}
