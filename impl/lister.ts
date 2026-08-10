import { fetchJson } from '../utils/common.js';
import logger from '../utils/logger.js';
import type { ApiResponse, SyllabusLesson } from './lister_schema.js';

export async function fetchSectionLessons(sectionId: string, cookie: string): Promise<SyllabusLesson[]> {
  const syllabusUrl = `https://echo360.net.au/section/${sectionId}/syllabus`;
  logger.info(`Fetching syllabus for section ${sectionId}...`);

  const response = await fetchJson(syllabusUrl, {
    headers: {
      Cookie: cookie,
      accept: 'application/json, text/plain, */*',
    },
  });

  const syllabusData = response.json as ApiResponse;
  if (!syllabusData || syllabusData.status !== 'ok' || !Array.isArray(syllabusData.data)) {
    throw new Error(`Unexpected syllabus response for section ${sectionId}`);
  }

  return syllabusData.data.filter(item => item.lesson?.hasVideo === true && item.lesson.lesson?.id);
}

export async function extractEcho360Links(url: string, cookie: string) {
  const sectionIdMatch = url.match(/section\/([a-f0-9-]+)\//i);
  if (!sectionIdMatch?.[1]) {
    logger.error('Could not extract a valid Section ID from the URL.');
    return;
  }
  const lessons = await fetchSectionLessons(sectionIdMatch[1], cookie);
  return lessons.map(item => `https://echo360.net.au/lesson/${item.lesson.lesson.id}/classroom`);
}
