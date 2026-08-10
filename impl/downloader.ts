'use strict';
import { fetchHtmlResponse } from '../utils/common.js';
import logger from '../utils/logger.js';
import type { Echo360Data } from './downloader_schema.js';
import { M3U8Downloader, SkippedDownload, type M3U8Stream } from '../utils/downloader.js';
import { cloudFrontCookieExpiry, getSetCookieHeaders, mergeSetCookies } from './auth.js';
import { assertTokenValid, TOKEN_HELP } from './token.js';

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

function createEcho360DownloadFromSession(session: EchoPageSession, pageUrl: string, outputPath: string): M3U8Downloader | SkippedDownload {
  const data = session.data;
  if (data.video == null) {
    return new SkippedDownload('Echo player reports no downloadable video for this lesson');
  }

  const streams = data.video.playableMedias.filter(media => media.trackType.length === 1);
  const convertedStreams: M3U8Stream[] = streams.map(media => ({
    url: media.uri,
    kind: media.trackType[0]?.toLowerCase() as M3U8Stream['kind'],
  }));
  if (data.captions) convertedStreams.push({ url: data.captions, kind: 'subtitle' });

  if (!convertedStreams.length) {
    return new SkippedDownload('Echo player returned no playable media streams');
  }

  return new M3U8Downloader(convertedStreams, outputPath, {
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
): Promise<M3U8Downloader | SkippedDownload> {
  const session = await getPageSession(url, cookie);
  if (!session) throw new Error(`Failed to get player data for ${url}`);
  return createEcho360DownloadFromSession(session, url, outputPath);
}
