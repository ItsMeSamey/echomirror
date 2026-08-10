'use strict';

import * as fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import logger from './logger.js';
import { clearTerminalStatus, setTerminalStatus } from './terminal.js';

interface StatusTask {
  label: string;
  phase: string;
  current?: number;
  total?: number;
  unit?: 'count' | 'bytes';
}

class StatusReporter {
  private active = new Map<string, StatusTask>();
  private completed = 0;
  private skipped = 0;
  private failed = 0;
  private pending = 0;
  private jobsRunning = 0;
  private lastRender = 0;
  private renderTimer?: ReturnType<typeof setTimeout>;

  setJobs(running: number, pending: number, completed = this.completed, skipped = this.skipped, failed = this.failed) {
    this.jobsRunning = running;
    this.pending = pending;
    this.completed = completed;
    this.skipped = skipped;
    this.failed = failed;
    this.schedule();
  }

  setPending(count: number) {
    this.pending = count;
    this.schedule();
  }

  start(id: string, label: string, phase = 'starting', total?: number, unit: StatusTask['unit'] = 'count') {
    this.active.set(id, { label, phase, current: total === undefined ? undefined : 0, total, unit });
    this.schedule(true);
  }

  update(id: string, update: Partial<StatusTask>) {
    const task = this.active.get(id);
    if (!task) return;
    // Reinsert so the most recently updated task is the one shown in the single-line UI.
    this.active.delete(id);
    this.active.set(id, { ...task, ...update });
    this.schedule();
  }

  finish(id: string, _result: 'completed' | 'skipped' | 'failed' = 'completed') {
    if (this.active.delete(id)) this.schedule(true);
  }

  remove(id: string) {
    if (this.active.delete(id)) this.schedule(true);
  }

  close() {
    if (this.renderTimer) clearTimeout(this.renderTimer);
    this.renderTimer = undefined;
    clearTerminalStatus();
  }

  private schedule(force = false) {
    if (!process.stderr.isTTY) return;

    const now = Date.now();
    if (force || now - this.lastRender >= 200) {
      this.render();
      return;
    }

    if (!this.renderTimer) {
      this.renderTimer = setTimeout(() => {
        this.renderTimer = undefined;
        this.render();
      }, 200 - (now - this.lastRender));
    }
  }

  private render() {
    this.lastRender = Date.now();
    const summary = `jobs ${this.jobsRunning} active / ${this.pending} queued | done ${this.completed} | skipped ${this.skipped} | failed ${this.failed}`;
    const focus = [...this.active.values()].at(-1);
    const detail = focus ? ` | ${this.formatTask(focus)}` : '';
    setTerminalStatus(`${summary}${detail}`);
  }

  private formatTask(task: StatusTask): string {
    const total = task.total;
    const current = task.current ?? 0;
    const hasProgress = total !== undefined && total > 0;
    const counts = hasProgress ? `${this.formatProgress(current, total, task.unit)} ` : '';
    return `${counts}${task.phase} ${task.label}`;
  }

  private formatProgress(current: number, total: number, unit: StatusTask['unit'] = 'count'): string {
    if (unit !== 'bytes') return `${current}/${total}`;
    return `${this.formatBytes(current)}/${this.formatBytes(total)}`;
  }

  private formatBytes(bytes: number): string {
    const MiB = 1024 * 1024;
    if (bytes >= MiB) return `${(bytes / MiB).toFixed(1)} MiB`;
    const KiB = 1024;
    if (bytes >= KiB) return `${(bytes / KiB).toFixed(1)} KiB`;
    return `${bytes} B`;
  }
}

const statusReporter = new StatusReporter();

export abstract class Downloadable {
  /** Human-readable reason when download() intentionally returns null. */
  skipReason?: string;

  /**
   * Downloads the content.
   * @param options The options for the download operation.
   * @returns A promise that resolves with the final filename of the downloaded content.
   *   If the return value is null, it means the file has already been downloaded
   */
  abstract download(options: Partial<DownloadOptions>): Promise<string | null>;
}

export class SkippedDownload extends Downloadable {
  constructor(public override skipReason: string) {
    super();
  }

