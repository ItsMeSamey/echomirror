import { mkdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { fetchHtmlResponse } from '../utils/common.js';
import logger from '../utils/logger.js';
import { createByteProgress } from '../utils/progress.js';
import { cloudFrontCookieExpiry, getSetCookieHeaders, mergeSetCookies } from './auth.js';
import { TOKEN_HELP } from './token.js';

interface Echo360Data {
  readonly captions?: string;
  readonly video?: {
    readonly playableMedias: ReadonlyArray<{
      readonly uri: string;
      readonly trackType: readonly string[];
    }>;
  };
}

interface MediaStream {
  readonly url: string;
  readonly kind: 'audio' | 'video' | 'subtitle';
}

export class SkippedDownload {
  constructor(readonly skipReason: string) {}
}

class EchoDownload {
  constructor(
    private readonly streams: readonly MediaStream[],
    private readonly destination: string,
    private readonly headers: Readonly<Record<string, string>>,
  ) {}

  private async runFfmpeg(args: string[], label: string, output: string, totalBytes: number): Promise<void> {
    const subprocess = execa('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], {
      stdout: 'ignore',
      stderr: 'pipe',
    });
    const progress = createByteProgress(label, totalBytes);
    let done = false;
    let failure: unknown;
    const completion = subprocess.then(
      () => undefined,
      error => { failure = error; },
    ).finally(() => { done = true; });
    try {
      while (!done) {
        await new Promise(resolve => setTimeout(resolve, 100));
        progress.update(await stat(output).then(info => info.size).catch(() => 0));
      }
      await completion;
      if (failure) throw failure;
      progress.update(totalBytes);
      await new Promise(resolve => setTimeout(resolve, 100));
    } finally {
      progress.close();
    }
  }

  private async resolveAssetUrl(stream: MediaStream): Promise<string> {
    if (stream.kind === 'subtitle') return stream.url;

    const masterResponse = await fetch(stream.url, { headers: this.headers });
    if (!masterResponse.ok) throw new Error(`Failed to fetch HLS manifest: HTTP ${masterResponse.status}`);
    const master = await masterResponse.text();
    const masterLines = master.split(/\r?\n/);
    const variants: Array<{ score: number; url: string }> = [];
    for (let index = 0; index < masterLines.length; index += 1) {
      const attributes = masterLines[index];
      if (!attributes?.startsWith('#EXT-X-STREAM-INF:')) continue;
      const relative = masterLines.slice(index + 1).find(line => line.length > 0 && !line.startsWith('#'));
      if (!relative) continue;
      const resolution = attributes.match(/RESOLUTION=(\d+)x(\d+)/);
      const pixels = Number(resolution?.[1] ?? 0) * Number(resolution?.[2] ?? 0);
      const bandwidth = Number(attributes.match(/(?:^|[:,])BANDWIDTH=(\d+)/)?.[1] ?? 0);
      variants.push({ score: pixels * 1_000_000 + bandwidth, url: new URL(relative, stream.url).href });
    }

    const playlistUrl = variants.sort((left, right) => right.score - left.score)[0]?.url ?? stream.url;
    const playlistResponse = await fetch(playlistUrl, { headers: this.headers });
    if (!playlistResponse.ok) throw new Error(`Failed to fetch HLS playlist: HTTP ${playlistResponse.status}`);
    const playlist = await playlistResponse.text();
    const assets = playlist.split(/\r?\n/)
      .filter(line => line.length > 0 && !line.startsWith('#'))
      .map(line => new URL(line, playlistUrl).href);
    const uniqueAssets = [...new Set(assets)];
    if (!playlist.includes('#EXT-X-BYTERANGE:') || uniqueAssets.length !== 1) {
      throw new Error('Echo returned an unsupported non-byte-range HLS playlist');
    }
    return uniqueAssets[0]!;
  }

  private async contentLength(url: string): Promise<number | undefined> {
    try {
      const response = await fetch(url, { method: 'HEAD', headers: this.headers });
      const length = Number(response.headers.get('content-length'));
      return response.ok && Number.isFinite(length) && length > 0 ? length : undefined;
    } catch {
      return undefined;
    }
  }

  private async downloadWithCurl(url: string, output: string, label: string): Promise<void> {
    const total = await this.contentLength(url);
    const progress = createByteProgress(label, total);
    const args = ['--fail', '--location', '--silent', '--show-error'];
    for (const [name, value] of Object.entries(this.headers)) args.push('--header', `${name}: ${value}`);
    args.push('--output', output, url);
    const subprocess = execa('curl', args, { stdout: 'ignore', stderr: 'pipe' });
    let done = false;
    let failure: unknown;
    const completion = subprocess.then(
      () => undefined,
      error => { failure = error; },
    ).finally(() => { done = true; });
    try {
      while (!done) {
        await new Promise(resolve => setTimeout(resolve, 100));
        const size = await stat(output).then(info => info.size).catch(() => 0);
        progress.update(size);
      }
      await completion;
      if (failure) throw failure;
      progress.update(total ?? await stat(output).then(info => info.size));
      await new Promise(resolve => setTimeout(resolve, 100));
    } finally {
      progress.close();
    }
  }

  private async downloadComponent(stream: MediaStream, index: number, ordinal: number, directory: string): Promise<string> {
    const component = stream.kind === 'video' ? `video-${index}.mkv`
      : stream.kind === 'audio' ? `audio-${index}.mka`
      : `subtitle-${index}.vtt`;
    const output = path.join(directory, component);
    const label = `${path.basename(this.destination)} · ${stream.kind} ${ordinal}`;
    await this.downloadWithCurl(await this.resolveAssetUrl(stream), output, label);
    return output;
  }

  async download(): Promise<void> {
    await mkdir(path.dirname(this.destination), { recursive: true });
    const extension = path.extname(this.destination) || '.mp4';
    const temporary = path.join(path.dirname(this.destination), `.${path.basename(this.destination, extension)}.part${extension}`);
    const components = `${temporary}.components`;
    await rm(temporary, { force: true });
    await rm(components, { recursive: true, force: true });
    await mkdir(components, { recursive: true });
    try {
      const counts: Record<MediaStream['kind'], number> = { video: 0, audio: 0, subtitle: 0 };
      const files = await Promise.all(this.streams.map((stream, index) => {
        counts[stream.kind] += 1;
        return this.downloadComponent(stream, index, counts[stream.kind], components);
      }));
      const args = files.flatMap(file => ['-i', file]);
      this.streams.forEach((stream, index) => args.push('-map', `${index}:${stream.kind[0]}:0`));
      args.push('-c:v', 'copy', '-c:a', 'copy');
      if (this.streams.some(stream => stream.kind === 'subtitle')) args.push('-c:s', 'mov_text');
      args.push('-y', temporary);
      const totalBytes = (await Promise.all(files.map(file => stat(file)))).reduce((sum, info) => sum + info.size, 0);
      await this.runFfmpeg(args, `${path.basename(this.destination)} · mux`, temporary, totalBytes);
      await rename(temporary, this.destination);
    } finally {
      await rm(components, { recursive: true, force: true });
    }
  }
}

