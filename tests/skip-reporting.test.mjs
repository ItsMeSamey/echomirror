import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Downloadable, Downloader, SkippedDownload } from '../dist/utils/downloader.js';

class ExistingDestination extends Downloadable {
  async download() {
    return null;
  }
}

test('intentional skips retain a concrete reason and path label', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'echomirror-skip-'));
  const downloader = new Downloader(1, { outdir: root, maxRetries: 1 });
  downloader.add({
    download: async () => new SkippedDownload('Echo player reports no downloadable video for this lesson'),
    label: '2026_1/comp2701/recordings/03_01_lecture.mp4',
  });

  await downloader.idle();
  assert.equal(downloader.skipped, 1);
  assert.deepEqual(downloader.skipDetails, [{
    label: '2026_1/comp2701/recordings/03_01_lecture.mp4',
    reason: 'Echo player reports no downloadable video for this lesson',
  }]);
  fs.rmSync(root, { recursive: true, force: true });
});

test('null from a normal downloader is reported as destination already exists', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'echomirror-existing-'));
  const downloader = new Downloader(1, { outdir: root, maxRetries: 1 });
  downloader.add({ download: new ExistingDestination(), label: 'recording.mp4' });

  await downloader.idle();
  assert.deepEqual(downloader.skipDetails, [{
    label: 'recording.mp4',
    reason: 'destination file already exists',
  }]);
  fs.rmSync(root, { recursive: true, force: true });
});