  async download(_options: Partial<DownloadOptions> = {}): Promise<null> {
    return null;
  }
}

export interface DownloadOptions {
  output: string // optput dir path
  checkExistence: string, // the dir where you should check for existence before downloading
  verbose: boolean // verbose messages
  quiet: boolean // no output to stdout, not even progress, overrides verbose
  continue: boolean // try to continue from where we left off
  progress: boolean // weather to show a progress bar
}


class AsyncLimiter {
  private active = 0;
  private waiters: Array<() => void> = [];

  constructor(private limit: number) {}

  setLimit(limit: number) {
    this.limit = Math.max(1, Math.floor(limit));
    while (this.waiters.length && this.active < this.limit) {
      this.active += 1;
      this.waiters.shift()!();
    }
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.active < this.limit) {
      this.active += 1;
    } else {
      await new Promise<void>(resolve => this.waiters.push(resolve));
    }

    try {
      return await fn();
    } finally {
      if (this.active > this.limit) {
        this.active -= 1;
      } else {
        const waiter = this.waiters.shift();
        if (waiter) {
          // Transfer this permit directly to the next waiter; active stays constant.
          waiter();
        } else {
          this.active -= 1;
        }
      }
    }
  }
}

const mediaRequestLimiter = new AsyncLimiter(12);

export function setMediaRequestConcurrency(limit: number): void {
  mediaRequestLimiter.setLimit(limit);
}

async function mediaFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  return mediaRequestLimiter.run(() => fetch(input, init));
}

function mediaHttpError(response: Response, url: string, action: string): Error {
  if (response.status === 403 && /(?:^|\.)echo360\.net\.au$/i.test(new URL(url).hostname)) {
    return new Error(`HTTP 403 while ${action} ${url}. Echo360 rejected the media authorization; ./cookies may be expired or invalid. The next retry will reload the lesson page to refresh media cookies/URLs.`);
  }
  return new Error(`HTTP error ${response.status} while ${action} ${url}`);
}

export class SimpleDownloader extends Downloadable {
  constructor(
    private link: string,
    private filenameHint?: string,
    private init?: RequestInit,
    public resumable: boolean = false
  ) {super();}

  async download(options: Partial<DownloadOptions> = {}) {
    const outputPath = options.output || './';
    const verbose = options.verbose && !options.quiet;
    options.continue = options.continue ?? this.resumable

    let resolvedOutputPath = outputPath;
    let filename: string | null | undefined = this.filenameHint;

    if (verbose) logger.info(`-- Connecting to ${this.link}`);
    const response = await mediaFetch(this.link, this.init);

    if (!response.ok) {
      logger.error(`HTTP error! status: ${response.status}`)
      logger.error(`HTTP error! body: ${await response.text()}`)
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    if (verbose) logger.info(`response headers: ${response.headers}`)

    if (!filename) {
      const contentDisposition = response.headers.get('content-disposition');

      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="([^"]+)"/);
        if (filenameMatch && filenameMatch[1]) {
          filename = filenameMatch[1];
        }
      }
    }

    if (!filename) {
      const urlPath = new URL(this.link).pathname.slice(0, 512); // to prevent path too long error
      filename = path.basename(urlPath);
      if (!filename || filename === '/') {
        filename = 'index.html.' + (new Date()).getTime(); // Default filename if URL path doesn't suggest one
      }
    }

    if (options.checkExistence && fs.existsSync(path.join(options.checkExistence, filename))) {
      return null;
    }

    resolvedOutputPath = path.join(outputPath, filename);
    fs.mkdirSync(path.dirname(resolvedOutputPath), {recursive: true});

    const contentLength = response.headers.get('content-length');
    if (fs.existsSync(resolvedOutputPath)) {
      if (options.continue && contentLength && fs.statSync(resolvedOutputPath).size < parseInt(contentLength, 10)) {
        // not implemented yet
        if (!options.quiet) logger.info(`-- Resuming download of ${filename} to ${resolvedOutputPath}`);
      } else if (!options.continue || !contentLength) {
        if (!options.quiet) logger.info(`-- File ${filename} already exists, overwriting to ${resolvedOutputPath}`);
      }
    } else {
      if (!options.quiet) logger.info(`-- Saving to: '${resolvedOutputPath}'`);
    }

    let body = response.body!;
    const progressId = `simple:${filename}:${Date.now()}`;
    if (options.progress) {
      let done = 0;
      const total = contentLength ? parseInt(contentLength, 10) : undefined;
      const MB = 1024*1024;

      statusReporter.start(progressId, filename, 'downloading', total, 'bytes');

      const updateProgressFn = total ? () => statusReporter.update(
        progressId,
        {
          current: done,
          phase: `downloading ${(done/MB).toFixed(1)}/${(total/MB).toFixed(1)} MiB`,
        }
      ) : () => statusReporter.update(
        progressId,
        { phase: `downloading ${(done/MB).toFixed(1)} MiB` }
      );

      body = body.pipeThrough(new TransformStream({
        async transform(chunk, controller) {
          controller.enqueue(chunk);
          done += chunk.length;
          updateProgressFn();
        },
      }));
    }

    try {
      await pipeline(body, fs.createWriteStream(resolvedOutputPath))
      if (options.progress) statusReporter.finish(progressId);
    } catch (error) {
      if (options.progress) statusReporter.finish(progressId, 'failed');
      throw error;
    }

    return filename;
  }
}

