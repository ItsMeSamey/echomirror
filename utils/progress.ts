import { MultiBar, type SingleBar } from 'cli-progress';

let renderer: MultiBar | undefined;
const bars = new Set<SingleBar>();

function progressRenderer(): MultiBar {
  renderer ??= new MultiBar({
    format: '{bar} {percentage}% │ {time} │ {name}',
    barsize: 28,
    barCompleteChar: '█',
    barIncompleteChar: '░',
    clearOnComplete: true,
    forceRedraw: true,
    fps: 12,
    hideCursor: true,
    linewrap: true,
    stream: process.stderr,
  });
  return renderer;
}

export interface DownloadProgress {
  update(bytes: number): void;
  close(): void;
}

function formatBytes(bytes: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  let value = Math.max(0, bytes);
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

export function createByteProgress(name: string, totalBytes?: number): DownloadProgress {
  const knownTotal = totalBytes !== undefined && totalBytes > 0;
  const total = knownTotal ? totalBytes : 28;
  const currentRenderer = progressRenderer();
  const bar = currentRenderer.create(total, 0, { name, time: '0 B' }, knownTotal ? {
    format: '{bar} {percentage}% │ {time} │ {name}',
  } : {
    format: '{bar} │ {time} │ {name}',
  });
  bars.add(bar);

  return {
    update(bytes: number): void {
      bar.update(knownTotal ? Math.min(bytes, total) : Math.floor(bytes / 65_536) % total, {
        name,
        time: knownTotal ? `${formatBytes(bytes)} / ${formatBytes(total)}` : formatBytes(bytes),
      });
    },
    close(): void {
      if (!bars.delete(bar)) return;
      currentRenderer.remove(bar);
      if (!bars.size) {
        currentRenderer.stop();
        if (renderer === currentRenderer) renderer = undefined;
      }
    },
  };
}

export function logAboveProgress(text: string): boolean {
  if (!renderer?.isActive) return false;
  renderer.log(text.endsWith('\n') ? text : `${text}\n`);
  return true;
}
