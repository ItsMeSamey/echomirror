import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { execa } from 'execa';
import { fetchHtmlResponse } from '../utils/common.js';
import logger from '../utils/logger.js';
import { clearTerminalStatus, setTerminalStatus } from '../utils/terminal.js';
import { cloudFrontCookieExpiry, getSetCookieHeaders, mergeSetCookies } from './auth.js';
import { assertTokenValid, TOKEN_HELP } from './token.js';

interface Echo360Data {
  readonly captions?: string;
  readonly video?: {
    readonly duration: string;
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

function durationSeconds(value: string): number | undefined {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parts = value.split(':').map(Number);
  if (parts.some(part => !Number.isFinite(part))) return undefined;
  return parts.reduce((total, part) => total * 60 + part, 0) || undefined;
}

class EchoDownload {
  constructor(
    private readonly streams: readonly MediaStream[],
    private readonly destination: string,
    private readonly headers: Readonly<Record<string, string>>,
    private readonly duration?: number,
  ) {}

  async download(): Promise<void> {
    await mkdir(path.dirname(this.destination), { recursive: true });
    const extension = path.extname(this.destination) || '.mp4';
    const temporary = path.join(path.dirname(this.destination), `.${path.basename(this.destination, extension)}.part${extension}`);
    await rm(temporary, { force: true });

    const args = ['-hide_banner', '-loglevel', 'error', '-progress', 'pipe:2'];
    const headers = Object.entries(this.headers).map(([name, value]) => `${name}: ${value}`).join('\r\n');
    for (const stream of this.streams) {
      args.push('-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '5');
      if (headers) args.push('-headers', headers);
      args.push('-i', stream.url);
    }
    this.streams.forEach((stream, index) => args.push('-map', `${index}:${stream.kind[0]}`));
    if (this.streams.some(stream => stream.kind === 'video')) args.push('-c:v', 'copy');
    if (this.streams.some(stream => stream.kind === 'audio')) args.push('-c:a', 'copy');
    if (this.streams.some(stream => stream.kind === 'subtitle')) args.push('-c:s', 'mov_text');
    args.push('-y', temporary);

    const subprocess = execa('ffmpeg', args, { stdout: 'ignore', stderr: 'pipe' });
    const label = path.basename(this.destination);
    setTerminalStatus(`[${' '.repeat(24)}] preparing ${label}`);
    try {
      for await (const line of subprocess.iterable({ from: 'stderr' })) {
        if (!line.startsWith('out_time_us=')) continue;
        const current = Number(line.slice('out_time_us='.length)) / 1_000_000;
        if (this.duration) {
          const ratio = Math.min(1, current / this.duration);
          const complete = Math.round(ratio * 24);
          setTerminalStatus(`[${'='.repeat(complete)}${' '.repeat(24 - complete)}] ${Math.round(ratio * 100)}% ${label}`);
        } else {
          const position = Math.floor(current) % 24;
          setTerminalStatus(`[${' '.repeat(position)}>${' '.repeat(23 - position)}] ${Math.floor(current)}s ${label}`);
        }
      }
      await subprocess;
      await rename(temporary, this.destination);
    } finally {
      clearTerminalStatus();
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
  assertTokenValid(cookie);
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
  }, durationSeconds(data.video.duration));
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