// In M3u8Downloader class
export interface M3U8Stream {
  url: string,
  kind: 'audio' | 'video' | 'subtitle',
}

interface CachedStream {
  stream: M3U8Stream;
  input: string;
  local: boolean;
}

interface PlaylistAsset {
  source: string;
  file: string;
  playlistLineIndex?: number;
  uriAttributeLineIndex?: number;
}

function shortHash(input: string): string {
  return createHash('sha1').update(input).digest('hex').slice(0, 12);
}

function extensionForUrl(url: string, fallback: string): string {
  const ext = path.extname(new URL(url).pathname);
  return ext || fallback;
}

async function fetchText(url: string, headers?: Record<string, string>): Promise<string> {
  const response = await mediaFetch(url, { headers });
  if (!response.ok) throw mediaHttpError(response, url, 'fetching');
  return response.text();
}

interface DownloadProgress {
  current: number;
  total?: number;
  resumedBytes: number;
}

async function downloadCachedFile(
  url: string,
  filename: string,
  headers?: Record<string, string>,
  onProgress?: (progress: DownloadProgress) => void,
): Promise<boolean> {
  const okFile = `${filename}.ok`;
  if (fs.existsSync(okFile) && fs.existsSync(filename) && fs.statSync(filename).size > 0) {
    const size = fs.statSync(filename).size;
    onProgress?.({ current: size, total: size, resumedBytes: size });
    return true;
  }

  fs.mkdirSync(path.dirname(filename), { recursive: true });
  const tmpFile = `${filename}.part`;
  const contentLength = await fetchContentLength(url, headers);

  if (contentLength !== undefined && fs.existsSync(filename) && fs.statSync(filename).size === contentLength) {
    fs.writeFileSync(okFile, String(Date.now()));
    onProgress?.({ current: contentLength, total: contentLength, resumedBytes: contentLength });
    return true;
  }

  if (contentLength !== undefined && fs.existsSync(tmpFile) && fs.statSync(tmpFile).size >= contentLength) {
    fs.renameSync(tmpFile, filename);
    fs.writeFileSync(okFile, String(Date.now()));
    onProgress?.({ current: contentLength, total: contentLength, resumedBytes: contentLength });
    return true;
  }

  let existingBytes = fs.existsSync(tmpFile) ? fs.statSync(tmpFile).size : 0;
  const requestHeaders: Record<string, string> = { ...(headers ?? {}) };
  if (existingBytes > 0) {
    requestHeaders.Range = `bytes=${existingBytes}-`;
  }
  onProgress?.({ current: existingBytes, total: contentLength, resumedBytes: existingBytes });

  let response = await mediaFetch(url, { headers: requestHeaders });
  if (response.status === 416 && contentLength !== undefined && existingBytes >= contentLength) {
    fs.renameSync(tmpFile, filename);
    fs.writeFileSync(okFile, String(Date.now()));
    onProgress?.({ current: contentLength, total: contentLength, resumedBytes: existingBytes });
    return true;
  }
  if (existingBytes > 0 && response.status !== 206) {
    fs.rmSync(tmpFile, { force: true });
    existingBytes = 0;
    response = await mediaFetch(url, { headers });
    onProgress?.({ current: 0, total: contentLength, resumedBytes: 0 });
  }
  if (!response.ok || !response.body) {
    throw mediaHttpError(response, url, 'downloading');
  }

  let currentBytes = existingBytes;
  const responseLength = response.headers.get('content-length');
  const responseTotal = responseLength ? Number(responseLength) + existingBytes : undefined;
  const totalBytes = contentLength ?? (responseTotal !== undefined && Number.isFinite(responseTotal) ? responseTotal : undefined);
  const body = response.body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      controller.enqueue(chunk);
      currentBytes += chunk.length;
      onProgress?.({ current: currentBytes, total: totalBytes, resumedBytes: existingBytes });
    },
  }));

  await pipeline(body, fs.createWriteStream(tmpFile, { flags: existingBytes > 0 ? 'a' : 'w' }));
  if (contentLength !== undefined && fs.statSync(tmpFile).size < contentLength) {
    throw new Error(`Incomplete download for ${url}: ${fs.statSync(tmpFile).size}/${contentLength} bytes`);
  }
  fs.renameSync(tmpFile, filename);
  fs.writeFileSync(okFile, String(Date.now()));
  onProgress?.({ current: totalBytes ?? fs.statSync(filename).size, total: totalBytes, resumedBytes: existingBytes });
  return false;
}

