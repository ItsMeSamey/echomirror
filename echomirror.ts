import { loadToken } from './impl/token.js';
import { buildCourseCatalog, fetchEnrollmentSections, selectCourse, type CourseCatalogEntry } from './impl/catalog.js';
import { HELP_TEXT, parseCliArgs } from './impl/cli.js';
import { mirrorCourses } from './impl/mirror.js';
import { validateDestTemplate } from './impl/template.js';
import { writeTerminalLine } from './utils/terminal.js';

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function printCatalog(catalog: CourseCatalogEntry[]): void {
  const rows = catalog.map(course => ({
    id: course.id,
    course: course.course,
    term: course.termName || course.yearSemester,
    sections: String(course.sectionIds.length),
  }));
  const widths = {
    id: Math.max('ID'.length, ...rows.map(row => row.id.length)),
    course: Math.max('COURSE'.length, ...rows.map(row => row.course.length)),
    term: Math.max('TERM'.length, ...rows.map(row => row.term.length)),
  };
  console.log(`${'ID'.padEnd(widths.id)}  ${'COURSE'.padEnd(widths.course)}  ${'TERM'.padEnd(widths.term)}  SECTIONS`);
  for (const row of rows) {
    console.log(`${row.id.padEnd(widths.id)}  ${row.course.padEnd(widths.course)}  ${row.term.padEnd(widths.term)}  ${row.sections}`);
  }
}

try {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.help || (!options.list && !options.all && !options.course)) {
    console.log(HELP_TEXT);
  } else {
    const token = await loadToken(options.token);
    const catalog = buildCourseCatalog(await fetchEnrollmentSections(token));
    if (options.list) {
      printCatalog(catalog);
    } else {
      validateDestTemplate(options.dest);
      const selected = options.all ? catalog : [selectCourse(catalog, options.course!)];
      const concurrency = positiveInt(process.env.ECHO_CONCURRENCY, 6);
      writeTerminalLine(`Mirroring ${selected.length} course(s) with concurrency ${concurrency}.`);
      const summary = await mirrorCourses(selected, token, options.dest, concurrency);
      writeTerminalLine(`Finished: ${summary.downloaded} downloaded, ${summary.renamed} renamed, ${summary.alreadyPresent} already present, ${summary.skipped} skipped, ${summary.failed} failed, ${summary.setupFailures} setup failures.`);
      if (summary.failed > 0 || summary.setupFailures > 0) process.exitCode = 1;
    }
  }
} catch (error) {
  writeTerminalLine(`echomirror: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
