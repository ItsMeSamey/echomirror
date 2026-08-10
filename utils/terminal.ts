let statusLine: string | undefined;
let statusVisible = false;

function clippedStatus(line: string): string {
  const columns = process.stderr.columns || 120;
  if (columns <= 4) return line.slice(0, Math.max(columns, 0));
  return line.length < columns ? line : `${line.slice(0, columns - 4)}...`;
}

function clearPhysicalStatus(): void {
  if (!process.stderr.isTTY || !statusVisible) return;
  process.stderr.write('\r\x1b[2K');
  statusVisible = false;
}

function redrawStatus(): void {
  if (!process.stderr.isTTY || !statusLine) return;
  process.stderr.write(`\r\x1b[2K${clippedStatus(statusLine)}`);
  statusVisible = true;
}

/** Replace the single transient status line shown at the bottom of the terminal. */
export function setTerminalStatus(line: string | undefined): void {
  statusLine = line;
  if (!process.stderr.isTTY) return;
  clearPhysicalStatus();
  redrawStatus();
}

/** Remove the transient status line without printing a newline. */
export function clearTerminalStatus(): void {
  clearPhysicalStatus();
  statusLine = undefined;
}

/**
 * Print a permanent line without corrupting the transient progress display.
 * All diagnostic output goes to stderr so cursor management stays coherent.
 */
export function writeTerminalLine(text: string): void {
  if (!text) return;
  clearPhysicalStatus();
  process.stderr.write(text.endsWith('\n') ? text : `${text}\n`);
  redrawStatus();
}