async function fetchContentLength(url: string, headers?: Record<string, string>): Promise<number | undefined> {
  try {
    const response = await mediaFetch(url, { method: 'HEAD', headers });
    if (!response.ok) return undefined;
    const value = response.headers.get('content-length');
    const length = value ? Number(value) : undefined;
    return length !== undefined && Number.isFinite(length) ? length : undefined;
  } catch {
    return undefined;
  }
}

async function runLimited<T>(items: T[], limit: number, worker: (item: T, index: number) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      await worker(items[index]!, index);
    }
  });
  await Promise.all(workers);
}

export class M3U8Downloader extends Downloadable {
  resolvedUrls?: M3U8Stream[] = undefined
  /**
   * Creates an M3U8 downloader.
   * NOTE: Requires FFMPEG to be installed and in the system's PATH.
   * @param m3u8Url The URL of the M3U8 playlist.
   * @param filenameHint The desired output filename.
   * @param headers An optional record of headers to send with the request (e.g., for cookies).
   */
  constructor(
    private unresolvedUrls: M3U8Stream[],
    private filename: string,
    private headers?: Record<string, string>,
  ) {
    super();
    if (!this.unresolvedUrls || this.unresolvedUrls.length === 0) {
      throw new Error("No M3U8 streams were provided to the downloader.");
    }

    for (const v of unresolvedUrls) {
      if (v.kind != 'audio' && v.kind != 'video' && v.kind != 'subtitle') {
        throw new Error(`Url is of unknown kind (${v.kind})`);
      }
    }
  }

  private async resolveHighestQualityStream(url: string, headers?: Record<string, string>): Promise<string> {
    try {
      const response = await mediaFetch(url, { headers });
      if (!response.ok) {
        logger.warn(`Could not fetch master playlist at ${url}. Status: ${response.status}. Falling back to original URL.`);
        return url;
      }
      const playlistText = await response.text();

      if (!playlistText.includes('#EXT-X-STREAM-INF')) {
        return url;
      }

      const streams: { url: string; bandwidth: number }[] = [];
      const lines = playlistText.trim().split('\n');

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i]!;
        if (line.startsWith('#EXT-X-STREAM-INF')) {
          // The next line is the URL for this stream variant.
          const streamUrlLine = lines[i + 1];
          if (streamUrlLine) {
            const bandwidthMatch = line.match(/BANDWIDTH=(\d+)/);
            const bandwidth = bandwidthMatch ? parseInt(bandwidthMatch[1]!, 10) : 0;
            
            // Resolve the URL (it might be relative)
            const resolvedStreamUrl = new URL(streamUrlLine, url).href;
            
            streams.push({ url: resolvedStreamUrl, bandwidth });
          }
        }
      }

