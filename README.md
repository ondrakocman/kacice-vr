# Větrný park Kačice — WebXR viewer

Independent Kačice site based on the Vojtěchov mk2.1 resource-cleanup release
(`ondrakocman/vojtechov-vr-mk2`, commit `32fd84a3a48858b7bd7ea780e94cfe487788beb3`).

Live site: https://ondrakocman.github.io/kacice-vr/

## Current content

- **Cesta k parku** — `kacice cesta park(1).png`.
- **Hřiště** — `Hriste kacice fin(1).png`.

Original files are in `Desktop/VR Kacice`, outside the repository. Both are complete 2:1 panoramas,
approximately 10K wide. Cube faces are generated directly from those originals at 2048 px
(Plynulé) and 2560 px (Plná kvalita), WebP quality 92. A common 8192 × 4096 WebP fallback is used
for browsers without cube layers. Source and generated-file hashes are in `content-provenance.json`.
Source pixels are resampled/compressed for web delivery; original PNGs are preserved on disk.

There are no animations yet. No video elements, MP4 requests, or animation buttons are created
for a view whose `video` field is `null`.

## Use on Quest 3

Open the live HTTPS page in Quest Browser and choose a still. Flick either thumbstick left/right
to switch views, returning to neutral between flicks. Plynulé / Plná kvalita affects stills only.
The viewer uses WebXR compositor layers and preserves the source panorama orientation.

Only the current panorama and its pending replacement are retained. Nothing preloads the whole park.
Future video handoffs retain at most two video elements until the new layer reaches an XR frame
boundary, then destroy the old layer and unload its media source. Session shutdown cancels loads
and releases owned resources. This web deployment requires network access to retrieve uncached
assets; it does not provide the native APK's offline installation behavior.

## Add an animation later

1. Add `assets/cesta-k-parku.mp4` or `assets/hriste.mp4`.
2. In `park.js`, change that view's `video: null` to its relative MP4 path, for example:

   ```js
   video: 'assets/cesta-k-parku.mp4',
   ```

3. Keep the full 2:1 panorama projection and orientation aligned with the matching still. Use a
   Quest Browser-compatible MP4 and verify its decoder load on the headset. No lower-quality video
   profile is implied by the still-quality toggle. Files must be under GitHub's per-file size limit;
   larger videos need a separate media-hosting decision before publication.
4. Run the checks below, commit, and push to `main`. The animation button appears automatically.
   Animated thumbstick navigation skips views without videos, so clips can be delivered one at a time.

Media configuration lives in `park.js`; `viewer.js` owns the runtime and `index.html` the landing page.
Adding an animation does not require editing the viewer runtime.

## Prepare or verify content

```bash
python3 -m venv .venv
.venv/bin/pip install -r tools/requirements.txt
.venv/bin/python tools/prepare_content.py '/path/to/VR Kacice'
node tests/lifecycle.test.cjs
node tests/content.test.cjs
```

The lifecycle suite executes the actual viewer with mocked media/XR boundaries, including repeated
switching, failure, cancellation, and partially available animations. Content checks verify configured
paths, both cube profiles, and generated-file hashes. Browser checks cover the landing page; actual
Quest frame rate, projection, seams, controller navigation, and sustained memory behavior still need
headset testing. To preview the landing page locally, run `python3 -m http.server 8080`.

## Publish

GitHub Pages serves `main` at `/`, using the same branch deployment setup as Vojtěchov. Push a reviewed
change to publish. CI runs the lifecycle and content checks; the branch-based Pages deployment is
independent of CI, so run the checks before pushing. The original Vojtěchov site remains separate.
