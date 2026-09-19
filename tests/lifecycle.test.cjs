'use strict';

const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { test } = require('node:test');
const vm = require('node:vm');

const script = readFileSync(`${__dirname}/../viewer.js`, 'utf8');
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

const fixtureViews = Array.from({ length: 4 }, (_, index) => ({
  id: `view-${index}`, title: `View ${index}`, still: `assets/view-${index}.webp`,
  cubePrefix: `assets/cube/view-${index}`, video: `assets/view-${index}.mp4`,
}));

function harness(viewpoints = fixtureViews) {
  const videos = [], images = [], layers = [], timers = new Map();
  let timerId = 0, loadFailure = false, ready = true, stalledPlay = false;
  class Video extends EventTarget {
    constructor() { super(); this.readyState = ready ? 2 : 0; this.src = ''; this.playing = false; videos.push(this); }
    async play() { this.playing = true; if (stalledPlay) await new Promise(() => {}); }
    pause() { this.playing = false; }
    load() { if (!this.src) this.readyState = 0; }
    removeAttribute(name) { if (name === 'src') this.src = ''; }
  }
  class Image {
    constructor() { this.width = 8192; this.height = 4096; this._src = ''; images.push(this); }
    set src(value) {
      this._src = value;
      queueMicrotask(() => { if (loadFailure) this.onerror?.(); else this.onload?.(); });
    }
    get src() { return this._src; }
    removeAttribute() { this._src = ''; }
  }
  class Session extends EventTarget {
    constructor() { super(); this.callbacks = new Map(); this.id = 0; this.inputSources = []; this.renderState = { layers: [] }; }
    requestAnimationFrame(callback) { this.callbacks.set(++this.id, callback); return this.id; }
    cancelAnimationFrame(id) { this.callbacks.delete(id); }
    updateRenderState(state) { this.pending = state; }
    async requestReferenceSpace() { return {}; }
    frame() {
      if (this.pending) { this.renderState = this.pending; this.pending = null; }
      const callbacks = [...this.callbacks.values()];
      this.callbacks.clear();
      callbacks.forEach(callback => callback(0, { session: this }));
    }
    async end() { this.renderState = { layers: [] }; this.dispatchEvent(new Event('end')); }
  }
  class Binding {
    constructor(owner) { this.owner = owner; }
    createEquirectLayer() {
      const owner = this.owner;
      const layer = { destroyed: false, destroy() {
        assert.ok(!owner.renderState.layers.includes(this), 'active video layer must survive until render-state swap');
        this.destroyed = true;
      } };
      layers.push(layer);
      return layer;
    }
    createCubeLayer() { return this.createEquirectLayer(); }
  }
  const nodes = new Map();
  function node(id) {
    if (!nodes.has(id)) nodes.set(id, { textContent: '', children: [], hidden: false, appendChild(child) { this.children.push(child); }, classList: { add() {}, remove() {} } });
    return nodes.get(id);
  }
  let requests = 0;
  const owner = new Session();
  const context = vm.createContext({
    window: { NOHO_PARK: { viewpoints } },
    document: { getElementById: node, querySelectorAll: () => [],
      querySelector: () => ({ dataset: { mode: 'fast' } }),
      createElement: tag => {
        if (tag === 'button') return { textContent: '', addEventListener() {} };
        assert.equal(tag, 'video'); return new Video();
      },
    },
    navigator: { xr: { isSessionSupported: async () => true, requestSession: async () => { requests++; return owner; } } },
    Image, XRMediaBinding: Binding, XRWebGLBinding: Binding, AbortController, DOMException,
    console, setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
  });
  const exports = `
    globalThis.api = {
      startSession, showLocation, stepLocation, endSession, loadImages,
      state: () => ({ currentIndex, requestedIndex, switching, videos: ownedVideos.size, session }),
      setup: (owner, kind) => {
        session = owner; sessionAbort = new AbortController(); mode = kind;
        refSpace = {}; mediaBinding = new XRMediaBinding(owner);
        glBinding = new XRWebGLBinding(owner); useCube = kind === 'hq';
        owner.addEventListener('end', () => endSession(owner));
      }
    };
  `;
  vm.runInContext(script.replace(/\}\)\(\);\s*$/, exports + '\n})();'), context);
  return { api: context.api, videos, images, layers, owner, nodes, timers,
    requests: () => requests, failImages: () => { loadFailure = true; },
    deferVideo: () => { ready = false; }, newSession: () => new Session(),
    stallPlayback: () => { stalledPlay = true; },
  };
}