      if (streams.length === 0) {
        return url; // No variants found, return original.
      }

      // Sort by bandwidth in descending order to find the best stream
      streams.sort((a, b) => b.bandwidth - a.bandwidth);
      
      const bestStream = streams[0]!;
      logger.info(`Resolved the highest quality stream with bandwidth ${bestStream.bandwidth} for url \nfrom: ${url}\nto  : ${bestStream.url}`);
      return bestStream.url;

    } catch (error) {
      logger.error(`Error resolving highest quality stream for ${url}:`, error);
      // Fallback to the original URL on any error
      return url;
    }
  }

  private collectPlaylistAssets(playlistText: string, playlistUrl: string, cacheDir: string): { lines: string[], assets: PlaylistAsset[] } {
    const lines = playlistText.trim().split(/\r?\n/);
    const assets: PlaylistAsset[] = [];
    const sourceFiles = new Map<string, string>();
    let assetIndex = 0;

    const nextAssetFile = (source: string, fallbackExt: string) => {
      const existing = sourceFiles.get(source);
      if (existing) return existing;
      const ext = extensionForUrl(source, fallbackExt);
      const file = path.join(cacheDir, 'assets', `${String(assetIndex++).padStart(5, '0')}-${shortHash(source)}${ext}`);
      sourceFiles.set(source, file);
      return file;
    };

    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!.trim();
      if (!line) continue;

      if (line.startsWith('#')) {
        const uriMatch = line.match(/URI="([^"]+)"/);
        if (uriMatch?.[1]) {
          const source = new URL(uriMatch[1], playlistUrl).href;
          const file = nextAssetFile(source, '.bin');
          assets.push({ source, file, uriAttributeLineIndex: index });
        }
        continue;
      }

      const source = new URL(line, playlistUrl).href;
      const file = nextAssetFile(source, '.ts');
      assets.push({ source, file, playlistLineIndex: index });
    }

    return { lines, assets };
  }

  private async cachePlaylist(
    stream: M3U8Stream,
    streamIndex: number,
    cacheDir: string,
    streamTaskId: string,
    streamName: string,
    showProgress: boolean,
  ): Promise<CachedStream> {
    if (showProgress) {
      statusReporter.start(streamTaskId, `${this.filename} [${streamName}]`, 'preparing');
    }

    try {
    if (stream.kind === 'subtitle') {
      const subtitleFile = path.join(cacheDir, `subtitle-${streamIndex}${extensionForUrl(stream.url, '.vtt')}`);
      statusReporter.update(streamTaskId, { current: 0, total: 1, unit: 'count', phase: 'caching subtitle' });
      const skipped = await downloadCachedFile(stream.url, subtitleFile, this.headers);
      statusReporter.update(streamTaskId, { current: 1, total: 1, unit: 'count', phase: skipped ? 'cached subtitle' : 'downloaded subtitle' });
      return { stream, input: subtitleFile, local: true };
    }

    const playlistText = await fetchText(stream.url, this.headers);
    if (!playlistText.includes('#EXTM3U')) {
      logger.warn(`Playlist did not look like an m3u8 file, falling back to direct ffmpeg input for ${stream.url}`);
      statusReporter.update(streamTaskId, { phase: 'using remote stream', current: undefined, total: undefined });
      return { stream, input: stream.url, local: false };
    }

    const streamCacheDir = path.join(cacheDir, `stream-${streamIndex}-${stream.kind}`);
    const { lines, assets } = this.collectPlaylistAssets(playlistText, stream.url, streamCacheDir);
    const uniqueAssets = [...new Map(assets.map(asset => [asset.source, asset])).values()];
    const segmentLimit = Math.max(1, Number(process.env.ECHO_SEGMENT_CONCURRENCY ?? 8) || 8);
    let completed = 0;
    let reused = 0;

    statusReporter.update(streamTaskId, {
      current: 0,
      total: uniqueAssets.length,
      unit: 'count',
      phase: 'caching segments',
    });

    await runLimited(uniqueAssets, segmentLimit, async (asset) => {
      const skipped = await downloadCachedFile(asset.source, asset.file, this.headers, ({ current, total, resumedBytes }) => {
        statusReporter.update(streamTaskId, {
          current,
          total,
          unit: 'bytes',
          phase: resumedBytes > 0 ? 'resuming' : 'downloading',
        });
      });
      if (skipped) reused += 1;
      completed += 1;
      statusReporter.update(streamTaskId, {
        current: completed,
        total: uniqueAssets.length,
        unit: 'count',
        phase: `cached segments (${reused} reused)`,
      });
    });

    const localPlaylist = path.join(streamCacheDir, 'playlist.m3u8');
    const localPlaylistDir = path.dirname(localPlaylist);

    for (const asset of assets) {
      const localUrl = path.relative(localPlaylistDir, asset.file).split(path.sep).join('/');
      if (asset.playlistLineIndex !== undefined) {
        lines[asset.playlistLineIndex] = localUrl;
      }
      if (asset.uriAttributeLineIndex !== undefined) {
        lines[asset.uriAttributeLineIndex] = lines[asset.uriAttributeLineIndex]!.replace(/URI="[^"]+"/, `URI="${localUrl}"`);
      }
    }

    fs.mkdirSync(path.dirname(localPlaylist), { recursive: true });
    fs.writeFileSync(localPlaylist, lines.join('\n') + '\n');

    return { stream, input: localPlaylist, local: true };
    } finally {
      statusReporter.remove(streamTaskId);
    }
  }

  async download(options: Partial<DownloadOptions> = {}): Promise<string | null> {
    if (options.checkExistence && fs.existsSync(path.join(options.checkExistence, this.filename))) {
      return null;
    }

    const outputPath = options.output || './';
    const resolvedOutputPath = path.join(outputPath, this.filename);
    fs.mkdirSync(path.dirname(resolvedOutputPath), {recursive: true});

    if (!this.resolvedUrls) {
      this.resolvedUrls = await Promise.all(
        this.unresolvedUrls.map(async (stream) => {
          if (stream.kind == 'subtitle') return stream;
          return { ...stream, url: await this.resolveHighestQualityStream(stream.url, this.headers) };
        })
      );
    }

    const progressId = `m3u8:${this.filename}:${Date.now()}`;
    if (options.progress) {
      statusReporter.start(progressId, this.filename, 'preparing');
    }

    const cacheDir = `${resolvedOutputPath}.cache`;
    const streamCounts: Record<M3U8Stream['kind'], number> = { audio: 0, video: 0, subtitle: 0 };
    const cachedStreams: CachedStream[] = [];
    for (let index = 0; index < this.resolvedUrls.length; index++) {
      const stream = this.resolvedUrls[index]!;
      streamCounts[stream.kind] += 1;
      const ordinal = streamCounts[stream.kind];
      const streamName = stream.kind === 'video' && ordinal > 1 ? `video ${ordinal}` : stream.kind;
      cachedStreams.push(await this.cachePlaylist(
        stream,
        index,
        cacheDir,
        `${progressId}:stream:${index}`,
        streamName,
        Boolean(options.progress),
      ));
    }

    const args: string[] = [
      '-hide_banner',
      '-loglevel', 'error',
      '-nostats',
      '-progress', 'pipe:2',
    ];

    const headerArgs = this.headers
      ? ['-headers', Object.entries(this.headers).map(([key, value]) => `${key}: ${value}`).join('\r\n')]
      : []
    ;

    fs.rmSync(resolvedOutputPath, { force: true });

    for (const cachedStream of cachedStreams) {
      if (cachedStream.local) {
        args.push('-protocol_whitelist', 'file,crypto,data', '-i', cachedStream.input);
      } else {
        args.push(
          '-reconnect', '1',
          '-reconnect_streamed', '1',
          '-reconnect_delay_max', '5',
          '-http_multiple', '1',
          ...headerArgs,
          '-i', cachedStream.input,
        );
      }
    }

    cachedStreams.forEach(({stream}, index) => {
      args.push('-map', `${index}:${stream.kind[0]?.toLowerCase()}`);
    });

    if (cachedStreams.some(s => s.stream.kind === 'video')) args.push('-c:v', 'copy');
    if (cachedStreams.some(s => s.stream.kind === 'audio')) args.push('-c:a', 'copy');
    if (cachedStreams.some(s => s.stream.kind === 'subtitle')) args.push('-c:s', 'mov_text');
    args.push('-y', resolvedOutputPath);

    logger.verbose(`Executing ffmpeg with ${cachedStreams.length} inputs for ${this.filename}`);
    statusReporter.update(progressId, { phase: 'muxing', current: undefined, total: undefined });

    return await new Promise((resolve, reject) => {
      const child = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let stderr = '';
      let lastOutTime = '';
      let lastSpeed = '';

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => {
        stderr += chunk;
        if (stderr.length > 20_000) stderr = stderr.slice(-20_000);

        for (const line of chunk.split(/\r?\n/)) {
          const [key, value] = line.split('=', 2);
          if (!key || value == null) continue;
          if (key === 'out_time') lastOutTime = value;
          if (key === 'speed') lastSpeed = value;
        }

        if (options.progress) {
          const detail = [lastOutTime && `t=${lastOutTime}`, lastSpeed && `speed=${lastSpeed}`].filter(Boolean).join(' ');
          statusReporter.update(progressId, { phase: `muxing ${detail || ''}`.trim() });
        }
      });

      child.on('error', (error: Error) => {
        if (options.progress) statusReporter.finish(progressId, 'failed');
        reject(error);
      });

      child.on('close', (code: number | null, signal: string | null) => {
        if (code === 0) {
          if (options.progress) statusReporter.finish(progressId);
          resolve(this.filename);
          return;
        }

        if (options.progress) statusReporter.finish(progressId, 'failed');
        const reason = signal ? `signal ${signal}` : `exit code ${code}`;
        logger.error(`FFMPEG Error while combining streams for ${this.filename}: ${stderr.trim()}`);
        reject(new Error(`FFMPEG failed for ${this.filename} with ${reason}`));
      });
    });
  }
}

