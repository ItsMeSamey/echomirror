import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import path from 'node:path';

import logger from './logger.js';

export interface DownloadOptions {
  readonly output: string;
  readonly checkExistence: string;
  readonly quiet: boolean;
  readonly progress: boolean;
}

export abstract class Downloadable {
  skipReason?: string;
  abstract download(options: Partial<DownloadOptions>): Promise<string | null>;
}

export class SkippedDownload extends Downloadable {
  constructor(public override skipReason: string) {
    super();
  }

  async download(): Promise<null> {
    return null;
  }
}

export interface M3U8Stream {
  readonly url: string;
  readonly kind: 'audio' | 'video' | 'subtitle';
}

interface Asset {
  readonly source: string;
  readonly file: string;
}

interface LocalStream {
  readonly kind: M3U8Stream['kind'];
  readonly file: string;
}

function runProcess(command: string, args: readonly string[]): Promise<{ stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-20_000); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve({ stdout });
      else reject(new Error(`${command} failed with ${signal ? `signal ${signal}` : `exit code ${code}`}${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
    });
  });
}

function headerArgs(headers: Readonly<Record<string, string>>): string[] {
  return Object.entries(headers).flatMap(([name, value]) => ['--header', `${name}: ${value}`]);
}

async function curlText(url: string, headers: Readonly<Record<string, string>>): Promise<string> {
  return (await runProcess('curl', [
    '--fail', '--location', '--silent', '--show-error', '--retry', '4',
    ...headerArgs(headers), '--url', url,
  ])).stdout;
}

async function curlFiles(assets: readonly Asset[], headers: Readonly<Record<string, string>>): Promise<void> {
  const missing = assets.filter(asset => !fs.existsSync(asset.file) || fs.statSync(asset.file).size === 0);
  if (!missing.length) return;
  for (const asset of missing) fs.mkdirSync(path.dirname(asset.file), { recursive: true });

  const configured = Number(process.env.ECHO_CURL_CONCURRENCY ?? 4);
  const concurrency = Number.isInteger(configured) && configured > 0 ? configured : 4;
  const args = [
    '--fail', '--location', '--silent', '--show-error', '--retry', '4',
    '--parallel', '--parallel-immediate', '--parallel-max', String(concurrency),
    ...headerArgs(headers),
  ];
  for (const asset of missing) args.push('--output', `${asset.file}.part`, '--url', asset.source);
  await runProcess('curl', args);
  for (const asset of missing) fs.renameSync(`${asset.file}.part`, asset.file);
}

function extension(url: string, fallback: string): string {
  return path.extname(new URL(url).pathname) || fallback;
}

function hash(value: string): string {
  return createHash('sha1').update(value).digest('hex').slice(0, 12);
}

function bestVariant(playlist: string, playlistUrl: string): string | undefined {
  const lines = playlist.split(/\r?\n/);
  const variants: Array<{ readonly url: string; readonly bandwidth: number }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim();
    if (!line?.startsWith('#EXT-X-STREAM-INF')) continue;
    const next = lines[index + 1]?.trim();
    if (!next || next.startsWith('#')) continue;
    variants.push({
      url: new URL(next, playlistUrl).href,
      bandwidth: Number(line.match(/BANDWIDTH=(\d+)/)?.[1] ?? 0),
    });
  }
  return variants.sort((left, right) => right.bandwidth - left.bandwidth)[0]?.url;
}

function localizePlaylist(playlist: string, playlistUrl: string, directory: string): {
  readonly text: string;
  readonly assets: readonly Asset[];
} {
  const knownFiles = new Map<string, string>();
  const assets: Asset[] = [];
  let index = 0;
  const localFile = (source: string, fallback: string): string => {
    const existing = knownFiles.get(source);
    if (existing) return existing;
    const file = path.join(directory, 'assets', `${String(index++).padStart(5, '0')}-${hash(source)}${extension(source, fallback)}`);
    knownFiles.set(source, file);
    assets.push({ source, file });
    return file;
  };

  const lines = playlist.split(/\r?\n/).map(line => {
    if (!line.trim()) return line;
    if (!line.startsWith('#')) {
      const source = new URL(line.trim(), playlistUrl).href;
      return path.relative(directory, localFile(source, '.ts')).split(path.sep).join('/');
    }
    return line.replace(/URI="([^"]+)"/g, (_match: string, uri: string) => {
      const source = new URL(uri, playlistUrl).href;
      return `URI="${path.relative(directory, localFile(source, '.bin')).split(path.sep).join('/')}"`;
    });
  });
  return { text: `${lines.join('\n').trim()}\n`, assets };
}

/** Uses the device's curl for network transfer and ffmpeg only for muxing. */
export class M3U8Downloader extends Downloadable {
  constructor(
    private readonly streams: readonly M3U8Stream[],
    private readonly filename: string,
    private readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super();
    if (!streams.length) throw new Error('No media streams were provided.');
  }

  private async cacheStream(stream: M3U8Stream, index: number, cacheRoot: string): Promise<LocalStream> {
    const directory = path.join(cacheRoot, `${index}-${stream.kind}`);
    fs.mkdirSync(directory, { recursive: true });
    if (stream.kind === 'subtitle') {
      const file = path.join(directory, `subtitle${extension(stream.url, '.vtt')}`);
      await curlFiles([{ source: stream.url, file }], this.headers);
      return { kind: stream.kind, file };
    }

    let url = stream.url;
    let playlist = await curlText(url, this.headers);
    const variant = bestVariant(playlist, url);
    if (variant) {
      url = variant;
      playlist = await curlText(url, this.headers);
    }
    if (!playlist.includes('#EXTM3U')) {
      const file = path.join(directory, `media${extension(url, '.bin')}`);
      await curlFiles([{ source: url, file }], this.headers);
      return { kind: stream.kind, file };
    }

    const localized = localizePlaylist(playlist, url, directory);
    await curlFiles(localized.assets, this.headers);
    const file = path.join(directory, 'playlist.m3u8');
    fs.writeFileSync(file, localized.text);
    return { kind: stream.kind, file };
  }

  async download(options: Partial<DownloadOptions> = {}): Promise<string | null> {
    const output = options.output ?? '.';
    if (options.checkExistence && fs.existsSync(path.join(options.checkExistence, this.filename))) return null;
    const destination = path.join(output, this.filename);
    const cacheRoot = `${destination}.cache`;
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    logger.info(`DOWNLOAD ${this.filename}`);
    const local = await Promise.all(this.streams.map((stream, index) => this.cacheStream(stream, index, cacheRoot)));

    const args = ['-hide_banner', '-loglevel', 'error'];
    for (const stream of local) args.push('-protocol_whitelist', 'file,crypto,data', '-i', stream.file);
    local.forEach((stream, index) => args.push('-map', `${index}:${stream.kind[0]}`));
    if (local.some(stream => stream.kind === 'video')) args.push('-c:v', 'copy');
    if (local.some(stream => stream.kind === 'audio')) args.push('-c:a', 'copy');
    if (local.some(stream => stream.kind === 'subtitle')) args.push('-c:s', 'mov_text');
    args.push('-y', destination);
    await runProcess('ffmpeg', args);
    return this.filename;
  }
}

export type DownloadTask = Downloadable | Promise<Downloadable | undefined>
  | (() => Downloadable | undefined | Promise<Downloadable | undefined>) | undefined;

type DoneCallback = (download?: Downloadable, error?: unknown) => void;

export interface DownloaderOptions {
  readonly maxRetries: number;
  readonly outdir: string;
  readonly callback?: DoneCallback;
}

interface QueueEntry {
  readonly task: DownloadTask;
  readonly callback?: DoneCallback;
  readonly label?: string;
}

interface ConfiguredDownload {
  readonly download: DownloadTask;
  readonly callback?: DoneCallback;
  readonly label?: string;
}

function isConfiguredDownload(value: DownloadTask | ConfiguredDownload): value is ConfiguredDownload {
  return typeof value === 'object'
    && value !== null
    && !(value instanceof Downloadable)
    && !(value instanceof Promise)
    && 'download' in value;
}

export class Downloader {
  running = 0;
  completed = 0;
  skipped = 0;
  failed = 0;
  readonly skipDetails: Array<{ readonly label?: string; readonly reason: string }> = [];
  private readonly pending: QueueEntry[] = [];
  private readonly idleResolvers: Array<() => void> = [];

  constructor(private readonly concurrency: number, private readonly options: DownloaderOptions) {}

  add(...entries: Array<DownloadTask | ConfiguredDownload>): void {
    for (const entry of entries) {
      this.pending.push(isConfiguredDownload(entry)
        ? { task: entry.download, callback: entry.callback, label: entry.label }
        : { task: entry as DownloadTask });
    }
    this.pump();
  }

  idle(): Promise<void> {
    if (!this.running && !this.pending.length) return Promise.resolve();
    return new Promise(resolve => this.idleResolvers.push(resolve));
  }

  private async run(entry: QueueEntry): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.options.maxRetries; attempt += 1) {
      let downloadable: Downloadable | undefined;
      try {
        downloadable = await (typeof entry.task === 'function' ? entry.task() : entry.task);
        if (!downloadable) return this.recordSkip(entry, 'download factory returned no downloadable media');
        const partialRoot = path.join(this.options.outdir, '.partial');
        const filename = await downloadable.download({
          output: partialRoot,
          checkExistence: this.options.outdir,
          quiet: true,
          progress: true,
        });
        if (filename === null) {
          this.recordSkip(entry, downloadable.skipReason ?? 'destination file already exists');
          entry.callback?.(downloadable);
          return;
        }
        const source = path.join(partialRoot, filename);
        const destination = path.join(this.options.outdir, filename);
        fs.mkdirSync(path.dirname(destination), { recursive: true });
        fs.renameSync(source, destination);
        fs.rmSync(`${source}.cache`, { recursive: true, force: true });
        entry.callback?.(downloadable);
        this.options.callback?.(downloadable);
        this.completed += 1;
        return;
      } catch (error: unknown) {
        lastError = error;
        entry.callback?.(downloadable, error);
        this.options.callback?.(downloadable, error);
        logger.warn(`Download attempt ${attempt}/${this.options.maxRetries} failed${entry.label ? ` for ${entry.label}` : ''}:`, error);
      }
    }
    this.failed += 1;
    logger.error(`Download failed${entry.label ? ` for ${entry.label}` : ''}:`, lastError);
  }

  private recordSkip(entry: QueueEntry, reason: string): void {
    this.skipped += 1;
    this.skipDetails.push({ ...(entry.label ? { label: entry.label } : {}), reason });
    logger.info(`SKIP${entry.label ? ` ${entry.label}` : ''} — ${reason}`);
  }

  private pump(): void {
    const limit = Math.max(1, Math.floor(this.concurrency));
    while (this.running < limit && this.pending.length) {
      const entry = this.pending.shift()!;
      this.running += 1;
      void this.run(entry).finally(() => {
        this.running -= 1;
        this.pump();
        this.resolveIdle();
      });
    }
    this.resolveIdle();
  }

  private resolveIdle(): void {
    if (this.running || this.pending.length) return;
    for (const resolve of this.idleResolvers.splice(0)) resolve();
  }
}