async function switchVideo(h, index) {
  const work = h.api.showLocation(index);
  await flush();
  h.owner.frame();
  await work;
}

test('landing page does not preload panoramas or create video elements', () => {
  const h = harness();
  assert.equal(h.images.length, 0);
  assert.equal(h.videos.length, 0);
});

test('100 video switches retain one clip and layer after each handoff', async () => {
  const h = harness();
  h.api.setup(h.owner, 'video');
  for (let i = 0; i < 100; i++) {
    const previous = h.videos.filter(video => video.src);
    const work = h.api.showLocation(i % 4);
    await flush();
    assert.ok(h.api.state().videos <= 2);
    previous.forEach(video => assert.ok(video.src, 'old clip must survive until the next XR frame'));
    h.owner.frame();
    await work;
    assert.equal(h.api.state().videos, 1);
    assert.equal(h.videos.filter(video => video.src).length, 1);
    assert.equal(h.layers.filter(layer => !layer.destroyed).length, 1);
  }
  await h.owner.end();
  assert.equal(h.api.state().videos, 0);
  assert.ok(h.videos.every(video => !video.src && !video.playing));
  assert.ok(h.layers.every(layer => layer.destroyed));
});

test('rapid input keeps only latest queued request and never grows beyond two clips', async () => {
  const h = harness();
  h.api.setup(h.owner, 'video');
  const work = h.api.showLocation(0);
  h.api.stepLocation(1);
  h.api.stepLocation(1);
  h.api.stepLocation(1);
  await flush();
  h.owner.frame();
  await work;
  await flush();
  assert.equal(h.api.state().videos, 2);
  assert.equal(h.videos.length, 2);
  assert.ok(h.videos[1].src.endsWith('view-3.mp4'));
  h.owner.frame();
  await flush();
  assert.equal(h.api.state().currentIndex, 3);
  assert.equal(h.api.state().videos, 1);
});

test('failed pending video is unloaded and the current view survives', async () => {
  const h = harness();
  h.api.setup(h.owner, 'video');
  await switchVideo(h, 0);
  h.deferVideo();
  const work = h.api.showLocation(1);
  h.videos[1].dispatchEvent(new Event('error'));
  await work;
  assert.equal(h.api.state().currentIndex, 0);
  assert.equal(h.api.state().videos, 1);
  assert.ok(h.videos[0].src);
  assert.equal(h.videos[1].src, '');
});

test('stalled video times out and releases its media source', async () => {
  const h = harness();
  h.api.setup(h.owner, 'video');
  h.deferVideo();
  const work = h.api.showLocation(1);
  [...h.timers.values()].forEach(callback => callback());
  await work;
  assert.equal(h.api.state().videos, 0);
  assert.equal(h.api.state().switching, false);
  assert.equal(h.videos[0].src, '');
});

test('session ending during preparation cancels work before another session starts', async () => {
  const h = harness();
  h.api.setup(h.owner, 'video');
  h.deferVideo();
  const oldWork = h.api.showLocation(0);
  await h.owner.end();
  const next = h.newSession();
  h.api.setup(next, 'video');
  const nextWork = h.api.showLocation(2);
  await oldWork;
  assert.equal(h.api.state().session, next);
  assert.equal(h.api.state().switching, true);
  assert.equal(h.api.state().videos, 1);
  await next.end();
  await nextWork;
  assert.equal(h.api.state().videos, 0);
});