export type DownloadTask = undefined | Downloadable | Promise<Downloadable | undefined> | (() => Downloadable | undefined) | (() => Promise<Downloadable | undefined>);
export interface DownloaderOptions {
  maxRetries: number
  outdir: string
  callback?: (link?: Downloadable, error?: any) => void
}

class Job {
  link: Downloadable | undefined
  done: boolean = false
  skipped: boolean = false
  skipReason?: string

  constructor(
    private dltype: DownloadTask,
    public options: DownloaderOptions,
    public onDoneFn: (link?: Downloadable, error?: any) => void,
    public label?: string,
  ) {}

  async getLink(): Promise<void> {
    if (this.link) return;
    if (this.dltype === undefined || this.dltype instanceof Downloadable || this.dltype instanceof Promise) {
      this.link = await this.dltype;
    } else {
      this.link = await this.dltype();
    }
  }

  private resetLinkForRetry(): void {
    if (typeof this.dltype === 'function') this.link = undefined;
  }

  async download(): Promise<void> {
    if (this.done) return;
    try {
      await this.getLink();

      // We succeced but there was no link
      if (!this.link) {
        this.done = true;
        this.skipped = true;
        this.skipReason = 'download factory returned no downloadable media';
        this.onDoneFn(this.link);
        return;
      }

      const tempOutput = path.join(this.options.outdir, '.partial');
      fs.mkdirSync(tempOutput, {recursive: true});

      const outFile = await this.link.download({output: tempOutput, checkExistence: this.options.outdir, quiet: true, progress: true, continue: true});

      if (outFile === null) {
        this.skipped = true;
        this.skipReason = this.link.skipReason || 'destination file already exists';
        this.onDoneFn(this.link);
        this.done = true;
        return;
      }

      const output = path.join(this.options.outdir, outFile);
      fs.mkdirSync(path.dirname(output), {recursive: true});
      fs.renameSync(path.join(tempOutput, outFile), output);
      fs.rmSync(path.join(tempOutput, `${outFile}.cache`), {recursive: true, force: true});

      this.onDoneFn(this.link);
      this.done = true;
    } catch (e) {
      this.onDoneFn(this.link, e);
      this.resetLinkForRetry();
      throw e;
    }
  }

