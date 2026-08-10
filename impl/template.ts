import os from 'node:os';
import path from 'node:path';

export const DEFAULT_DEST_TEMPLATE = '~/Downloads/Docs/uq/{year_sem}/{course}/recordings/{week}_{lecnum}_{lecname}.mp4';

export interface TemplateValues {
  year: string;
  semester: string;
  year_sem: string;
  course: string;
  week: string;
  lecnum: string;
  lecname: string;
  id: string;
}

const TOKENS = new Set<keyof TemplateValues>(['year', 'semester', 'year_sem', 'course', 'week', 'lecnum', 'lecname', 'id']);

function expandHome(value: string): string {
  if (value === '~') return os.homedir();
  if (value.startsWith('~/')) return path.join(os.homedir(), value.slice(2));
  return value;
}

function ensureMp4(value: string): string {
  return path.extname(value) ? value : `${value}.mp4`;
}

export function validateDestTemplate(template: string): void {
  const matches = [...template.matchAll(/\{([^{}]+)\}/g)];
  for (const match of matches) {
    const token = match[1]!;
    if (!TOKENS.has(token as keyof TemplateValues)) {
      throw new Error(`Unknown --dest token {${token}}. Supported tokens: ${[...TOKENS].map(item => `{${item}}`).join(', ')}`);
    }
  }
}

export function templateLedgerRoot(template: string, cwd = process.cwd()): string {
  validateDestTemplate(template);
  const expanded = expandHome(template);
  const absolute = path.isAbsolute(expanded) ? path.normalize(expanded) : path.resolve(cwd, expanded);
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const staticSegments: string[] = [];

  for (const segment of segments) {
    if (segment.includes('{')) break;
    staticSegments.push(segment);
  }

  if (staticSegments.length === segments.length) {
    return path.dirname(absolute);
  }
  return path.join(parsed.root, ...staticSegments);
}

export interface RenderedDestination {
  root: string;
  relativePath: string;
  absolutePath: string;
}

export function renderDestination(template: string, values: TemplateValues, cwd = process.cwd()): RenderedDestination {
  validateDestTemplate(template);
  let rendered = expandHome(template).replace(/\{([^{}]+)\}/g, (_whole, token: string) => values[token as keyof TemplateValues]);
  rendered = ensureMp4(rendered);
  const absolutePath = path.isAbsolute(rendered) ? path.normalize(rendered) : path.resolve(cwd, rendered);
  const root = templateLedgerRoot(template, cwd);
  let relativePath = path.relative(root, absolutePath);
  if (!relativePath || relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    throw new Error(`Rendered destination '${absolutePath}' escapes ledger root '${root}'.`);
  }
  relativePath = relativePath.split(path.sep).join('/');
  return { root, relativePath, absolutePath };
}
