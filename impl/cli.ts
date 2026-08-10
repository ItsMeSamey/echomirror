import { DEFAULT_DEST_TEMPLATE } from './template.js';

export interface CliOptions {
  help: boolean;
  list: boolean;
  all: boolean;
  course?: string;
  dest: string;
  token?: string;
}

export const HELP_TEXT = `Usage:
  bun run echomirror.ts --list
  bun run echomirror.ts --course <id> [--dest <template>]
  bun run echomirror.ts --all [--dest <template>]

Options:
  --help, -h          Show this help.
  --list              List enrolled courses and their IDs. Does not download.
  --course <id>       Mirror one course. Accepts the ID printed by --list;
                      a course code is also accepted when it is unambiguous.
  --all               Mirror every enrolled course.
  --token <cookie>    Echo Cookie request-header value. Stored in ./cookies.
  --dest <template>   Output path template. Relative templates are resolved from
                      the current directory. If no extension is present, .mp4 is added.

Template fields:
  {year}       Four-digit year, e.g. 2026
  {semester}   Semester number, e.g. 1
  {year_sem}   Combined year/semester, e.g. 2026_1
  {course}     Lowercase course code, e.g. comp4403
  {week}       Zero-padded teaching week, e.g. 01
  {lecnum}     Zero-padded lecture number within the week, e.g. 02
  {lecname}    Sanitized lecture name
  {id}         Echo360 lesson ID

Default --dest:
  ${DEFAULT_DEST_TEMPLATE}

A .ledger.json is stored at the static root of the destination template. It maps
rendered recording paths to Echo lesson IDs, allowing template changes to rename
existing files instead of downloading them again.

Environment:
  ECHO_CONCURRENCY       Recording jobs in flight (default 6)
  ECHO_HTTP_CONCURRENCY  Global Echo media HTTP requests (default 2x jobs)
  ECHO_SEGMENT_CONCURRENCY  Per-stream segment workers before the global cap (default 8)`;

function valueAfter(args: string[], index: number, option: string): [string, number] {
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${option} requires a value.`);
  return [value, index + 1];
}

export function parseCliArgs(args: string[]): CliOptions {
  const options: CliOptions = { help: false, list: false, all: false, dest: DEFAULT_DEST_TEMPLATE };

  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--list') options.list = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--course') {
      const [value, consumed] = valueAfter(args, index, '--course');
      options.course = value;
      index = consumed;
    } else if (arg.startsWith('--course=')) {
      options.course = arg.slice('--course='.length);
      if (!options.course) throw new Error('--course requires a value.');
    } else if (arg === '--token') {
      const [value, consumed] = valueAfter(args, index, '--token');
      options.token = value;
      index = consumed;
    } else if (arg.startsWith('--token=')) {
      options.token = arg.slice('--token='.length);
      if (!options.token) throw new Error('--token requires a value.');
    } else if (arg === '--dest') {
      const [value, consumed] = valueAfter(args, index, '--dest');
      options.dest = value;
      index = consumed;
    } else if (arg.startsWith('--dest=')) {
      options.dest = arg.slice('--dest='.length);
      if (!options.dest) throw new Error('--dest requires a value.');
    } else {
      throw new Error(`Unknown option '${arg}'.`);
    }
  }

  if (options.all && options.course) throw new Error('Use either --all or --course, not both.');
  if (options.list && (options.all || options.course)) throw new Error('--list cannot be combined with --all or --course.');
  return options;
}