  toString(): string {
    return JSON.stringify({
      link: this.link,
      options: this.options,
      done: this.done,
    }, null, 2)
  }
}

export class Downloader {
  // Modifications are not intended
  running: number = 0
  // Modifications are not intended
  pending: Job[] = []
  completed: number = 0
  skipped: number = 0
  failed: number = 0
  skipDetails: Array<{ label?: string; reason: string }> = []
  private idleResolvers: Array<() => void> = []

  constructor(private _concurrentDownloads: number, public options: DownloaderOptions) {
    this.options.callback = this.options.callback ?? (() => {})
    const configuredHttp = Number(process.env.ECHO_HTTP_CONCURRENCY);
    const httpConcurrency = Number.isInteger(configuredHttp) && configuredHttp > 0
      ? configuredHttp
      : Math.max(2, this._concurrentDownloads * 2);
    setMediaRequestConcurrency(httpConcurrency);
    statusReporter.setJobs(this.running, this.pending.length, this.completed, this.skipped, this.failed);
  }

  get concurrentDownloads(): number {
    return this._concurrentDownloads;
  }

  set concurrentDownloads(count: number) {
    this._concurrentDownloads = count;
    this.reprocess();
  }

  // The options currently specified will take effect on these entries
  add(...downloads: (DownloadTask | {download: DownloadTask, callback?: (link?: Downloadable, error?: any) => void, label?: string})[]): void {
    this.pending.push(...downloads.map(d => {
      if (d === undefined || d instanceof Downloadable || d instanceof Promise || typeof d === 'function') {
        return new Job(d, this.options, (link?: Downloadable, error?: any) => {
          try {
            this.options.callback!(link, error)
          } catch (e) {
            logger.error('callback errored:', e)
          }
        })
      } else {
        return new Job(d.download, this.options, (link?: Downloadable, error?: any) => {
          try {
            d.callback?.(link, error)
          } catch (e) {
            logger.error('callback errored:', e)
          }
        }, d.label)
      }
    }));
    statusReporter.setJobs(this.running, this.pending.length, this.completed, this.skipped, this.failed);
    this.reprocess();
  }

