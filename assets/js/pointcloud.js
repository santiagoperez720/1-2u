/* =========================================================
   Parker Schmidt — Point Cloud Module
   Two modes:
     - "interactive" (home page): full-screen, scroll-snap with red points
     - "background" (all other pages): dimmed, slow breathing/rotation,
       sits behind page content with frosted-glass overlay
   Configure via window.POINTCLOUD_MODE = "interactive" | "background"
   before this script loads. Defaults to "background".
   ========================================================= */
(function () {
  var MODE = window.POINTCLOUD_MODE || 'background';

  // Shared uniforms across all point materials so the focus/fade
  // parameters can be animated from a single place.
  //
  // uFocusDist : view-space distance (positive) where points are sharpest
  // uFocusRange: half-width of the in-focus band; beyond this points
  //              grow larger and fade out (the "DOF" effect)
  // uFadeNear  : view-space distance where the depth-fade starts
  // uFadeFar   : view-space distance where points have fully faded to bg
  // uBgColor   : colour points tint toward in the distance (matches scene bg)
  var SHARED_UNIFORMS = {
    uFocusDist:  { value: 6.0 },
    uFocusRange: { value: 4.0 },
    uFadeNear:   { value: 4.0 },
    uFadeFar:    { value: 22.0 },
    uBgColor:    { value: new THREE.Color(0xffffff) }
  };

  // Build a ShaderMaterial that renders each point as a soft circle with
  // depth fade and a fake depth-of-field (size grows + opacity drops as
  // points leave the focus band). Markers can opt out of these effects
  // via opts.ignoreFocus so red dots stay sharp at every snap.
  function makeCircleMaterial(opts) {
    var color = new THREE.Color(opts.color);
    var ignoreFocus = !!opts.ignoreFocus;
    return new THREE.ShaderMaterial({
      uniforms: {
        uColor:      { value: color },
        uSize:       { value: opts.size },
        uOpacity:    { value: opts.opacity != null ? opts.opacity : 1.0 },
        uFocusDist:  SHARED_UNIFORMS.uFocusDist,
        uFocusRange: SHARED_UNIFORMS.uFocusRange,
        uFadeNear:   SHARED_UNIFORMS.uFadeNear,
        uFadeFar:    SHARED_UNIFORMS.uFadeFar,
        uBgColor:    SHARED_UNIFORMS.uBgColor,
        uIgnoreFocus:{ value: ignoreFocus ? 1.0 : 0.0 }
      },
      vertexShader: [
        'attribute float aBrightness;',
        'uniform float uSize;',
        'uniform float uFocusDist;',
        'uniform float uFocusRange;',
        'uniform float uIgnoreFocus;',
        'varying float vDepth;',
        'varying float vBlur;',
        'varying float vBrightness;',
        'void main() {',
        '  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);',
        '  float dist = -mvPosition.z;',
        '  vDepth = dist;',
        '  vBrightness = aBrightness;',
        // how far out of the focus band we are, 0 = sharp, 1 = fully blurred
        '  float blur = clamp((abs(dist - uFocusDist) - uFocusRange) / uFocusRange, 0.0, 1.0);',
        '  blur = mix(blur, 0.0, uIgnoreFocus);',
        '  vBlur = blur;',
        // grow the sprite up to ~2x when fully out of focus (was 3.5x — too much)
        '  float sizeMul = mix(1.0, 2.0, blur);',
        '  gl_PointSize = uSize * sizeMul * (300.0 / dist);',
        '  gl_Position = projectionMatrix * mvPosition;',
        '}'
      ].join('\n'),
      fragmentShader: [
        'uniform vec3 uColor;',
        'uniform vec3 uBgColor;',
        'uniform float uOpacity;',
        'uniform float uFadeNear;',
        'uniform float uFadeFar;',
        'uniform float uIgnoreFocus;',
        'varying float vDepth;',
        'varying float vBlur;',
        'varying float vBrightness;',
        'void main() {',
        '  vec2 c = gl_PointCoord - vec2(0.5);',
        '  float d = dot(c, c);',
        '  if (d > 0.25) discard;',
        // softer edges for blurred points: tighter falloff when sharp,
        // gentler when blurred so out-of-focus dots feel like soft discs
        '  float inner = mix(0.21, 0.05, vBlur);',
        '  float alpha = smoothstep(0.25, inner, d);',
        // DOF opacity drop: blurred points soften but stay readable
        '  alpha *= mix(1.0, 0.55, vBlur);',
        // Depth fade: gentle tint + opacity drop with distance.
        // Skipped entirely when uIgnoreFocus is set so red markers
        // stay vivid no matter how far the camera is.
        '  float fade = clamp((vDepth - uFadeNear) / (uFadeFar - uFadeNear), 0.0, 1.0);',
        '  fade = mix(fade, 0.0, uIgnoreFocus);',
        '  vec3 col = mix(uColor, uBgColor, fade * 0.45);',
        // Per-point shading from the scan: lift the floor a bit so even
        // dark points stay visible (mix(0.25, 1.0, brightness) keeps the
        // darkest point at 25% grey rather than near-black).
        '  float shade = 1.0;', // 1*2U tema claro: tinta plana (la densidad da el tono)
        '  shade = mix(shade, 1.0, uIgnoreFocus);',
        '  col *= shade;',
        '  alpha *= (1.0 - fade * 0.40);',
        '  alpha *= uOpacity;',
        '  gl_FragColor = vec4(col, alpha);',
        '}'
      ].join('\n'),
      transparent: true,
      depthWrite: false
    });
  }

  // Path to the .b64 data. Works from root OR from /projects/ subfolder.
  var inProjects = location.pathname.indexOf('/projects/') !== -1;
  var DATA_URL = (inProjects ? '../' : '') + 'assets/data/pointcloud.b64';
  // Per-point luminance (one uint8 per point), captured from the original
  // scan's RGB and used to shade the cloud instead of pure white.
  var LUM_URL  = (inProjects ? '../' : '') + 'assets/data/pointcloud-lum.b64';

  var status      = document.getElementById('status');
  var thumbWrap   = document.getElementById('thumb-wrap');
  var thumbImg    = document.getElementById('thumb-img');
  var thumbLink   = document.getElementById('thumb-link');
  var workRows    = document.querySelectorAll('#project-table .work-row');

  // ----- Home-page project assets (only used in interactive mode) -----
  // Order matches the #project-table rows on the home page; the bracketed
  // numbers there mirror each project's slot on the works-page grid.
  var THUMB_URLS = [
    (inProjects ? '../' : '') + 'assets/img/portfolio/aria.jpg',
    (inProjects ? '../' : '') + 'assets/img/portfolio/lad.jpg',
    (inProjects ? '../' : '') + 'assets/img/portfolio/taohh.svg',
    (inProjects ? '../' : '') + 'assets/img/portfolio/durex.jpg',
    (inProjects ? '../' : '') + 'assets/img/portfolio/piscina.jpg',
    (inProjects ? '../' : '') + 'assets/img/portfolio/carga.jpg',
    (inProjects ? '../' : '') + 'assets/img/portfolio/p1707.jpg'
  ];
  // Páginas de proyecto pendientes (Sección D). Por ahora '#' → el clic
  // no navega a ninguna parte (no da 404). Reemplazar por las rutas reales
  // cuando existan las páginas: projects/720-web.html, etc.
  var PROJECT_URLS = [
    'proyectos/aria.html', 'proyectos/lad.html', 'proyectos/taohh.html',
    'proyectos/durex.html', 'proyectos/piscina.html', 'proyectos/carga.html', 'proyectos/p1707.html'
  ];
  // Preload all project thumbnails so transitions never show a stale
  // image while the next one is still fetching. Without this, fast
  // scrolls between projects would briefly display the previous
  // project's thumb (cached) before the new one arrives over the
  // network. We hold onto the Image objects to keep them in cache.
  var THUMB_PRELOAD = THUMB_URLS.map(function (url) {
    var img = new Image();
    img.src = url;
    return img;
  });
  // Red marker vertex indices in the Idaho 600k point cloud. Chosen via
  // KNN local-neighbour-density analysis: each index has 1100+ neighbours
  // within a 0.26-unit bubble (top 5% local density), so they're genuinely
  // embedded in dense foliage rather than sitting on sparse twig-edges.
  // Spread across the cloud via farthest-point sampling so each project's
  // snap lands in a visually distinct dense region.
  // Red marker placement is computed at runtime (after the geometry is
  // loaded and positioned) by projecting every cloud point to screen space
  // from the overview camera, then picking the 5 vertices in the densest
  // visible regions. Computing this in JS — with the actual final positions,
  // transforms, and camera setup — sidesteps the coordinate-system
  // guessing that bedevils any pre-computed pick.
  var RED_VERTEX_INDICES = null; // populated by pickRedVertices() at runtime

  // ----- Fetch & decode the point data -----
  function b64ToBytes(b64) {
    var binary = atob(b64.trim());
    var buf = new ArrayBuffer(binary.length);
    var view = new Uint8Array(buf);
    for (var i = 0; i < binary.length; i++) view[i] = binary.charCodeAt(i);
    return buf;
  }
  Promise.all([
    fetch(DATA_URL).then(function (r) { return r.text(); }),
    fetch(LUM_URL).then(function (r) { return r.ok ? r.text() : null; }).catch(function () { return null; })
  ])
    .then(function (texts) {
      var positions = new Float32Array(b64ToBytes(texts[0]));
      // Luminance file is optional — if missing, we fall back to pure white.
      var luminance = null;
      if (texts[1]) {
        luminance = new Uint8Array(b64ToBytes(texts[1]));
      }
      init(positions, luminance);
    })
    .catch(function (err) {
      if (status) status.textContent = 'Error loading point cloud';
      console.error(err);
    });

  // ----- Scene setup -----
  function init(positions, luminance) {
    var scene = new THREE.Scene();
    scene.background = new THREE.Color(0xffffff);

    var camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 0.01, 5000);

    var renderer = new THREE.WebGLRenderer({ antialias: false, alpha: true });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));

    if (MODE === 'background') {
      var bgContainer = document.getElementById('pointcloud-bg');
      if (bgContainer) {
        bgContainer.appendChild(renderer.domElement);
      } else {
        document.body.insertBefore(renderer.domElement, document.body.firstChild);
        renderer.domElement.style.position = 'fixed';
        renderer.domElement.style.top = '0';
        renderer.domElement.style.left = '0';
        renderer.domElement.style.zIndex = '0';
      }
    } else {
      document.body.appendChild(renderer.domElement);
    }

    var geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    // Per-point luminance (uint8 normalized to 0..1 in the shader) provides
    // scan-derived shading instead of every point being flat white. If the
    // luminance file is missing we synthesize an all-bright fallback array.
    var pointCount = positions.length / 3;
    var lumArr = luminance && luminance.length === pointCount
      ? luminance
      : new Uint8Array(pointCount).fill(255);
    geometry.setAttribute('aBrightness', new THREE.BufferAttribute(lumArr, 1, true));
    geometry.computeBoundingBox();
    var bbox = geometry.boundingBox;
    var size = new THREE.Vector3();   bbox.getSize(size);
    var center = new THREE.Vector3(); bbox.getCenter(center);
    var maxDim = Math.max(size.x, size.y, size.z);

    var material = makeCircleMaterial({
      color: 0xff5a1f,                                   // 1*2U: puntos naranjas
      size: 0.01,
      opacity: MODE === 'background' ? 0.85 : 0.72       // granulado pero con forma legible
    });

    var cloudGroup = new THREE.Group();
    var points = new THREE.Points(geometry, material);
    points.position.sub(center);
    points.rotation.x = 0; // 1*2U: el logo ya viene orientado de frente (plano XY)
    cloudGroup.add(points);
    scene.add(cloudGroup);

    var redMarkers = [];
    // (Marker creation deferred — see pickRedVertices() below, called after
    //  the overview camera is set up so we can project to screen space.)

    if (status) status.style.display = 'none';

    var OVERVIEW_POS    = new THREE.Vector3(maxDim * 0.18, maxDim * 0.06, maxDim * 1.35);
    var OVERVIEW_TARGET = new THREE.Vector3(0, 0, 0);
    camera.position.copy(OVERVIEW_POS);
    camera.up.set(0, 1, 0);
    camera.lookAt(OVERVIEW_TARGET);
    camera.updateMatrixWorld(true);
    points.updateMatrixWorld(true);
    cloudGroup.updateMatrixWorld(true);

    // ============================================================
    // Runtime marker placement
    // ============================================================
    // Project every cloud point through the actual scene transforms +
    // camera, find the densest visible regions on screen, and pick 5
    // vertices that sit inside those regions, well-spread. This is the
    // ground truth — no coordinate-system guessing.
    function pickRedVertices() {
      var NP = workRows.length; // nº de proyectos = nº de markers
      var n = positions.length / 3;
      var worldM = points.matrixWorld;
      var projM  = camera.projectionMatrix;
      var viewM  = camera.matrixWorldInverse;
      var W = window.innerWidth, H = window.innerHeight;

      // Project every point to screen pixels.
      var sx = new Float32Array(n);
      var sy = new Float32Array(n);
      var visible = new Uint8Array(n);
      var v = new THREE.Vector3();
      for (var i = 0; i < n; i++) {
        v.set(positions[i*3], positions[i*3+1], positions[i*3+2]);
        v.applyMatrix4(worldM);
        v.applyMatrix4(viewM);
        if (v.z >= 0) continue;
        v.applyMatrix4(projM);
        if (v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1) continue;
        sx[i] = (v.x * 0.5 + 0.5) * W;
        sy[i] = (1 - (v.y * 0.5 + 0.5)) * H;
        visible[i] = 1;
      }

      // ---- Markers at RANDOM locations scattered across the whole map ----
      // Candidates = any visible vertex within safe screen margins (no
      // density requirement), so picks land anywhere in the scene (ground,
      // grass, trees, tower) instead of clustering on the densest mass.
      var marginX = W * 0.06;
      var marginTop = H * 0.08;
      var marginBottom = H * 0.16;
      var candidates = [];
      for (var p = 0; p < n; p++) {
        if (!visible[p]) continue;
        if (sx[p] < marginX || sx[p] > W - marginX) continue;
        if (sy[p] < marginTop || sy[p] > H - marginBottom) continue;
        candidates.push(p);
      }
      console.log('[pickRedVertices] scatter candidates=' + candidates.length);

      if (candidates.length <= NP) return candidates.slice(0, NP);

      // Deterministic (seeded) RNG so the 5 dots land in the SAME scattered
      // positions on every load. Change MARKER_SEED for a different — but
      // still fixed — arrangement.
      var MARKER_SEED = 20260820;
      var _s = MARKER_SEED >>> 0;
      function rng() {
        _s |= 0; _s = (_s + 0x6D2B79F5) | 0;
        var t = Math.imul(_s ^ (_s >>> 15), 1 | _s);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      }

      // Pick 5 candidates via seeded RNG, rejecting any that land too close
      // to one already chosen (min screen separation) so dots never overlap.
      var chosen = [];
      var MINSEP = Math.min(W, H) * 0.14;
      var minSep2 = MINSEP * MINSEP;
      var guard = 0;
      while (chosen.length < NP && guard < 6000) {
        guard++;
        var cand = candidates[Math.floor(rng() * candidates.length)];
        var ok = true;
        for (var c2 = 0; c2 < chosen.length; c2++) {
          var dx = sx[cand] - sx[chosen[c2]], dy = sy[cand] - sy[chosen[c2]];
          if (dx * dx + dy * dy < minSep2) { ok = false; break; }
        }
        if (ok) chosen.push(cand);
      }
      // If the separation guard couldn't place 5, top up (still seeded).
      while (chosen.length < NP) {
        chosen.push(candidates[Math.floor(rng() * candidates.length)]);
      }
      return chosen;
    }

    // -- Marker construction helpers --------------------------------
    // addMarker(vertexIndex) creates a red square at the position of
    // the given cloud vertex, parented to `points` so it spins with
    // the cloud. Returns the THREE.Points object.
    function addMarker(vIdx) {
      // The marker is parented to `points`, which is itself translated by
      // -center and rotated -π/2 on X. We just need the marker's local
      // position to equal the vertex's raw position; the parent transform
      // will land it on top of the matching cloud vertex.
      var x = positions[vIdx * 3 + 0];
      var y = positions[vIdx * 3 + 1];
      var z = positions[vIdx * 3 + 2];
      var g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
      var m = new THREE.PointsMaterial({
        color: 0x111111,                                 // markers oscuros: contrastan sobre la nube naranja
        size: maxDim * 0.012,
        sizeAttenuation: true,
        transparent: true,
        opacity: 1.0,
        depthWrite: false
      });
      var dot = new THREE.Points(g, m);
      dot.position.set(x, y, z);
      dot.renderOrder = 1;
      points.add(dot);
      return dot;
    }

    if (MODE === 'interactive') {
      // Use the indices defined at the top of this file. If they're
      // missing (null/empty), fall back to the screen-space auto-picker
      // so something still renders.
      if (!RED_VERTEX_INDICES || RED_VERTEX_INDICES.length === 0) {
        RED_VERTEX_INDICES = pickRedVertices();
      }
      RED_VERTEX_INDICES.forEach(function (i) {
        redMarkers.push(addMarker(i));
      });
    }

    // ----- Manual marker placement mode ----------------------------
    // Press 'M' to enter/exit placement mode. While active:
    //   - All existing markers are cleared.
    //   - Each mouse click finds the nearest visible vertex and places
    //     a marker there. Click 5 times (in project order: Dodge,
    //     Srixon, Willett, Nike, Bolt).
    //   - After the 5th click, mode auto-exits and the new indices
    //     are printed to the console. Copy them into RED_VERTEX_INDICES
    //     in this file to make them permanent.
    //   - The cloud's auto-rotation pauses while you're placing so
    //     you can aim accurately.
    var placementMode = false;
    var placementPicks = [];
    var placementBanner = null;
    var savedRotSpeed = null;

    function makeBanner() {
      var b = document.createElement('div');
      b.style.cssText = [
        'position:fixed','top:50%','left:50%','transform:translate(-50%,-50%)',
        'background:rgba(0,0,0,0.85)','color:#fff','border:1px solid #ff2a2a',
        'padding:14px 20px','font:12px ui-monospace,monospace',
        'letter-spacing:0.05em','text-transform:uppercase','z-index:9999',
        'pointer-events:none','text-align:center','line-height:1.6'
      ].join(';');
      document.body.appendChild(b);
      return b;
    }
    function updateBanner() {
      if (!placementBanner) return;
      var labels = ['DODGE [001]','SRIXON [002]','WILLETT [004]','NIKE [005]','BOLT [007]'];
      var next = placementPicks.length < 5 ? labels[placementPicks.length] : '';
      placementBanner.innerHTML =
        'PLACEMENT MODE — CLICK TO PLACE MARKER ' + (placementPicks.length + 1) + ' / 5' +
        (next ? '<br>NEXT: ' + next : '') +
        '<br><span style="opacity:0.6">PRESS M TO CANCEL</span>';
    }
    function enterPlacementMode() {
      placementMode = true;
      placementPicks = [];
      // Clear existing markers
      redMarkers.forEach(function (mk) { points.remove(mk); });
      redMarkers.length = 0;
      RED_VERTEX_INDICES = [];
      placementBanner = makeBanner();
      updateBanner();
      console.log('[placement] entered placement mode — click 5 times');
    }
    function exitPlacementMode() {
      placementMode = false;
      if (placementBanner) {
        placementBanner.parentNode.removeChild(placementBanner);
        placementBanner = null;
      }
      if (placementPicks.length === 5) {
        RED_VERTEX_INDICES = placementPicks.slice();
        console.log('[placement] DONE — copy this line into pointcloud.js:');
        console.log('var RED_VERTEX_INDICES = [' + placementPicks.join(', ') + '];');
      } else {
        console.log('[placement] cancelled');
      }
    }

    // Find nearest visible vertex to a screen-space click
    function nearestVisibleVertex(clickX, clickY) {
      var n = positions.length / 3;
      var worldM = points.matrixWorld;
      var projM  = camera.projectionMatrix;
      var viewM  = camera.matrixWorldInverse;
      var W = window.innerWidth, H = window.innerHeight;
      var v = new THREE.Vector3();
      var bestIdx = -1;
      var bestD2 = Infinity;
      for (var i = 0; i < n; i++) {
        v.set(positions[i*3], positions[i*3+1], positions[i*3+2]);
        v.applyMatrix4(worldM);
        v.applyMatrix4(viewM);
        if (v.z >= 0) continue;
        v.applyMatrix4(projM);
        if (v.x < -1 || v.x > 1 || v.y < -1 || v.y > 1) continue;
        var px = (v.x * 0.5 + 0.5) * W;
        var py = (1 - (v.y * 0.5 + 0.5)) * H;
        var dx = px - clickX, dy = py - clickY;
        var d2 = dx*dx + dy*dy;
        if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
      }
      return bestIdx;
    }

    window.addEventListener('keydown', function (e) {
      if (e.key === 'm' || e.key === 'M') {
        if (placementMode) exitPlacementMode();
        else enterPlacementMode();
      }
    });
    window.addEventListener('click', function (e) {
      if (!placementMode) return;
      e.preventDefault();
      e.stopPropagation();
      points.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      var idx = nearestVisibleVertex(e.clientX, e.clientY);
      if (idx < 0) {
        console.warn('[placement] no visible vertex near click');
        return;
      }
      placementPicks.push(idx);
      redMarkers.push(addMarker(idx));
      console.log('[placement] picked vertex', idx, '(' + placementPicks.length + '/5)');
      updateBanner();
      if (placementPicks.length >= 5) exitPlacementMode();
    }, true);
    // ============================================================

    // Configure depth-fade + DOF uniforms based on cloud scale.
    // FOCUS_DIST is the in-focus distance from camera in view space.
    // We'll animate this each frame to match camera-to-target distance.
    SHARED_UNIFORMS.uFadeNear.value  = maxDim * 0.40;
    SHARED_UNIFORMS.uFadeFar.value   = maxDim * 2.4;
    SHARED_UNIFORMS.uFocusDist.value = maxDim * 0.85;
    // Wider focus band on overview, tighter when snapped to a marker
    SHARED_UNIFORMS.uFocusRange.value = maxDim * 0.9;
    SHARED_UNIFORMS.uBgColor.value.set(0xffffff);

    // ===== BACKGROUND MODE =====
    if (MODE === 'background') {
      // Same angle as the home page, zoomed closer toward the cloud's
      // centre. Each component scaled to 60% of the home-page distance.
      camera.position.set(maxDim * 0.33, maxDim * 0.18, maxDim * 0.33);
      camera.lookAt(OVERVIEW_TARGET);

      // Background pages: no DOF blur, gentle depth fade tuned for the
      // closer camera position so the full cloud reads, dimmed enough
      // to sit calmly behind the frosted-glass content overlay.
      SHARED_UNIFORMS.uFocusRange.value = maxDim * 10.0;
      SHARED_UNIFORMS.uFocusDist.value  = maxDim * 0.30;
      SHARED_UNIFORMS.uFadeNear.value   = maxDim * 0.60;
      SHARED_UNIFORMS.uFadeFar.value    = maxDim * 2.0;

      var lastT = performance.now();
      var breatheTime = 0;
      function animateBg(now) {
        requestAnimationFrame(animateBg);
        var dt = Math.min((now - lastT) / 1000, 0.05);
        lastT = now;
        breatheTime += dt;

        var bobY = Math.sin(breatheTime * 0.6) * maxDim * 0.008;
        var bobX = Math.sin(breatheTime * 0.4 + 1.3) * maxDim * 0.003;
        var breathe = 1 + Math.sin(breatheTime * 0.5) * 0.004;
        cloudGroup.position.y = bobY;
        cloudGroup.position.x = bobX;
        cloudGroup.scale.setScalar(breathe);

        cloudGroup.rotation.y += dt * 0.025;

        renderer.render(scene, camera);
      }
      requestAnimationFrame(function (t) { lastT = t; animateBg(t); });
      window.addEventListener('resize', function () {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
      });
      return;
    }

    // ===== INTERACTIVE MODE =====
    // STATE_COUNT = 1 overview + N proyectos (dinámico según filas)
    var STATE_COUNT = workRows.length + 1;
    var currentState = 0, targetState = 0;
    var transitionProgress = 1;
    var fromCamPos = new THREE.Vector3();
    var toCamPos = new THREE.Vector3();
    var fromCamTarget = new THREE.Vector3();
    var toCamTarget = new THREE.Vector3();
    var fromCloudRotY = 0, toCloudRotY = 0;

    // Idle-affordance state: how long since the user last interacted.
    // Used to drift the camera gently toward the first project and pulse
    // the first red marker so visitors notice the scroll mechanic without
    // explicit UI prompts.
    //
    // Originally `hasInteracted` was a one-way latch (once true, idle
    // hints disabled forever). That made the home page feel inert after
    // any wheel/touch — even after long pauses. Now the gate is purely
    // time-based: if no interaction for longer than IDLE_HINT_DELAY,
    // idle hints kick back in. The currentState === 0 check elsewhere
    // still prevents them from firing on focused-project views.
    var idleTime = 0;
    var IDLE_HINT_DELAY = 3.0;   // seconds before the drift hint begins

    // Idle project cycling: once the idle hint is active, the pulsing
    // marker / camera drift / preview tile advance through every project
    // one at a time, IDLE_CYCLE_INTERVAL seconds each, wrapping around.
    // idleCycleIndex is a 0-based project index. On interaction it is
    // left untouched (the cycle freezes), so when the visitor goes idle
    // again it resumes from whichever project it had reached — only the
    // within-project timer resets so that project gets a full window.
    var IDLE_CYCLE_INTERVAL = 5.0;
    var idleCycleIndex = 0;
    var idleCycleTimer = 0;
    // 0..1 — how far the camera currently is through a drift toward the
    // active project (the bell curve: 0 at rest, 1 at full zoom-in).
    // The idle preview tile fades its opacity in lockstep with this.
    var idleDriftBell = 0;
    function noteInteraction() {
      idleTime = 0;
      idleCycleTimer = 0;
    }
    // Per-transition duration. Project→project hops use the new orbit
    // sweep; transitions that involve the OVERVIEW (the very first swipe
    // in, or pulling back out) use the ORIGINAL straight-line zoom, which
    // the client preferred for the initial engagement. Both run at the
    // same base duration so the whole experience feels cohesive.
    var TRANSITION_DURATION_BASE = 1.2;     // project → project (orbit)
    var TRANSITION_DURATION_OVERVIEW = 1.2; // to/from the overview (original zoom)
    var transitionDuration = TRANSITION_DURATION_BASE;
    var transitionElapsed = 0;
    // True while the current transition is an overview↔project move, so the
    // animate loop uses the original straight-line camera path for it.
    var transitionIsOverview = false;
    var currentCamTarget = OVERVIEW_TARGET.clone();

    function getFocusedCamPos(idx) {
      var worldPos = new THREE.Vector3();
      redMarkers[idx].getWorldPosition(worldPos);
      var horizDir = new THREE.Vector3(worldPos.x, 0, worldPos.z);
      if (horizDir.lengthSq() < 0.0001) horizDir.set(1, 0, 0);
      horizDir.normalize();
      var back = horizDir.multiplyScalar(maxDim * 0.22);
      var camPos = worldPos.clone().add(back);
      camPos.y = worldPos.y + maxDim * 0.03;
      return camPos;
    }
    function getFocusedCamTarget(idx) {
      var worldPos = new THREE.Vector3();
      redMarkers[idx].getWorldPosition(worldPos);
      return worldPos;
    }
    function easeInOutCubic(t) {
      return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    }

    // Spherical interpolation between two (non-unit) offset vectors taken
    // from the cloud centre. We slerp the DIRECTION and ease the RADIUS
    // separately, so the camera sweeps along a clean arc around the cloud
    // at a smoothly varying distance — instead of cutting a straight chord
    // that dips toward/through the centre and reads as a zoom-in/zoom-out
    // "loop". Writes the result into `out` and returns it.
    var _slerpFromDir = new THREE.Vector3();
    var _slerpToDir   = new THREE.Vector3();
    var _orbitFromOff = new THREE.Vector3();
    var _orbitToOff   = new THREE.Vector3();
    var _orbitOut     = new THREE.Vector3();
    function orbitInterp(fromOff, toOff, t, out) {
      var fromLen = fromOff.length();
      var toLen   = toOff.length();
      var radius  = fromLen + (toLen - fromLen) * t;
      if (fromLen < 1e-6 || toLen < 1e-6) {
        // Degenerate (a point sits at the centre) — fall back to a plain
        // linear blend; there's no meaningful direction to slerp.
        return out.copy(fromOff).lerp(toOff, t);
      }
      _slerpFromDir.copy(fromOff).divideScalar(fromLen);
      _slerpToDir.copy(toOff).divideScalar(toLen);
      var dot = Math.max(-1, Math.min(1, _slerpFromDir.dot(_slerpToDir)));
      var theta = Math.acos(dot);
      if (theta < 1e-3) {
        // Nearly collinear — slerp is numerically unstable, lerp instead.
        out.copy(_slerpFromDir).lerp(_slerpToDir, t);
        if (out.lengthSq() > 1e-12) out.normalize();
      } else {
        var sinTheta = Math.sin(theta);
        var w1 = Math.sin((1 - t) * theta) / sinTheta;
        var w2 = Math.sin(t * theta) / sinTheta;
        out.copy(_slerpFromDir).multiplyScalar(w1).addScaledVector(_slerpToDir, w2);
      }
      return out.multiplyScalar(radius);
    }

    function startTransition(newState) {
      if (newState === currentState && transitionProgress >= 1) return;
      fromCamPos.copy(camera.position);
      fromCamTarget.copy(currentCamTarget);
      fromCloudRotY = cloudGroup.rotation.y;

      var involvesOverview = (newState === 0 || currentState === 0);
      transitionIsOverview = involvesOverview;

      if (involvesOverview) {
        // ORIGINAL overview behaviour (restored at the client's request):
        // a gentle cloud spin paired with the straight-line zoom in the
        // animate loop. This is the initial "observe the cloud, then zoom
        // in" move they preferred over the orbit sweep.
        var isForward = ((newState - currentState + STATE_COUNT) % STATE_COUNT) <= STATE_COUNT / 2;
        var spinAmount = Math.PI * 0.4;
        toCloudRotY = fromCloudRotY + (isForward ? spinAmount : -spinAmount);
      } else {
        // Project→project: no large cloud spin — the camera ORBITS on a
        // smooth arc (see orbitInterp), which already carries the eye
        // around the cloud. Layering a big rotation on top produced the
        // disorienting "loop the loop" swoop, so keep rotation steady.
        toCloudRotY = fromCloudRotY;
      }

      if (newState === 0) {
        toCamPos.copy(OVERVIEW_POS);
        toCamTarget.copy(OVERVIEW_TARGET);
      } else {
        var savedY = cloudGroup.rotation.y;
        cloudGroup.rotation.y = toCloudRotY;
        cloudGroup.updateMatrixWorld(true);
        toCamPos.copy(getFocusedCamPos(newState - 1));
        toCamTarget.copy(getFocusedCamTarget(newState - 1));
        cloudGroup.rotation.y = savedY;
        cloudGroup.updateMatrixWorld(true);
      }

      transitionDuration = involvesOverview
        ? TRANSITION_DURATION_OVERVIEW
        : TRANSITION_DURATION_BASE;

      targetState = newState;
      transitionProgress = 0;
      transitionElapsed = 0;
      previewReady = false;
      if (thumbWrap) thumbWrap.classList.remove('visible');
    }

    // Gate that goes false at the start of every transition and only
    // flips back to true once the new project's preview thumbnail has
    // decoded and faded in. Without this, fast scrolls fire before the
    // preview is ready and end up "skipping" projects — the rotation
    // moves on while the previous decode is still pending.
    // Gate that goes false at the start of every transition and only
    // flips back to true once the new project's preview thumbnail has
    // decoded and faded in.
    var previewReady = true;

    // Trackpad inertial scrolling fires wheel events for ~1-1.5s after the
    // user's fingers leave the surface, with steadily decreasing deltaY.
    // We need to swallow that inertial tail so it doesn't auto-trigger a
    // second transition, WITHOUT swallowing a genuine new swipe.
    //
    // The lock is a simple time bound: when a wheel-driven transition
    // starts, ignore wheel events until the transition finishes plus a
    // short buffer that covers the dying inertia. Crucially the window is
    // a fixed timestamp that incoming events DO NOT extend — otherwise a
    // user who keeps swiping keeps pushing the unlock further out and the
    // cloud appears frozen until they stop (the old quiet-timer bug).
    var wheelIgnoreUntil = 0;        // performance.now() timestamp
    var WHEEL_INERTIA_BUFFER = 300;  // ms after the transition to absorb inertia

    function handleScroll(direction, idleWasActive, idleIdxAtScroll, isTouch) {
      // Touch swipes are discrete gestures with no inertial tail, so they
      // bypass the wheel lock entirely.
      if (!isTouch && performance.now() < wheelIgnoreUntil) return;
      if (transitionProgress < 1 || !previewReady) return;

      var next;
      if (direction > 0) {
        if (currentState === 0) {
          // If the idle hint was mid-cycle when the scroll fired, land
          // on whichever project the idle preview was showing —
          // otherwise the first scroll feels like it "skips" past the
          // visually highlighted project. (Captured before
          // noteInteraction reset the idle timer.)
          next = idleWasActive ? (idleIdxAtScroll + 1) : 1;
        }
        else if (currentState === STATE_COUNT - 1) next = 1; // last project loops to first
        else next = currentState + 1;
      } else {
        if (currentState === 0) return;
        else if (currentState === 1) next = 0;
        else next = currentState - 1;
      }

      // Kick off the move first so transitionDuration is set for THIS
      // transition (startTransition picks the longer overview duration when
      // relevant), then bound the wheel lock to that duration plus the
      // inertia buffer. Touch has no inertial tail, so it sets no lock.
      startTransition(next);
      if (!isTouch) {
        wheelIgnoreUntil = performance.now() + transitionDuration * 1000 + WHEEL_INERTIA_BUFFER;
      }
    }

    // Capture whether the idle hint was active BEFORE noteInteraction()
    // resets idleTime to 0 — otherwise handleScroll always sees idle as
    // inactive and the "land on the highlighted project" logic never fires.
    function wasIdleHintActive() {
      return currentState === 0 && idleTime > IDLE_HINT_DELAY;
    }

    window.addEventListener('wheel', function (e) {
      e.preventDefault();
      var idleWasActive = wasIdleHintActive();
      var idleIdxAtScroll = idleCycleIndex;
      noteInteraction();
      handleScroll(e.deltaY > 0 ? 1 : -1, idleWasActive, idleIdxAtScroll);
    }, { passive: false });

    // ----- Red-marker tap/click → snap to that project -----
    // Project every red marker to screen pixels each event and find the
    // closest one. If the closest sits within HIT_RADIUS px of the
    // pointer, snap to that project (same effect as scrolling or
    // clicking the row). Works for both mouse clicks and touch taps.
    //   - Only fires for events whose target is the renderer's canvas
    //     (so clicking a project-table row or the thumbnail doesn't
    //     double-fire), and never while placement mode is active.
    //   - The placement-mode click listener uses capture phase and
    //     stopPropagation()s when it acts, so it won't reach us anyway.
    var HIT_RADIUS = 56; // px — comfortable touch target, a bit forgiving
    function tryHitMarker(clientX, clientY) {
      if (placementMode) return -1;
      if (redMarkers.length === 0) return -1;
      points.updateMatrixWorld(true);
      camera.updateMatrixWorld(true);
      var W = window.innerWidth, H = window.innerHeight;
      var v = new THREE.Vector3();
      var bestIdx = -1, bestD2 = Infinity;
      for (var i = 0; i < redMarkers.length; i++) {
        redMarkers[i].getWorldPosition(v);
        v.project(camera);
        // Skip markers that are behind the camera. In NDC after .project(),
        // anything with z > 1 sits past the far plane (or behind camera in
        // perspective projection); anything well outside x/y ±1 is off
        // screen. Use a generous bound so edge markers still register.
        if (v.z > 1) continue;
        if (Math.abs(v.x) > 1.2 || Math.abs(v.y) > 1.2) continue;
        var px = (v.x * 0.5 + 0.5) * W;
        var py = (1 - (v.y * 0.5 + 0.5)) * H;
        var dx = px - clientX, dy = py - clientY;
        var d2 = dx*dx + dy*dy;
        if (d2 < bestD2) { bestD2 = d2; bestIdx = i; }
      }
      return bestD2 <= HIT_RADIUS * HIT_RADIUS ? bestIdx : -1;
    }
    renderer.domElement.addEventListener('click', function (e) {
      var hit = tryHitMarker(e.clientX, e.clientY);
      if (hit < 0) return;
      noteInteraction();
      startTransition(hit + 1);
    });

    var touchStartY = null;
    var touchStartX = null;
    var touchStartIdleActive = false;
    var touchStartIdleIdx = 0;
    window.addEventListener('touchstart', function (e) {
      touchStartY = e.touches[0].clientY;
      touchStartX = e.touches[0].clientX;
      touchStartIdleActive = wasIdleHintActive();
      touchStartIdleIdx = idleCycleIndex;
      noteInteraction();
    });
    window.addEventListener('touchmove',  function (e) { e.preventDefault(); }, { passive: false });
    window.addEventListener('touchend',   function (e) {
      if (touchStartY == null) return;
      var endY = e.changedTouches[0].clientY;
      var endX = e.changedTouches[0].clientX;
      var dy = touchStartY - endY;
      var dx = touchStartX - endX;
      // Swipe (vertical): treat as scroll. Tap (small movement): try a
      // red-marker hit at the release point — only if the touch landed
      // on the renderer canvas (so taps on UI like the project table
      // don't get hijacked).
      if (Math.abs(dy) > 30) {
        handleScroll(dy > 0 ? 1 : -1, touchStartIdleActive, touchStartIdleIdx, true);
      } else if (Math.abs(dx) < 10 && Math.abs(dy) < 10 &&
                 e.target === renderer.domElement) {
        var hit = tryHitMarker(endX, endY);
        if (hit >= 0) {
          noteInteraction();
          startTransition(hit + 1);
        }
      }
      touchStartY = null;
      touchStartX = null;
    });

    // ----- Idle preview tile setup -----
    // Show a small low-opacity loop after the IDLE_HINT_DELAY so the
    // visitor immediately reads this as a film portfolio. The image
    // tracks idleCycleIndex — it swaps to whichever project the idle
    // cycle currently points at.
    var idlePreview = document.getElementById('idle-preview');
    var idlePreviewImg = document.getElementById('idle-preview-img');
    var idlePreviewShownIndex = -1; // last index the tile was placed for

    // Parking spots — one per project index. As the idle cycle advances,
    // the tile hops to spot[idleCycleIndex] so it never camps on a single
    // piece of UI and stays clear of the centre / point cloud. Each spot
    // pins two edges; the other two are cleared to 'auto'. Values are
    // edge-hugging and chosen to dodge the nav (top band), #site-loc
    // (top-centre), the project table (bottom-left) and the bottom bar.
    var IDLE_PREVIEW_SPOTS = [
      { left: '15px',  top: '90px',    right: 'auto', bottom: 'auto' }, // top-left
      { left: 'auto',  top: '90px',    right: '15px', bottom: 'auto' }, // top-right
      { left: 'auto',  top: 'auto',    right: '15px', bottom: '50%'  }, // mid-right
      { left: 'auto',  top: 'auto',    right: '15px', bottom: '90px' }, // bottom-right
      { left: '15px',  top: 'auto',    right: 'auto', bottom: '247px'} // above project table
    ];
    function placeIdlePreview(idx) {
      if (!idlePreview) return;
      var spot = IDLE_PREVIEW_SPOTS[idx % IDLE_PREVIEW_SPOTS.length];
      idlePreview.style.left   = spot.left;
      idlePreview.style.top    = spot.top;
      idlePreview.style.right  = spot.right;
      idlePreview.style.bottom = spot.bottom;
    }

    if (idlePreview && idlePreviewImg && THUMB_URLS.length > 0) {
      idlePreviewImg.src = THUMB_URLS[0];
      idlePreviewShownIndex = 0;
      placeIdlePreview(0);
    }
    function updateIdlePreview() {
      if (!idlePreview) return;
      // The tile's opacity follows idleDriftBell (0..1): it fades in as
      // the camera zooms toward the pulsing marker, stays at full
      // opacity during the hold, and fades out as the camera zooms
      // back. Outside an idle drift the bell is 0, so the tile is
      // invisible. We still need the image/spot prepared *before* the
      // fade-in, so the swap happens whenever the cycle index changes
      // regardless of the current opacity.
      var idleActive = currentState === 0 && idleTime > IDLE_HINT_DELAY;

      if (idleActive &&
          idleCycleIndex !== idlePreviewShownIndex &&
          THUMB_URLS[idleCycleIndex]) {
        if (idlePreviewImg) idlePreviewImg.src = THUMB_URLS[idleCycleIndex];
        placeIdlePreview(idleCycleIndex);
        idlePreviewShownIndex = idleCycleIndex;
      }

      // Opacity tracks the camera zoom. 0.78 keeps the tile slightly
      // translucent even at full zoom, matching the original design.
      var op = idleActive ? idleDriftBell * 0.78 : 0;
      idlePreview.style.opacity = op.toFixed(3);
    }

    // Cache every marker's base size so we can pulse whichever one the
    // idle cycle currently points at, and ease the others back to normal.
    var markerBaseSizes = redMarkers.map(function (mk) { return mk.material.size; });

    // Pre-compute the focused camera state for a given project so we can
    // lerp toward it during idle without committing to a full transition.
    var hintCamPos = new THREE.Vector3();
    var hintCamTarget = new THREE.Vector3();
    function computeHintTargets(idx) {
      cloudGroup.updateMatrixWorld(true);
      hintCamPos.copy(getFocusedCamPos(idx));
      hintCamTarget.copy(getFocusedCamTarget(idx));
    }

    var lastT = performance.now();
    var breatheTime = 0;
    function animate(now) {
      requestAnimationFrame(animate);
      var dt = Math.min((now - lastT) / 1000, 0.05);
      lastT = now;
      breatheTime += dt;
      idleTime += dt;

      var bobY = Math.sin(breatheTime * 0.6) * maxDim * 0.008;
      var bobX = Math.sin(breatheTime * 0.4 + 1.3) * maxDim * 0.003;
      var breathe = 1 + Math.sin(breatheTime * 0.5) * 0.004;
      cloudGroup.position.y = bobY;
      cloudGroup.position.x = bobX;
      cloudGroup.scale.setScalar(breathe);

      if (transitionProgress < 1) {
        transitionElapsed += dt;
        transitionProgress = Math.min(1, transitionElapsed / transitionDuration);
        var e = easeInOutCubic(transitionProgress);

        if (transitionIsOverview) {
          // ORIGINAL overview move: straight-line zoom between the wide
          // overview position and the project — the "observe, then zoom
          // in" feel the client preferred.
          camera.position.lerpVectors(fromCamPos, toCamPos, e);
        } else {
          // Project→project: orbit the camera around the cloud centre
          // (origin) on a smooth arc rather than lerping in a straight
          // line — see orbitInterp.
          _orbitFromOff.subVectors(fromCamPos, OVERVIEW_TARGET);
          _orbitToOff.subVectors(toCamPos, OVERVIEW_TARGET);
          orbitInterp(_orbitFromOff, _orbitToOff, e, _orbitOut);
          camera.position.copy(OVERVIEW_TARGET).add(_orbitOut);
        }
        currentCamTarget.lerpVectors(fromCamTarget, toCamTarget, e);
        camera.up.set(0, 1, 0);
        camera.lookAt(currentCamTarget);

        cloudGroup.rotation.y = fromCloudRotY + (toCloudRotY - fromCloudRotY) * e;

        if (transitionProgress >= 1 && currentState !== targetState) {
          currentState = targetState;
          if (currentState > 0) {
            var idx = currentState - 1;
            if (thumbLink) thumbLink.href = PROJECT_URLS[idx];
            if (thumbImg) {
              thumbImg.src = THUMB_URLS[idx];
              // Wait for the new image to actually be decoded and
              // ready to paint before fading in the preview. Without
              // this, fast scrolls reveal the old src for a frame or
              // two while the new one is still decoding.
              //
              // Always flip previewReady true when this resolves,
              // even if the user has since moved on — otherwise a
              // stale decode would leave the scroll gate stuck shut.
              // Only call classList.add if we are still on the same
              // project, so a slow decode can't make an old preview
              // pop up over a newer one.
              var pendingIdx = idx;
              var reveal = function () {
                if (pendingIdx === currentState - 1 && thumbWrap) {
                  thumbWrap.classList.add('visible');
                }
                previewReady = true;
              };
              if (thumbImg.decode) {
                thumbImg.decode().then(reveal).catch(reveal);
              } else {
                reveal();
              }
            } else {
              if (thumbWrap) thumbWrap.classList.add('visible');
              previewReady = true;
            }
          } else {
            if (thumbWrap) thumbWrap.classList.remove('visible');
            previewReady = true;
          }
        }
      } else {
        var rotSpeed = currentState === 0 ? 0.035 : 0.012;
        cloudGroup.rotation.y += dt * rotSpeed;
        camera.up.set(0, 1, 0);

        // ----- Idle affordance: preview-snap demo toward a project -----
        // Rather than a faint sway, we periodically do a partial snap
        // toward a project (~30% of the way) and ease back. This reads
        // unmistakably as "scrolling moves you to a project" without
        // any UI text — the cloud is demonstrating the mechanic.
        //
        // While idle, the target project advances every
        // IDLE_CYCLE_INTERVAL seconds, wrapping through all projects, so
        // the pulse / drift / preview cycle the whole portfolio one at
        // a time instead of fixating on project 1.
        if (currentState === 0 && idleTime > IDLE_HINT_DELAY) {
          // Advance the cycle index on its own timer.
          idleCycleTimer += dt;
          if (idleCycleTimer >= IDLE_CYCLE_INTERVAL) {
            idleCycleTimer -= IDLE_CYCLE_INTERVAL;
            if (redMarkers.length > 0) {
              idleCycleIndex = (idleCycleIndex + 1) % redMarkers.length;
            }
          }

          computeHintTargets(idleCycleIndex);
          var hintT = idleCycleTimer; // 0..IDLE_CYCLE_INTERVAL within this project
          // Bell curve across the interval: ease toward the project,
          // brief hold, ease back, short rest before the next index.
          var phase = hintT / IDLE_CYCLE_INTERVAL; // 0..1
          var bell;
          if (phase < 0.4) {
            bell = phase / 0.4;
          } else if (phase < 0.6) {
            bell = 1.0; // brief hold at peak
          } else if (phase < 0.85) {
            bell = 1.0 - (phase - 0.6) / 0.25;
          } else {
            bell = 0.0;
          }
          // Smooth the curve (cubic ease)
          bell = bell * bell * (3.0 - 2.0 * bell);
          // Expose this so updateIdlePreview() can fade the preview tile
          // in/out in lockstep with the camera zoom toward the project.
          idleDriftBell = bell;
          var driftAmount = bell * 0.30; // up to 30% of the way to the project
          var driftedPos = OVERVIEW_POS.clone().lerp(hintCamPos, driftAmount);
          var driftedTarget = OVERVIEW_TARGET.clone().lerp(hintCamTarget, driftAmount);
          camera.position.copy(driftedPos);
          currentCamTarget.copy(driftedTarget);
        } else {
          // Not in the idle drift — no zoom, so no preview.
          idleDriftBell = 0;
        }
        camera.lookAt(currentCamTarget);
      }

      // ----- Idle marker pulse -----
      // While idle on overview, the marker for the current idle-cycle
      // project pulses noticeably as a beacon; every other marker eases
      // back toward its cached base size. When not idle, all markers
      // settle to base size.
      if (redMarkers.length > 0) {
        var idleActive = currentState === 0 && idleTime > IDLE_HINT_DELAY * 0.5;
        for (var mi = 0; mi < redMarkers.length; mi++) {
          var mkMat = redMarkers[mi].material;
          var base = markerBaseSizes[mi];
          var target = (idleActive && mi === idleCycleIndex)
            ? base * (1 + Math.sin(idleTime * 2.4) * 0.7 + 0.8)
            : base;
          // lerp toward target so toggling on/off is smooth
          mkMat.size += (target - mkMat.size) * Math.min(1, dt * 5);
        }
      }

      updateIdlePreview();

      // Drive focus distance from the camera->look-target distance so the
      // focal plane sits on whatever the camera is pointed at. Smoothly
      // tighten the focus band when snapped to a marker, widen on overview.
      var camToTarget = camera.position.distanceTo(currentCamTarget);
      SHARED_UNIFORMS.uFocusDist.value += (camToTarget - SHARED_UNIFORMS.uFocusDist.value) * Math.min(1, dt * 6);
      var targetRange = (currentState === 0 && transitionProgress >= 1)
        ? maxDim * 0.9    // wide on overview — most of cloud sharp
        : maxDim * 0.25;  // moderate when focused (was 0.12 — too tight)
      SHARED_UNIFORMS.uFocusRange.value += (targetRange - SHARED_UNIFORMS.uFocusRange.value) * Math.min(1, dt * 3);

      renderer.render(scene, camera);
    }
    requestAnimationFrame(function (t) { lastT = t; animate(t); });

    window.addEventListener('resize', function () {
      camera.aspect = window.innerWidth / window.innerHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(window.innerWidth, window.innerHeight);
    });

    workRows.forEach(function (row) {
      row.addEventListener('click', function () {
        noteInteraction();
        var idx = parseInt(row.dataset.idx, 10);
        startTransition(idx + 1);
      });
    });

    // Soft interaction signals: any mouse movement or keypress also resets
    // the idle timer (so the pulse/drift hint never overlaps with an
    // already-engaged visitor) but does not count as a hard interaction.
    window.addEventListener('mousemove', function () {
      idleTime = 0;
    });
    window.addEventListener('keydown', function (e) {
      // Arrow keys also drive the carousel
      if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
        var kIdle = wasIdleHintActive(), kIdx = idleCycleIndex;
        noteInteraction();
        handleScroll(1, kIdle, kIdx);
      }
      else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
        var kIdle2 = wasIdleHintActive(), kIdx2 = idleCycleIndex;
        noteInteraction();
        handleScroll(-1, kIdle2, kIdx2);
      }
      else { idleTime = 0; }
    });

    function updateActiveRow() {
      // Is the idle cycle currently running? Mirrors the gate used for
      // the marker pulse / camera drift / preview tile.
      var idleActive = currentState === 0 && idleTime > IDLE_HINT_DELAY * 0.5;
      workRows.forEach(function (row, i) {
        // .active — the click/scroll-selected project (red title).
        if (currentState > 0 && (i + 1) === currentState) {
          row.classList.add('active');
        } else {
          row.classList.remove('active');
        }
        // .idle-active — the project the idle cycle is previewing
        // (all-white text). Only one row at a time; cleared when the
        // visitor is not idle or has navigated into a project.
        if (idleActive && i === idleCycleIndex) {
          row.classList.add('idle-active');
        } else {
          row.classList.remove('idle-active');
        }
      });
    }
    setInterval(updateActiveRow, 100);
  }
})();
