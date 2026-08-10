import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Downloadable, Downloader } from '../dist/utils/downloader.js';

class FailingDownload extends Downloadable {
  async download() {
    throw new Error('expired media authorization');
  }
}

class SuccessfulDownload extends Downloadable {
  async download(options) {
    const filename = 'recording.mp4';
    fs.mkdirSync(options.output, { recursive: true });
    fs.writeFileSync(path.join(options.output, filename), 'video');
    return filename;
  }
}

test('retrying a factory task rebuilds it so media authorization can refresh', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'echomirror-retry-'));
  let factoryCalls = 0;
  const downloader = new Downloader(1, { outdir: root, maxRetries: 2 });
  downloader.add(async () => {
    factoryCalls += 1;
    return factoryCalls === 1 ? new FailingDownload() : new SuccessfulDownload();
  });

  await downloader.idle();
  assert.equal(factoryCalls, 2);
  assert.equal(downloader.completed, 1);
  assert.equal(fs.readFileSync(path.join(root, 'recording.mp4'), 'utf8'), 'video');
  fs.rmSync(root, { recursive: true, force: true });
});
