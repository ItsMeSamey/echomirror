import * as fs from 'node:fs';
import path from 'node:path';
import pMap from 'p-map';
import pRetry from 'p-retry';
import type { CourseCatalogEntry } from './catalog.js';
import { createEcho360Download } from './downloader.js';
import { Ledger } from './ledger.js';
import { fetchSectionLessons } from './lister.js';
import type { SyllabusLesson } from './lister_schema.js';
import { lectureNameFromText, termParts, weekNumberForDate } from './naming.js';
import { renderDestination, type TemplateValues } from './template.js';
import { SkippedDownload } from './downloader.js';
import logger from '../utils/logger.js';

export interface PlannedLecture {
  id: string;
  sectionId: string;
  year: string;
  semester: string;
  yearSemester: string;
  course: string;
  weekNumber: number;
  lectureNumber: number;
  lectureName: string;
  start: Date;
}

export interface MirrorSummary {
  lectures: number;
  renamed: number;
  alreadyPresent: number;
  downloaded: number;
  skipped: number;
  failed: number;
  setupFailures: number;
}

function lessonStart(item: SyllabusLesson): Date {
  const details = item.lesson.lesson;
  const value = details.timing?.start || item.lesson.startTimeUTC || details.createdAt;
  return new Date(value);
}

function validDate(value: string | undefined): Date | undefined {
  if (!value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function lectureNameFromSyllabus(item: SyllabusLesson): string {
  const details = item.lesson.lesson;
  const preferred = details.lessonHasName ? [details.displayName, details.name] : [];
  const candidates = [
    ...preferred,
    ...(item.lesson.medias ?? []).map(media => media.title),
    details.displayName,
    details.name,
  ];
  for (const candidate of candidates) {
    const name = lectureNameFromText(candidate);
    if (name !== 'lecture') return name;
  }
  return 'lecture';
}

function fallbackTermText(lessons: SyllabusLesson[]): string {
  return lessons.flatMap(item => [
    item.lesson.lesson.displayName,
    item.lesson.lesson.name,
    ...(item.lesson.medias ?? []).map(media => media.title),
  ]).filter(Boolean).join(' ');
}

export function planCourseLectures(course: CourseCatalogEntry, lessons: SyllabusLesson[]): PlannedLecture[] {
  const byId = new Map<string, SyllabusLesson>();
  for (const item of lessons) byId.set(item.lesson.lesson.id, item);
  const sorted = [...byId.values()].sort((left, right) => lessonStart(left).getTime() - lessonStart(right).getTime());
  const earliest = sorted.map(lessonStart).find(date => !Number.isNaN(date.getTime()));
  const termStart = validDate(course.termStart) || earliest || new Date(0);
  const inferred = termParts(course.termName || fallbackTermText(sorted), Number.isNaN(termStart.getTime()) ? undefined : termStart.toISOString());
  const year = course.year === 'unknown' ? inferred.year : course.year;
  const semester = course.semester === 'unknown' ? inferred.semester : course.semester;
  const yearSemester = `${year}_${semester}`;
  const perWeek = new Map<number, number>();

  return sorted.map(item => {
    const details = item.lesson.lesson;
    const rawStart = lessonStart(item);
    const start = Number.isNaN(rawStart.getTime()) ? termStart : rawStart;
    const weekNumber = weekNumberForDate(start, termStart);
    const lectureNumber = (perWeek.get(weekNumber) || 0) + 1;
    perWeek.set(weekNumber, lectureNumber);
    return {
      id: details.id,
      sectionId: details.sectionId,
      year,
      semester,
      yearSemester,
      course: course.course,
      weekNumber,
      lectureNumber,
      lectureName: lectureNameFromSyllabus(item),
      start,
    };
  });
}

function templateValues(lecture: PlannedLecture): TemplateValues {
  return {
    year: lecture.year,
    semester: lecture.semester,
    year_sem: lecture.yearSemester,
    course: lecture.course,
    week: String(Math.max(1, lecture.weekNumber)).padStart(2, '0'),
    lecnum: String(Math.max(1, lecture.lectureNumber)).padStart(2, '0'),
    lecname: lecture.lectureName,
    id: lecture.id,
  };
}

export async function fetchCourseLectures(course: CourseCatalogEntry, cookie: string): Promise<PlannedLecture[]> {
  const results = await Promise.all(course.sectionIds.map(sectionId => fetchSectionLessons(sectionId, cookie)));
  return planCourseLectures(course, results.flat());
}

export async function mirrorCourses(
  courses: CourseCatalogEntry[],
  cookie: string,
  destTemplate: string,
  concurrency: number,
): Promise<MirrorSummary> {
  let setupFailures = 0;
  const planned = (await pMap(courses, async course => {
    try {
      return await fetchCourseLectures(course, cookie);
    } catch (error) {
      setupFailures += 1;
      logger.error(`Failed to fetch course ${course.id}:`, error);
      return [];
    }
  }, { concurrency })).flat();

  const destinations = planned.map(lecture => ({ lecture, destination: renderDestination(destTemplate, templateValues(lecture)) }));
  const roots = new Set(destinations.map(item => item.destination.root));
  if (roots.size > 1) throw new Error('Internal error: destination template produced multiple ledger roots.');
  const root = destinations[0]?.destination.root || renderDestination(destTemplate, {
    year: 'year', semester: 'semester', year_sem: 'year_sem', course: 'course', week: 'week', lecnum: 'lecnum', lecname: 'lecture', id: 'id',
  }).root;
  const ledger = new Ledger(root);
  const pathOwners = new Map<string, string>();
  let renamed = 0;
  let alreadyPresent = 0;

  for (const { lecture, destination } of destinations) {
    const owner = pathOwners.get(destination.relativePath);
    if (owner && owner !== lecture.id) {
      throw new Error(`--dest collision: lessons ${owner} and ${lecture.id} both render to '${destination.relativePath}'. Add {lecnum}, {lecname}, or {id}.`);
    }
    pathOwners.set(destination.relativePath, lecture.id);
  }

  const queued: Array<{ lecture: PlannedLecture; destination: ReturnType<typeof renderDestination> }> = [];

  for (const { lecture, destination } of destinations) {
    const state = ledger.reconcile(lecture.id, destination.relativePath);
    if (state === 'renamed') {
      renamed += 1;
      logger.info(`MOVE ${lecture.course} ${path.basename(destination.relativePath)} — template path changed`);
      continue;
    }
    if (state === 'present') {
      alreadyPresent += 1;
      logger.info(`SKIP ${destination.relativePath} — destination already exists`);
      continue;
    }

    queued.push({ lecture, destination });
  }

  logger.info(`Prepared ${planned.length} recordings: ${queued.length} download(s), ${renamed} rename(s), ${alreadyPresent} already present.`);
  let downloaded = 0;
  let skipped = 0;
  let failed = 0;
  await pMap(queued, async ({ lecture, destination }) => {
    const url = `https://echo360.net.au/lesson/${lecture.id}/classroom`;
    try {
      const download = await pRetry(
        async () => {
          const next = await createEcho360Download(url, cookie, destination.absolutePath);
          if (!(next instanceof SkippedDownload)) await next.download();
          return next;
        },
        {
          retries: 3,
          onFailedAttempt: ({ error, attemptNumber }) => logger.warn(
            `Download ${attemptNumber}/4 failed for ${destination.relativePath}: ${error.message}`,
          ),
        },
      );
      if (download instanceof SkippedDownload) {
        skipped += 1;
        logger.info(`SKIP ${destination.relativePath} — ${download.skipReason}`);
        return;
      }
      ledger.set(destination.relativePath, lecture.id);
      downloaded += 1;
    } catch (error) {
      failed += 1;
      logger.error(`Download failed for ${destination.relativePath}:`, error);
    }
  }, { concurrency });

  return {
    lectures: planned.length,
    renamed,
    alreadyPresent,
    downloaded,
    skipped,
    failed,
    setupFailures,
  };
}
