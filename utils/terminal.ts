import { logAboveProgress } from './progress.js';

/** Print a permanent line without corrupting active download progress bars. */
export function writeTerminalLine(text: string): void {
  if (!text || logAboveProgress(text)) return;
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
}
