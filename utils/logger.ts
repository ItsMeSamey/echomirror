'use strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { empty } from './common.js';
import { writeTerminalLine } from './terminal.js';

export enum LogLevel {
  debug = 0,
  verbose = 1,
  info = 2,
  warn = 3,
  error = 4,
}

export interface Logger {
  debug: (...args: any[]) => void;
  verbose: (...args: any[]) => void;
  info: (...args: any[]) => void;
  warn: (...args: any[]) => void;
  error: (...args: any[]) => void;
}

function stringifyArgs(args: any[]) {
  return args.map((arg: any) => {
    if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
    if (typeof arg === 'object' && arg !== null) {
      try { return JSON.stringify(arg, null, 2); } catch { return String(arg); }
    }
    return arg;
  }).map(String).join(' ') + '\n';
}

export function getLogger(consoleLevel: LogLevel = LogLevel.info, fileLevel: LogLevel = LogLevel.debug, logFile = 'log.log'): Logger {
  writeFileSync(logFile, '');

  const make = (level: LogLevel, prefix: string) => (...args: any[]) => {
    const text = stringifyArgs(args);
    if (consoleLevel <= level) writeTerminalLine(text.trimEnd());
    if (fileLevel <= level) appendFileSync(logFile, `[${prefix}]` + text);
  };

  return {
    debug: consoleLevel <= LogLevel.debug || fileLevel <= LogLevel.debug ? make(LogLevel.debug, 'debug') : empty,
    verbose: consoleLevel <= LogLevel.verbose || fileLevel <= LogLevel.verbose ? make(LogLevel.verbose, 'verbose') : empty,
    info: consoleLevel <= LogLevel.info || fileLevel <= LogLevel.info ? make(LogLevel.info, 'info') : empty,
    warn: consoleLevel <= LogLevel.warn || fileLevel <= LogLevel.warn ? make(LogLevel.warn, 'warn') : empty,
    error: consoleLevel <= LogLevel.error || fileLevel <= LogLevel.error ? make(LogLevel.error, 'error') : empty,
  };
}

const logger = getLogger();
export default logger;
