'use strict';

// Add a local MP4 path to `video` when that viewpoint's animation is ready.
// The viewer automatically shows only available media and skips missing animations.
window.NOHO_PARK = {
  id: 'kacice',
  title: 'Větrný park Kačice',
  viewpoints: [
    {
      id: 'cesta-k-parku',
      title: 'Cesta k parku',
      still: 'assets/cesta-k-parku.webp',
      cubePrefix: 'assets/cube/cesta-k-parku',
      video: null,
    },
    {
      id: 'hriste',
      title: 'Hřiště',
      still: 'assets/hriste.webp',
      cubePrefix: 'assets/cube/hriste',
      video: null,
    },
  ],
};
