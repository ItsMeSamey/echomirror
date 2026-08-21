import { appendFileSync, writeFileSync } from 'node:fs';
import { writeTerminalLine } from './terminal.js';

export enum LogLevel {
  debug = 0,
  verbose = 1,
  info = 2,
  warn = 3,
  error = 4,
}

export interface Logger {
  debug: (...args: unknown[]) => void;
  verbose: (...args: unknown[]) => void;
  info: (...args: unknown[]) => void;
  warn: (...args: unknown[]) => void;
  error: (...args: unknown[]) => void;
}

function stringifyArgs(args: unknown[]) {
  return args.map((arg: unknown) => {
    if (arg instanceof Error) return arg.stack || `${arg.name}: ${arg.message}`;
    if (typeof arg === 'object' && arg !== null) {
      try { return JSON.stringify(arg, null, 2); } catch { return String(arg); }
    }
    return arg;
  }).map(String).join(' ') + '\n';
}

const ignore = (..._args: unknown[]): void => {};

export function getLogger(
  consoleLevel: LogLevel = LogLevel.info,
  logFile: string | undefined = process.env.ECHO_LOG,
  fileLevel: LogLevel = LogLevel.debug,
): Logger {
  if (logFile) writeFileSync(logFile, '');

  const make = (level: LogLevel, prefix: string) => (...args: unknown[]) => {
    const text = stringifyArgs(args);
    if (consoleLevel <= level) writeTerminalLine(text.trimEnd());
    if (logFile && fileLevel <= level) appendFileSync(logFile, `[${prefix}]` + text);
  };

  return {
    debug: consoleLevel <= LogLevel.debug || (Boolean(logFile) && fileLevel <= LogLevel.debug) ? make(LogLevel.debug, 'debug') : ignore,
    verbose: consoleLevel <= LogLevel.verbose || (Boolean(logFile) && fileLevel <= LogLevel.verbose) ? make(LogLevel.verbose, 'verbose') : ignore,
    info: consoleLevel <= LogLevel.info || (Boolean(logFile) && fileLevel <= LogLevel.info) ? make(LogLevel.info, 'info') : ignore,
    warn: consoleLevel <= LogLevel.warn || (Boolean(logFile) && fileLevel <= LogLevel.warn) ? make(LogLevel.warn, 'warn') : ignore,
    error: consoleLevel <= LogLevel.error || (Boolean(logFile) && fileLevel <= LogLevel.error) ? make(LogLevel.error, 'error') : ignore,
  };
}

const logger = getLogger();
export default logger;