  idle(): Promise<void> {
    if (this.running === 0 && this.pending.length === 0) {
      statusReporter.close();
      return Promise.resolve();
    }

    return new Promise(resolve => {
      this.idleResolvers.push(resolve);
    });
  }

  private resolveIdleIfNeeded() {
    statusReporter.setJobs(this.running, this.pending.length, this.completed, this.skipped, this.failed);
    if (this.running !== 0 || this.pending.length !== 0) return;
    const resolvers = this.idleResolvers.splice(0);
    if (resolvers.length) statusReporter.close();
    for (const resolve of resolvers) resolve();
  }

  private reprocess() {
    statusReporter.setJobs(this.running, this.pending.length, this.completed, this.skipped, this.failed);
    while (this.running < this._concurrentDownloads && this.pending.length) {
      this.running += 1;
      const job = this.pending.shift()!;
      statusReporter.setJobs(this.running, this.pending.length, this.completed, this.skipped, this.failed);

      (async() => {
        let errorCount = 0

        while(errorCount < this.options.maxRetries && !job.done) {
          try {
            await job.download();
          } catch (e) {
            errorCount += 1;
            logger.warn('job error: ', e);
          }
        }

        this.running -= 1;
        if (!job.done) {
          this.failed += 1;
          logger.error('Too many errors, aborting download for: ', job.toString())
        } else if (job.skipped) {
          this.skipped += 1;
          const reason = job.skipReason || 'unspecified reason';
          this.skipDetails.push({ label: job.label, reason });
          const subject = job.label ? ` ${job.label}` : '';
          logger.info(`SKIP${subject} — ${reason}`);
        } else {
          this.completed += 1;
        }
        this.reprocess();
        this.resolveIdleIfNeeded();
      })()
    }
    this.resolveIdleIfNeeded();
  }
}