export interface EchoPageSession {
  data: Echo360Data;
  cookie: string;
}

function parsePlayerData(htmlScripts: string[]): Echo360Data | undefined {
  const dataScript = htmlScripts.find(text => text.includes('Echo["echoPlayerV2FullApp"]'));
  if (!dataScript) return undefined;

  const jsonMatch = dataScript.match(/Echo\["echoPlayerV2FullApp"\]\("(.+)"\)/);
  if (!jsonMatch?.[1]) return undefined;

  try {
    return JSON.parse(JSON.parse('"' + jsonMatch[1] + '"')) as Echo360Data;
  } catch (error) {
    logger.error('Failed to parse player JSON: ' + error);
    return undefined;
  }
}

export async function getPageSession(url: string, cookie: string): Promise<EchoPageSession | undefined> {
  logger.verbose('Fetching lesson page: ' + url);
  let response;
  try {
    response = await fetchHtmlResponse(url, {
      headers: {
        Cookie: cookie,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        Referer: 'https://echo360.net.au/',
      },
    });
  } catch (error) {
    if (error instanceof Error && /status:\s*403\b/i.test(error.message)) {
      throw new Error(`Echo360 rejected ./cookies with HTTP 403; the cookie is expired or invalid.\n${TOKEN_HELP}`);
    }
    throw error;
  }

  const renewedCookie = mergeSetCookies(cookie, getSetCookieHeaders(response.headers));
  const data = parsePlayerData(response.dom.querySelectorAll('script').map(script => script.text));
  if (!data) {
    logger.error('Could not find/extract player data. The Echo token may be missing, invalid, or expired.');
    return;
  }

  const oldExpiry = cloudFrontCookieExpiry(cookie);
  const newExpiry = cloudFrontCookieExpiry(renewedCookie);
  if (newExpiry && (!oldExpiry || newExpiry.getTime() > oldExpiry.getTime())) {
    logger.verbose(`Echo360 renewed media authorization through ${newExpiry.toISOString()}.`);
  }

  return { data, cookie: renewedCookie };
}

function createEcho360DownloadFromSession(session: EchoPageSession, pageUrl: string, outputPath: string): EchoDownload | SkippedDownload {
  const data = session.data;
  if (data.video == null) {
    return new SkippedDownload('Echo player reports no downloadable video for this lesson');
  }

  const convertedStreams: MediaStream[] = data.video.playableMedias.flatMap(media => {
    const kind = media.trackType.length === 1 ? media.trackType[0]?.toLowerCase() : undefined;
    return kind === 'audio' || kind === 'video' ? [{ url: media.uri, kind }] : [];
  });
  if (data.captions) convertedStreams.push({ url: data.captions, kind: 'subtitle' });

  if (!convertedStreams.length) {
    return new SkippedDownload('Echo player returned no playable media streams');
  }

  return new EchoDownload(convertedStreams, outputPath, {
    Cookie: session.cookie,
    Referer: pageUrl,
    Origin: 'https://echo360.net.au',
    Accept: '*/*',
  });
}

export async function createEcho360Download(
  url: string,
  cookie: string,
  outputPath: string,
): Promise<EchoDownload | SkippedDownload> {
  const session = await getPageSession(url, cookie);
  if (!session) throw new Error(`Failed to get player data for ${url}`);
  return createEcho360DownloadFromSession(session, url, outputPath);
}
