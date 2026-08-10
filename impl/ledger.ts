import * as fs from 'node:fs';
import path from 'node:path';

export type LedgerMap = Record<string, string>;

export class Ledger {
  readonly filename: string;
  private entries: LedgerMap;

  constructor(readonly root: string) {
    this.filename = path.join(root, '.ledger.json');
    this.entries = this.read();
  }

  snapshot(): LedgerMap {
    return { ...this.entries };
  }

  pathsForId(lessonId: string): string[] {
    return Object.entries(this.entries)
      .filter(([, id]) => id === lessonId)
      .map(([relativePath]) => relativePath);
  }

  idForPath(relativePath: string): string | undefined {
    return this.entries[relativePath];
  }

  set(relativePath: string, lessonId: string): void {
    for (const [pathKey, id] of Object.entries(this.entries)) {
      if (id === lessonId && pathKey !== relativePath) delete this.entries[pathKey];
    }
    this.entries[relativePath] = lessonId;
    this.save();
  }

  remove(relativePath: string): void {
    if (!(relativePath in this.entries)) return;
    delete this.entries[relativePath];
    this.save();
  }

  reconcile(lessonId: string, desiredRelativePath: string): 'present' | 'renamed' | 'missing' {
    const desiredAbsolute = this.absolute(desiredRelativePath);
    const desiredId = this.idForPath(desiredRelativePath);

    if (fs.existsSync(desiredAbsolute)) {
      if (desiredId && desiredId !== lessonId) {
        throw new Error(`Destination collision: '${desiredRelativePath}' belongs to lesson ${desiredId}, not ${lessonId}.`);
      }
      this.set(desiredRelativePath, lessonId);
      return 'present';
    }

    for (const oldRelativePath of this.pathsForId(lessonId)) {
      const oldAbsolute = this.absolute(oldRelativePath);
      if (!fs.existsSync(oldAbsolute)) {
        this.remove(oldRelativePath);
        continue;
      }
      fs.mkdirSync(path.dirname(desiredAbsolute), { recursive: true });
      fs.renameSync(oldAbsolute, desiredAbsolute);
      this.set(desiredRelativePath, lessonId);
      this.pruneEmptyParents(path.dirname(oldAbsolute));
      return 'renamed';
    }

    return 'missing';
  }

  private absolute(relativePath: string): string {
    const normalized = relativePath.split('/').join(path.sep);
    const absolute = path.resolve(this.root, normalized);
    const relative = path.relative(this.root, absolute);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
      throw new Error(`Invalid ledger path '${relativePath}'.`);
    }
    return absolute;
  }

  private read(): LedgerMap {
    if (!fs.existsSync(this.filename)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(this.filename, 'utf8')) as unknown;
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('ledger is not an object');
      const entries: LedgerMap = {};
      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof value === 'string') entries[key] = value;
      }
      return entries;
    } catch (error) {
      throw new Error(`Could not read ${this.filename}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private save(): void {
    fs.mkdirSync(this.root, { recursive: true });
    const temp = `${this.filename}.tmp`;
    const sorted = Object.fromEntries(Object.entries(this.entries).sort(([a], [b]) => a.localeCompare(b)));
    fs.writeFileSync(temp, JSON.stringify(sorted, null, 2) + '\n');
    fs.renameSync(temp, this.filename);
  }

  private pruneEmptyParents(start: string): void {
    let current = start;
    while (current !== this.root && current.startsWith(this.root)) {
      try {
        if (fs.readdirSync(current).length > 0) break;
        fs.rmdirSync(current);
      } catch {
        break;
      }
      current = path.dirname(current);
    }
  }
}
