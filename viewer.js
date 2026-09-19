(function(){
  'use strict';

  var landing = document.getElementById('landing');
  var loading = document.getElementById('loading-overlay');
  var errorBox = document.getElementById('error');

  var FACES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
  var CUBE_SIZE = { fast: 2048, hq: 2560 };

  // Park-specific media is configured separately; absent animations have no controls or requests.
  var VIEWS = window.NOHO_PARK.viewpoints;

  var session = null, refSpace = null, sessionAbort = null;
  var starting = false;
  var mode = 'fast';          // 'fast' | 'hq' | 'video'
  var currentIndex = 0, requestedIndex = 0;
  var switching = false;
  var pendingIndex = -1;      // a flick that arrived while switching
  var stickArmed = true;

  // Still path (cube layer, or equirect fallback).
  var gl = null, glBinding = null, useCube = false;
  var stillLayer = null, layerSize = 0, layerW = 0, layerH = 0;
  var currentFaces = null, currentImg = null, redrawFrames = 0;


  // One committed clip plus, only during handoff, one pending clip.
  var mediaBinding = null, activeVideo = null;
  var ownedVideos = new Set();

  function isStillMode(){ return mode !== 'video'; }
  function indexOfView(id){ for(var i = 0; i < VIEWS.length; i++) if(VIEWS[i].id === id) return i; return 0; }
  function cubeSrc(view, size, face){ return view.cubePrefix + '-' + size + '-' + face + '.webp'; }

  function showError(msg, ttl){
    errorBox.textContent = msg;
    errorBox.classList.add('visible');
    clearTimeout(showError._t);
    showError._t = setTimeout(function(){ errorBox.classList.remove('visible') }, ttl || 6000);
  }

  function abortError(){ return new DOMException('Session ended', 'AbortError'); }

  function releaseImages(images){
    (images || []).forEach(function(img){
      img.onload = img.onerror = null;
      img.removeAttribute('src');
    });
  }

  // No decoded-image cache: only the current view and its pending replacement are retained.
  function loadImages(sources, signal){
    return new Promise(function(resolve, reject){
      if(signal.aborted){ reject(abortError()); return; }
      var images = sources.map(function(){ return new Image(); });
      var remaining = images.length, settled = false;
      var timer = setTimeout(function(){ finish(new Error('Načítání obrázku trvá příliš dlouho.')); }, 30000);
      function cancel(){ finish(abortError()); }
      function finish(error){
        if(settled) return;
        settled = true;
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        images.forEach(function(img){ img.onload = img.onerror = null; });
        if(error){ releaseImages(images); reject(error); }
        else resolve(images);
      }
      signal.addEventListener('abort', cancel, { once: true });
      images.forEach(function(img, i){
        img.crossOrigin = 'anonymous';
        img.onload = function(){ if(--remaining === 0) finish(); };
        img.onerror = function(){ finish(new Error('Obrázek se nepodařilo načíst: ' + sources[i])); };
        img.src = sources[i];
      });
    });
  }

  function destroyLayer(layer){
    if(layer && typeof layer.destroy === 'function') layer.destroy();
  }

  function releaseVideo(resource){
    if(!resource || !ownedVideos.delete(resource)) return;
    destroyLayer(resource.layer);
    resource.element.pause();
    resource.element.removeAttribute('src');
    resource.element.load();
  }

  function createVideo(view){
    var v = document.createElement('video');
    v.crossOrigin = 'anonymous';
    v.loop = true; v.muted = true; v.playsInline = true; v.preload = 'auto';
    var resource = { element: v, layer: null };
    ownedVideos.add(resource);
    v.src = view.video;
    return resource;
  }

  function videoReady(v, signal){
    return new Promise(function(resolve, reject){
      if(signal.aborted){ reject(abortError()); return; }
      if(v.readyState >= 2){ resolve(); return; }
      var timer = setTimeout(function(){ finish(new Error('Načítání videa trvá příliš dlouho.')); }, 30000);
      function ok(){ finish(); }
      function fail(){ finish(new Error('Video se nepodařilo načíst.')); }
      function cancel(){ finish(abortError()); }
      function finish(error){
        clearTimeout(timer);
        v.removeEventListener('loadeddata', ok);
        v.removeEventListener('error', fail);
        signal.removeEventListener('abort', cancel);
        if(error) reject(error); else resolve();
      }
      v.addEventListener('loadeddata', ok);
      v.addEventListener('error', fail);
      signal.addEventListener('abort', cancel, { once: true });
      v.load();
    });
  }

  function playVideo(v, signal){
    return new Promise(function(resolve, reject){
      if(signal.aborted){ reject(abortError()); return; }
      var timer = setTimeout(function(){ finish(new Error('Video se nepodařilo spustit včas.')); }, 30000);
      function cancel(){ finish(abortError()); }
      function finish(error){
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        if(error) reject(error); else resolve();
      }
      signal.addEventListener('abort', cancel, { once: true });
      try{ v.play().then(function(){ finish(); }, finish); }
      catch(error){ finish(error); }
    });
  }

  // Render-state changes take effect at a frame boundary. Keep old resources until that boundary.
  function nextFrame(owner, signal){
    return new Promise(function(resolve, reject){
      if(signal.aborted){ reject(abortError()); return; }
      var id = owner.requestAnimationFrame(function(){
        signal.removeEventListener('abort', cancel);
        resolve();
      });
      function cancel(){ owner.cancelAnimationFrame(id); reject(abortError()); }
      signal.addEventListener('abort', cancel, { once: true });
    });
  }

  function endSession(owner){
    if(owner && session !== owner) return;
    if(sessionAbort) sessionAbort.abort();
    sessionAbort = null;
    ownedVideos.forEach(releaseVideo);
    releaseImages(currentFaces || (currentImg ? [currentImg] : []));
    destroyLayer(stillLayer);
    landing.classList.remove('hidden');
    loading.classList.remove('visible');
    session = null; refSpace = null;
    glBinding = null; stillLayer = null; layerSize = 0; layerW = 0; layerH = 0;
    currentFaces = null; currentImg = null; redrawFrames = 0;
    mediaBinding = null; activeVideo = null;
    switching = false; pendingIndex = -1;
    if(gl){
      var loseContext = gl.getExtension('WEBGL_lose_context');
      if(loseContext) loseContext.loseContext();
      gl = null;
    }
  }

  // ---- stills -------------------------------------------------------------------------

  async function setStillLocation(index, owner, signal){
    var view = VIEWS[index];
    var size = CUBE_SIZE[mode] || CUBE_SIZE.fast;
    var sources = useCube ? FACES.map(function(f){ return cubeSrc(view, size, f); }) : [view.still];
    var images = await loadImages(sources, signal);
    var committed = false;
    try{
      if(signal.aborted || session !== owner) throw abortError();
      // All source views use the same dimensions within a session, so reuse one compositor layer.
      if(!stillLayer){
        if(useCube){
          stillLayer = glBinding.createCubeLayer({ space: refSpace, viewPixelWidth: size, viewPixelHeight: size, layout: 'mono' });
          layerSize = size;
        }else{
          layerW = images[0].width; layerH = images[0].height;
          stillLayer = glBinding.createEquirectLayer({ space: refSpace, viewPixelWidth: layerW, viewPixelHeight: layerH, layout: 'mono' });
        }
        owner.updateRenderState({ layers: [stillLayer] });
      }
      if(!useCube && (images[0].width !== layerW || images[0].height !== layerH)){
        throw new Error('Panorama má jiné rozlišení než ostatní pohledy.');
      }
      var previous = currentFaces || (currentImg ? [currentImg] : []);
      currentFaces = useCube ? images : null;
      currentImg = useCube ? null : images[0];
      committed = true;
      releaseImages(previous);
      redrawFrames = 3;
    }finally{
      if(!committed) releaseImages(images);
    }
  }

  function uploadStill(frame){
    var sub = glBinding.getSubImage(stillLayer, frame);
    if(currentFaces){
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, sub.colorTexture);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      for(var i = 0; i < 6; i++){
        gl.texSubImage2D(gl.TEXTURE_CUBE_MAP_POSITIVE_X + i, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, currentFaces[i]);
      }
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, null);
    }else if(currentImg){
      gl.bindTexture(gl.TEXTURE_2D, sub.colorTexture);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, currentImg);
      gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
      gl.bindTexture(gl.TEXTURE_2D, null);
    }
  }

  // ---- video ---------------------------------------------------------------------------

  async function setVideoLocation(index, owner, signal){
    var candidate = createVideo(VIEWS[index]);
    var committed = false;
    try{
      await videoReady(candidate.element, signal);
      if(signal.aborted || session !== owner) throw abortError();
      await playVideo(candidate.element, signal);
      if(signal.aborted || session !== owner) throw abortError();
      candidate.layer = mediaBinding.createEquirectLayer(candidate.element, { space: refSpace, layout: 'mono' });
      owner.updateRenderState({ layers: [candidate.layer] });
      var old = activeVideo;
      activeVideo = candidate;
      committed = true;
      await nextFrame(owner, signal);
      // The previous layer is now detached. Pausing alone would retain its media pipeline.
      releaseVideo(old);
    }finally{
      if(!committed) releaseVideo(candidate);
    }
  }

  // ---- switching -----------------------------------------------------------------------

  async function showLocation(index){
    if(!session || !VIEWS[index] || !(mode === 'video' ? VIEWS[index].video : VIEWS[index].still)) return;
    requestedIndex = index;
    if(switching){ pendingIndex = index; return; }
    var owner = session, signal = sessionAbort.signal;
    switching = true;
    try{
      if(mode === 'video') await setVideoLocation(index, owner, signal);
      else await setStillLocation(index, owner, signal);
      if(session === owner && !signal.aborted) currentIndex = index;
    }catch(e){
      if(session === owner && !signal.aborted) showError(e.message || String(e));
    }finally{
      if(session === owner && !signal.aborted){
        switching = false;
        if(pendingIndex >= 0){
          var p = pendingIndex; pendingIndex = -1;
          if(p !== currentIndex) showLocation(p);
        }
      }
    }
  }

  function stepLocation(dir){
    var available = VIEWS.map(function(view, index){ return index; }).filter(function(index){
      return mode === 'video' ? !!VIEWS[index].video : !!VIEWS[index].still;
    });
    if(available.length < 2) return;
    var position = available.indexOf(requestedIndex);
    showLocation(available[(position + dir + available.length) % available.length]);
  }

  // Poll Quest thumbstick X (xr-standard axes[2]); flick right = next, left = previous.
  function pollControllers(){
    var x = 0, sources = session.inputSources;
    for(var i = 0; i < sources.length; i++){
      var gp = sources[i] && sources[i].gamepad;
      if(!gp || !gp.axes) continue;
      var ax = gp.axes.length > 2 ? gp.axes[2] : gp.axes[0];
      if(Math.abs(ax) > Math.abs(x)) x = ax;
    }
    if(stickArmed && Math.abs(x) > 0.7){
      stickArmed = false;
      stepLocation(x > 0 ? 1 : -1);
    } else if(Math.abs(x) < 0.3){
      stickArmed = true;
    }
  }

  function onFrame(t, frame){
    if(!session || frame.session !== session) return;
    session.requestAnimationFrame(onFrame);
    try{ pollControllers() }catch(e){}
    if(isStillMode() && stillLayer){
      if(stillLayer.needsRedraw) redrawFrames = Math.max(redrawFrames, 3);
      if(redrawFrames > 0 && (currentFaces || currentImg)){
        redrawFrames--;
        try{ uploadStill(frame) }catch(e){ redrawFrames = 0; showError('Chyba vykreslení: ' + (e.message || e)); }
      }
    }
  }

  async function startSession(modeArg, startIndex){
    if(starting || session) return;
    starting = true;
    mode = modeArg;
    var owner = null;
    try{
      if(!VIEWS[startIndex] || !(mode === 'video' ? VIEWS[startIndex].video : VIEWS[startIndex].still)) throw new Error('Tento pohled zatím není k dispozici.');
      if(!('xr' in navigator)) throw new Error('WebXR není v tomto prohlížeči podporováno.');
      if(mode === 'video' && typeof XRMediaBinding === 'undefined') throw new Error('Přehrávání videa (WebXR Layers) není podporováno.');
      if(isStillMode() && (typeof XRWebGLBinding === 'undefined' || !XRWebGLBinding.prototype.createEquirectLayer)) throw new Error('WebXR Layers nejsou podporovány.');
      if(!await navigator.xr.isSessionSupported('immersive-vr')) throw new Error('VR režim není v tomto zařízení dostupný.');
      loading.classList.add('visible');
      if(isStillMode()){
        var canvas = document.createElement('canvas');
        gl = canvas.getContext('webgl2', { xrCompatible: true });
        if(!gl) throw new Error('WebGL2 není k dispozici.');
        useCube = !!XRWebGLBinding.prototype.createCubeLayer;
      }
      owner = await navigator.xr.requestSession('immersive-vr', { requiredFeatures: ['local-floor', 'layers'] });
      session = owner;
      sessionAbort = new AbortController();
      var signal = sessionAbort.signal;
      owner.addEventListener('end', function(){ endSession(owner); }, { once: true });
      try{ refSpace = await owner.requestReferenceSpace('local-floor'); }
      catch(e){
        if(signal.aborted) throw abortError();
        refSpace = await owner.requestReferenceSpace('local');
      }
      if(signal.aborted || session !== owner) return;
      if(isStillMode()) glBinding = new XRWebGLBinding(owner, gl);
      else mediaBinding = new XRMediaBinding(owner);
      owner.requestAnimationFrame(onFrame);
      currentIndex = requestedIndex = startIndex;
      stickArmed = false;
      await showLocation(startIndex);
      if(session !== owner) return;
      landing.classList.add('hidden');
    }catch(e){
      if(owner && session === owner){
        try{ await owner.end(); }catch(endError){}
      }
      endSession(owner);
      if(e.name !== 'AbortError') showError('Nelze spustit VR: ' + (e.message || e));
    }finally{
      starting = false;
      loading.classList.remove('visible');
    }
  }

  document.querySelectorAll('.mode-btn').forEach(function(btn){
    btn.addEventListener('click', function(){
      document.querySelectorAll('.mode-btn').forEach(function(b){ b.classList.remove('active') });
      btn.classList.add('active');
    });
  });

  function renderViewButtons(){
    var stillButtons = document.getElementById('still-buttons');
    var animationButtons = document.getElementById('animation-buttons');
    VIEWS.forEach(function(view, index){
      function addButton(container, animated){
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'view-btn' + (animated ? ' anim' : '');
        button.textContent = view.title;
        button.addEventListener('click', function(){
          var quality = document.querySelector('.mode-btn.active').dataset.mode;
          startSession(animated ? 'video' : quality, index);
        });
        container.appendChild(button);
      }
      if(view.still) addButton(stillButtons, false);
      if(view.video) addButton(animationButtons, true);
    });
    document.getElementById('animation-group').hidden = !VIEWS.some(function(view){ return !!view.video; });
  }
  renderViewButtons();
})();
