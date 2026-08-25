import { MultiBar, type SingleBar } from 'cli-progress';

let renderer: MultiBar | undefined;
const bars = new Set<SingleBar>();

function formatTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const remainder = whole % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${minutes}:${String(remainder).padStart(2, '0')}`;
}

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
  update(seconds: number): void;
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

export function createDownloadProgress(name: string, duration?: number): DownloadProgress {
  const knownDuration = duration !== undefined && duration > 0;
  const total = knownDuration ? duration : 28;
  const currentRenderer = progressRenderer();
  const bar = currentRenderer.create(total, 0, { name, time: '0:00' }, knownDuration ? undefined : {
    format: '{bar} │ {time} │ {name}',
  });
  bars.add(bar);

  return {
    update(seconds: number): void {
      bar.update(knownDuration ? Math.min(seconds, total) : Math.floor(seconds) % total, {
        name,
        time: formatTime(seconds),
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