test('ending between layer swap and next frame unloads both videos', async () => {
  const h = harness();
  h.api.setup(h.owner, 'video');
  await switchVideo(h, 0);
  const work = h.api.showLocation(1);
  await flush();
  assert.equal(h.api.state().videos, 2);
  await h.owner.end();
  await work;
  assert.equal(h.api.state().videos, 0);
  assert.ok(h.layers.every(layer => layer.destroyed));
});

test('still switching retains only the current image and releases it at session end', async () => {
  const h = harness();
  h.api.setup(h.owner, 'fast');
  for (let i = 0; i < 12; i++) {
    await h.api.showLocation(i % 4);
    assert.equal(h.images.filter(image => image.src).length, 1);
  }
  assert.equal(h.layers.length, 1);
  await h.owner.end();
  assert.ok(h.images.every(image => !image.src));
});

test('partial image batch failure releases every image', async () => {
  const h = harness();
  h.failImages();
  await assert.rejects(h.api.loadImages(['one', 'two', 'three'], new AbortController().signal));
  assert.ok(h.images.every(image => !image.src));
});

test('cube switching releases all six previous faces', async () => {
  const h = harness();
  h.api.setup(h.owner, 'hq');
  for (let i = 0; i < 8; i++) {
    await h.api.showLocation(i % 4);
    assert.equal(h.images.filter(image => image.src).length, 6);
  }
  await h.owner.end();
  assert.ok(h.images.every(image => !image.src));
});

test('playback startup timeout preserves the committed video', async () => {
  const h = harness();
  h.api.setup(h.owner, 'video');
  await switchVideo(h, 0);
  h.stallPlayback();
  const work = h.api.showLocation(1);
  await flush();
  [...h.timers.values()].forEach(callback => callback());
  await work;
  assert.equal(h.api.state().videos, 1);
  assert.equal(h.api.state().currentIndex, 0);
  assert.equal(h.videos[1].src, '');
});

test('double start creates only one session', async () => {
  const h = harness();
  const first = h.api.startSession('video', 0);
  const second = h.api.startSession('video', 1);
  await flush();
  h.owner.frame();
  await Promise.all([first, second]);
  assert.equal(h.requests(), 1);
  assert.equal(h.api.state().videos, 1);
  await h.owner.end();
});


test('stills-only configuration creates no animation controls or video requests', async () => {
  const viewpoints = fixtureViews.slice(0, 2).map(view => ({ ...view, video: null }));
  const h = harness(viewpoints);
  assert.equal(h.nodes.get('still-buttons').children.length, 2);
  assert.equal(h.nodes.get('animation-buttons').children.length, 0);
  assert.equal(h.nodes.get('animation-group').hidden, true);
  await h.api.startSession('video', 0);
  assert.equal(h.requests(), 0);
  assert.equal(h.videos.length, 0);
});

test('animation navigation skips unavailable videos in both directions', async () => {
  const viewpoints = fixtureViews.map((view, index) => ({ ...view, video: index % 2 ? null : view.video }));
  const h = harness(viewpoints);
  assert.equal(h.nodes.get('animation-buttons').children.length, 2);
  assert.equal(h.nodes.get('animation-group').hidden, false);
  h.api.setup(h.owner, 'video');
  await switchVideo(h, 0);
  h.api.stepLocation(1);
  await flush();
  h.owner.frame();
  await flush();
  assert.equal(h.api.state().currentIndex, 2);
  h.api.stepLocation(-1);
  await flush();
  h.owner.frame();
  await flush();
  assert.equal(h.api.state().currentIndex, 0);
});

test('a single available animation is not restarted by thumbstick navigation', async () => {
  const viewpoints = fixtureViews.map((view, index) => ({ ...view, video: index === 0 ? view.video : null }));
  const h = harness(viewpoints);
  h.api.setup(h.owner, 'video');
  await switchVideo(h, 0);
  h.api.stepLocation(1);
  h.api.stepLocation(-1);
  await flush();
  assert.equal(h.videos.length, 1);
  assert.equal(h.api.state().switching, false);
});
