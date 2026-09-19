'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { readFileSync, statSync } = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const context = vm.createContext({ window: {} });
vm.runInContext(readFileSync(path.join(root, 'park.js'), 'utf8'), context);
const park = context.window.NOHO_PARK;
const provenance = JSON.parse(readFileSync(path.join(root, 'content-provenance.json'), 'utf8'));

function localFile(relative) {
  assert.match(relative, /^assets\/[a-z0-9/_.-]+$/);
  assert.ok(!relative.includes('..'), 'media must stay within this project');
  const filename = path.join(root, relative);
  assert.ok(statSync(filename).size > 0, `empty asset: ${relative}`);
  // GitHub rejects individual files over 100 MiB; catch this before a publication attempt.
  assert.ok(statSync(filename).size < 100 * 1024 * 1024, `asset too large for GitHub: ${relative}`);
  return filename;
}

test('each configured still has both complete cube profiles and an 8K fallback', () => {
  assert.equal(park.id, 'kacice');
  assert.ok(park.viewpoints.length > 0);
  assert.equal(new Set(park.viewpoints.map(view => view.id)).size, park.viewpoints.length);
  for (const view of park.viewpoints) {
    assert.match(view.id, /^[a-z0-9-]+$/);
    assert.ok(view.title);
    localFile(view.still);
    for (const size of [2048, 2560]) {
      for (const face of ['px', 'nx', 'py', 'ny', 'pz', 'nz']) {
        const relative = `${view.cubePrefix}-${size}-${face}.webp`;
        localFile(relative);
        const generated = provenance.generated.find(file => file.path === relative);
        assert.equal(generated.width, size);
        assert.equal(generated.height, size);
      }
    }
    const fallback = provenance.generated.find(file => file.path === view.still);
    assert.equal(fallback.width, 8192);
    assert.equal(fallback.height, 4096);
    if (view.video !== null) {
      assert.match(view.video, /\.mp4$/);
      localFile(view.video);
      const video = provenance.videos.find(file => file.path === view.video);
      assert.equal(video.id, view.id);
      assert.equal(video.width, video.height * 2);
      assert.ok(video.durationSeconds > 0);
    }
  }
});

test('all panorama images and animations match their recorded hashes', () => {
  for (const asset of [...provenance.generated, ...(provenance.videos || [])]) {
    const data = readFileSync(localFile(asset.path));
    assert.equal(data.length, asset.bytes);
    assert.equal(createHash('sha256').update(data).digest('hex'), asset.sha256, asset.path);
  }
});
