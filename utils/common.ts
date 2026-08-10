'use strict';
import { parse, type HTMLElement } from "node-html-parser";
import logger from "./logger.js";

export interface FetchResponse {
  bodyUsed: true,
  headers: Headers;
  ok: boolean;
  redirected: boolean;
  status: number;
  statusText: string;
  url: string;
}

export type RequestInfo = Request | string;

export async function fetchResponse(input: RequestInfo | URL, init?: RequestInit): Promise<FetchResponse & {body: string}> {
  const response = await fetch(input, init);
  return {
    headers: response.headers,
    ok: response.ok,
    redirected: response.redirected,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    body: await response.text(),
    bodyUsed: true,
  };
}

export async function fetchJson(input: RequestInfo | URL, init?: RequestInit): Promise<FetchResponse & {json: any}> {
  const response = await fetch(input, init);
  if (!response.ok) throw new Error(`HTTP Error! status: ${response.status}\nBody: ${await response.text()}`);
  return {
    headers: response.headers,
    ok: response.ok,
    redirected: response.redirected,
    status: response.status,
    statusText: response.statusText,
    url: response.url,
    json: await response.json(),
    bodyUsed: true,
  };
}

export async function fetchHtmlResponse(input: RequestInfo | URL, init?: RequestInit, errorOnBadResponse: boolean = true): Promise<FetchResponse & {body: string, dom: HTMLElement}> {
  const response = await fetchResponse(input, init);
  if (!response.ok && errorOnBadResponse) throw new Error(`HTTP Error! status: ${response.status}\nBody: ${response.body}`);
  logger.debug("HTML:", response.body);
  return { ...response, dom: parse(response.body) };
}

export function empty() {}
