import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

/* ==========================================================
   NOVA MOTORS — Nissan GT-R R35
   One scene, one GLB, one camera. GSAP ScrollTrigger scrubs a
   single master timeline that drives car + camera together.
   ========================================================== */

const { gsap, ScrollTrigger } = window;
gsap.registerPlugin(ScrollTrigger);

const CONFIG = {
  modelUrl: './nissan_skyline_gtr_r35.glb',
  estimatedBytes: 17727652,   // used only if the server sends no Content-Length
  carLength: 4.6              // the model is normalised to this length (world units)
};

const $ = (sel, root = document) => root.querySelector(sel);
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));

const lowPower =
  window.matchMedia('(pointer: coarse)').matches ||
  /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
const finePointer = window.matchMedia('(pointer: fine)').matches;
const PIXEL_RATIO_CAP = lowPower ? 1.5 : 2; // never above 2

/* ---------- Loader UI ---------- */

const ui = {
  loader: $('#loader'),
  pct: $('#loader-pct'),
  bar: $('#loader-bar'),
  error: $('#loader-error')
};
const shown = { v: 0 };

function setLoadProgress(p) {
  gsap.to(shown, {
    v: p,
    duration: 0.5,
    ease: 'power2.out',
    overwrite: true,
    onUpdate() {
      ui.pct.textContent = String(Math.round(shown.v * 100));
      ui.bar.style.transform = `scaleX(${shown.v})`;
    }
  });
}

function fail(message) {
  ui.error.hidden = false;
  ui.error.textContent = message;
  document.documentElement.classList.add('has-error');
}

/* ---------- Main ---------- */

async function main() {
  if ('scrollRestoration' in history) history.scrollRestoration = 'manual';
  window.scrollTo(0, 0);

  const canvas = $('#stage');

  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      powerPreference: 'high-performance'
    });
  } catch (err) {
    fail('WebGL is not available on this device or browser.');
    return;
  }

  renderer.setPixelRatio(Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;

  canvas.addEventListener('webglcontextlost', (e) => e.preventDefault());
  canvas.addEventListener('webglcontextrestored', () => window.location.reload());

  /* ----- Scene, camera ----- */

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(32, 1, 0.05, 80);

  const size = { w: 0, h: 0 };
  let composer = null;
  let bokeh = null;
  let dirty = true;
  const markDirty = () => { dirty = true; };

  /* Studio backdrop: deep black with a faint lifted centre (dithered to avoid banding) */
  const bgTexture = makeBackdropTexture();
  scene.background = bgTexture;

  /* Studio reflections */
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environment = envTexture;
  scene.environmentIntensity = 0.8;
  pmrem.dispose();

  /* Cinematic lighting: soft key, cool + warm rims, tiny fill */
  const key = new THREE.DirectionalLight(0xfff1e0, 2.2);
  key.position.set(4, 6, 5);
  const rimCool = new THREE.DirectionalLight(0x7aa2ff, 3.0);
  rimCool.position.set(-6, 3, -5);
  const rimWarm = new THREE.DirectionalLight(0xffe2c0, 2.2);
  rimWarm.position.set(6, 2.5, -4);
  const fill = new THREE.HemisphereLight(0x8899bb, 0x050505, 0.25);
  scene.add(key, rimCool, rimWarm, fill);

  /* ----- Car rig: carRoot (animated) > fit (normalise) > orient (face +Z) > model ----- */

  const carRoot = new THREE.Group();
  const fit = new THREE.Group();
  const orient = new THREE.Group();
  scene.add(carRoot);
  carRoot.add(fit);
  fit.add(orient);

  /* ----- Load the GLB (once) ----- */

  const gltf = await new Promise((resolve, reject) => {
    new GLTFLoader().load(
      CONFIG.modelUrl,
      resolve,
      (e) => {
        const p = e.lengthComputable && e.total ? e.loaded / e.total : e.loaded / CONFIG.estimatedBytes;
        setLoadProgress(clamp(p, 0, 1) * 0.9);
      },
      reject
    );
  });

  const model = gltf.scene;
  orient.add(model);
  setLoadProgress(0.93);

  /* Materials: sharpen, tame glass, register light-up parts */
  const maxAniso = Math.min(renderer.capabilities.getMaxAnisotropy(), lowPower ? 4 : 8);
  const glow = { head: [], tail: [] };
  const seen = new Set();

  model.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    mats.forEach((m) => {
      if (!m || seen.has(m)) return;
      seen.add(m);
      tuneMaterial(m);
    });
  });

  function tuneMaterial(m) {
    const name = m.name || '';
    for (const k in m) {
      const v = m[k];
      if (v && v.isTexture) v.anisotropy = maxAniso;
    }
    if (/glass/i.test(name)) {
      m.transparent = true;
      m.opacity = Math.min(m.opacity, 0.34); // see-through so the cabin reads
      m.depthWrite = false;
    }
    if (lowPower && m.isMeshPhysicalMaterial && !/paint/i.test(name)) m.clearcoat = 0;
    if (/headlight|highbeam/i.test(name)) registerGlow(m, 0xfff2dd, glow.head);
    if (/taillight/i.test(name)) registerGlow(m, 0xff2418, glow.tail);
  }

  function registerGlow(m, color, list) {
    if (!m.emissive || m.emissiveMap || m.emissive.getHex() !== 0) return;
    m.emissive.setHex(color);
    m.emissiveIntensity = 0;
    m.needsUpdate = true;
    list.push(m);
  }

  /* ----- Orientation: find the front using the lamps, then face it toward +Z ----- */

  scene.updateMatrixWorld(true);

  const headBox = boxOfMaterials(model, /headlight|grille/i);
  const tailBox = boxOfMaterials(model, /taillight/i);
  let yaw = 0;
  if (headBox && tailBox) {
    const h = headBox.getCenter(new THREE.Vector3());
    const t = tailBox.getCenter(new THREE.Vector3());
    const dx = h.x - t.x;
    const dz = h.z - t.z;
    if (Math.hypot(dx, dz) > 0.2) {
      let phi = Math.atan2(dx, dz);
      const snapped = Math.round(phi / (Math.PI / 2)) * (Math.PI / 2);
      if (Math.abs(phi - snapped) < 0.15) phi = snapped;
      yaw = -phi;
    }
  } else {
    const b = new THREE.Box3().setFromObject(model);
    const s = b.getSize(new THREE.Vector3());
    if (s.x > s.z) yaw = Math.PI / 2;
  }
  orient.rotation.y = yaw;
  scene.updateMatrixWorld(true);

  /* Normalise: centre on the floor, fixed length */
  const rawBox = new THREE.Box3().setFromObject(orient);
  const rawSize = rawBox.getSize(new THREE.Vector3());
  const rawCenter = rawBox.getCenter(new THREE.Vector3());
  const k = CONFIG.carLength / rawSize.z;
  fit.scale.setScalar(k);
  fit.position.set(-rawCenter.x * k, -rawBox.min.y * k, -rawCenter.z * k);
  scene.updateMatrixWorld(true);

  const carBox = new THREE.Box3().setFromObject(carRoot);
  const carSize = carBox.getSize(new THREE.Vector3());
  const L = carSize.z;
  const W = carSize.x;
  const H = carSize.y;

  /* Driver side + steering wheel anchor (in car-local space) */
  const wheelBox = boxOfMaterials(model, /steeringwheel/i);
  const steer = wheelBox
    ? wheelBox.getCenter(new THREE.Vector3())
    : new THREE.Vector3(0.38, H * 0.66, L * 0.06);
  const s = steer.x >= 0 ? 1 : -1;   // +1: driver on the car's left (+X when facing +Z)
  const dir = -s;                    // yaw sign that turns the driver's side toward the camera

  /* Ground: soft glow + contact shadow, both ride with the car */
  const glowMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(22, 22),
    new THREE.MeshBasicMaterial({
      map: radialTexture([[0, 'rgba(74,78,92,0.55)'], [0.45, 'rgba(30,32,40,0.24)'], [1, 'rgba(0,0,0,0)']]),
      transparent: true,
      depthWrite: false,
      toneMapped: false
    })
  );
  glowMesh.rotation.x = -Math.PI / 2;
  glowMesh.position.y = -0.004;
  glowMesh.renderOrder = -2;

  const shadowMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: radialTexture([[0, 'rgba(0,0,0,0.95)'], [0.55, 'rgba(0,0,0,0.6)'], [1, 'rgba(0,0,0,0)']]),
      transparent: true,
      depthWrite: false,
      toneMapped: false
    })
  );
  shadowMesh.rotation.x = -Math.PI / 2;
  shadowMesh.scale.set(W * 1.7, L * 1.3, 1);
  shadowMesh.position.y = 0.006;
  shadowMesh.renderOrder = -1;
  carRoot.add(glowMesh, shadowMesh);

  /* ----- Animated state (everything the master timeline touches) ----- */

  const state = {
    rot: 0, px: 0, sc: 1, ox: 0,
    cx: 0, cy: 0, cz: 0,
    tx: 0, ty: 0, tz: 0,
    fw: 4.4,       // world width that must stay in frame (keeps phones from cropping the car)
    dof: 0,        // depth-of-field amount
    hl: 0,         // headlight glow
    tl: 0,         // taillight glow
    intro: 0       // opening dolly, 0 -> 1 after loading
  };

  const V = (x, y, z) => new THREE.Vector3(x, y, z);
  const toWorld = (v, rot, scale = 1) => {
    const c = Math.cos(rot);
    const sn = Math.sin(rot);
    return V((v.x * c + v.z * sn) * scale, v.y * scale, (-v.x * sn + v.z * c) * scale);
  };

  /* Keyframes. rot is yaw of the car; dir flips it so the DRIVER'S side always faces the camera.
     Times are in "viewport heights of scroll": section tops sit at 0, 1, 2, 3 and 4.6. */

  // 02 performance: look at the front wheel / brake / flank from a low, slightly-forward angle
  const rotPerf = dir * 1.12;
  const scPerf = 1.04;
  const wheelAnchor = toWorld(V(s * W * 0.5, H * 0.3, L * 0.25), rotPerf, scPerf);
  const sideN = (r) => V(s * Math.cos(r), 0, -s * Math.sin(r));   // driver-side normal
  const frontD = (r) => V(Math.sin(r), 0, Math.cos(r));           // car's forward direction
  const perfCam = wheelAnchor.clone()
    .addScaledVector(sideN(rotPerf), 3.3)
    .addScaledVector(frontD(rotPerf), 1.1)
    .add(V(0, H * 0.42, 0));

  // 05 interior: outside the driver's window, looking across at the wheel and dash
  const rotIn = dir * Math.PI / 2;
  const camIn = toWorld(V(s * (W * 0.5 + 0.3), steer.y + 0.28, steer.z - 0.75), rotIn);
  const tgtIn = toWorld(V(steer.x - s * 0.12, steer.y - 0.14, steer.z + 0.3), rotIn);
  const camInMid = camIn.clone().add(V(0, 0.35, 3.4));

  const kf = [
    // 01 front 3/4, high and close, car slightly right
    { t: 0,   rot: dir * 0.72, px: 0.8, sc: 1, ox: 0,
      cx: 0, cy: H * 1.5, cz: 6.5, tx: -0.2, ty: H * 0.36, tz: 0.4, fw: 4.4, dof: 0, hl: 1, tl: 0 },
    // 02 turn toward the driver's side, push in on wheels + brakes
    { t: 1,   rot: rotPerf, px: 0, sc: scPerf, ox: 1.1,
      cx: perfCam.x, cy: perfCam.y, cz: perfCam.z, tx: wheelAnchor.x, ty: wheelAnchor.y, tz: wheelAnchor.z,
      fw: 2.4, dof: 0, hl: 0.2, tl: 0 },
    // 03 clean side profile, car glides left
    { t: 2,   rot: dir * Math.PI / 2, px: -1.0, sc: 1, ox: 0,
      cx: 0, cy: H * 0.68, cz: 8.4, tx: 0, ty: H * 0.25, tz: 0, fw: 5.4, dof: 0, hl: 0, tl: 0 },
    // 04 rear three-quarter, low camera
    { t: 3,   rot: dir * 2.55, px: 0.7, sc: 1, ox: 0,
      cx: 0, cy: H * 0.55, cz: 6.2, tx: -0.3, ty: H * 0.36, tz: 0, fw: 3.6, dof: 0, hl: 0, tl: 1 },
    //    ...then square onto the rear
    { t: 3.6, rot: dir * Math.PI, px: 0.5, sc: 1, ox: 0,
      cx: 0, cy: H * 0.36, cz: 5.6, tx: -0.2, ty: H * 0.36, tz: 0, fw: 2.9, dof: 0, hl: 0, tl: 1 },
    // 05a swing round to the driver's side and pull back on the cabin
    { t: 4.1, rot: rotIn, px: 0, sc: 1, ox: 0,
      cx: camInMid.x, cy: camInMid.y, cz: camInMid.z, tx: tgtIn.x, ty: tgtIn.y, tz: tgtIn.z,
      fw: 0.9, dof: 0, hl: 0, tl: 0.3 },
    // 05b travel in to the window
    { t: 4.6, rot: rotIn, px: 0, sc: 1, ox: 0,
      cx: camIn.x, cy: camIn.y, cz: camIn.z, tx: tgtIn.x, ty: tgtIn.y, tz: tgtIn.z,
      fw: 0.6, dof: 1, hl: 0, tl: 0 }
  ];

  const { t: _t0, ...first } = kf[0];
  Object.assign(state, first);

  /* ----- Per-frame application of state to car + camera ----- */

  const par = { x: 0, y: 0, tx: 0, ty: 0 };   // pointer parallax (desktop only)
  const tgt = new THREE.Vector3();
  const cam = new THREE.Vector3();
  const off = new THREE.Vector3();

  function applyState() {
    const aspect = camera.aspect;
    const xf = clamp((aspect - 0.85) / 0.75, 0, 1);   // sideways staging fades out in portrait

    carRoot.rotation.y = state.rot + (1 - state.intro) * dir * 0.9;
    carRoot.position.set(state.px * xf, 0, 0);
    carRoot.scale.setScalar(state.sc);

    const ox = state.ox * xf;
    tgt.set(state.tx - ox, state.ty, state.tz);
    cam.set(state.cx - ox, state.cy, state.cz);

    // keep the required width in frame on narrow screens
    off.copy(cam).sub(tgt);
    const dist = off.length();
    const need = state.fw / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * aspect);
    if (dist < need) off.multiplyScalar(need / dist);
    off.multiplyScalar(1 + (1 - state.intro) * 0.45);
    cam.copy(tgt).add(off);

    const calm = 1 - state.dof * 0.7;
    cam.x += par.x * calm;
    cam.y -= par.y * calm;

    camera.position.copy(cam);
    camera.lookAt(tgt);

    const hi = state.hl * 0.8;
    for (let i = 0; i < glow.head.length; i++) glow.head[i].emissiveIntensity = hi;
    const ti = state.tl * 0.8;
    for (let i = 0; i < glow.tail.length; i++) glow.tail[i].emissiveIntensity = ti;

    if (bokeh) {
      bokeh.uniforms.focus.value = cam.distanceTo(tgt);
      bokeh.uniforms.aperture.value = 0.025;
      bokeh.uniforms.maxblur.value = 0.007 * state.dof;
    }
  }

  function render() {
    if (finePointer) {
      const dx = par.tx - par.x;
      const dy = par.ty - par.y;
      if (Math.abs(dx) > 0.0004 || Math.abs(dy) > 0.0004) {
        par.x += dx * 0.06;
        par.y += dy * 0.06;
        dirty = true;
      }
    }
    if (!dirty) return;
    dirty = false;
    applyState();
    if (composer && state.dof > 0.01) composer.render();
    else renderer.render(scene, camera);
  }

  /* ----- Resize (canvas is 100lvh, so mobile toolbars don't cause churn) ----- */

  function resize(force) {
    const w = canvas.clientWidth || window.innerWidth;
    const h = canvas.clientHeight || window.innerHeight;
    if (!force && w === size.w && Math.abs(h - size.h) < 2) return;
    size.w = w;
    size.h = h;
    const pr = Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP);
    renderer.setPixelRatio(pr);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = camera.aspect < 1 ? 40 : 32;
    if (camera.aspect < 1) camera.setViewOffset(w, h, 0, Math.round(h * 0.1), w, h); // car sits above the text
    else camera.clearViewOffset();
    camera.updateProjectionMatrix();
    if (composer) {
      composer.setPixelRatio(pr);
      composer.setSize(w, h);
    }
    markDirty();
  }

  let resizeRaf = 0;
  const onResize = () => {
    cancelAnimationFrame(resizeRaf);
    resizeRaf = requestAnimationFrame(() => resize(false));
  };
  window.addEventListener('resize', onResize);
  window.addEventListener('orientationchange', onResize);
  resize(true);

  /* ----- Optional depth of field (desktop only, only visible in the cabin) ----- */

  if (!lowPower) {
    try {
      const [{ EffectComposer }, { RenderPass }, { BokehPass }, { OutputPass }] = await Promise.all([
        import('three/addons/postprocessing/EffectComposer.js'),
        import('three/addons/postprocessing/RenderPass.js'),
        import('three/addons/postprocessing/BokehPass.js'),
        import('three/addons/postprocessing/OutputPass.js')
      ]);
      const pr = Math.min(window.devicePixelRatio, PIXEL_RATIO_CAP);
      const target = new THREE.WebGLRenderTarget(size.w * pr, size.h * pr, {
        type: THREE.HalfFloatType,
        samples: 4
      });
      composer = new EffectComposer(renderer, target);
      composer.setPixelRatio(pr);
      composer.setSize(size.w, size.h);
      composer.addPass(new RenderPass(scene, camera));
      bokeh = new BokehPass(scene, camera, { focus: 2, aperture: 0.025, maxblur: 0 });
      // the depth pre-pass must not draw the gradient backdrop as if it were geometry
      const bokehRender = bokeh.render.bind(bokeh);
      bokeh.render = (...args) => {
        const bg = scene.background;
        scene.background = null;
        try { bokehRender(...args); } finally { scene.background = bg; }
      };
      composer.addPass(bokeh);
      composer.addPass(new OutputPass());
    } catch (err) {
      console.warn('Depth of field disabled:', err);
      composer = null;
      bokeh = null;
    }
  }

  /* ----- Warm-up: compile shaders and upload every texture behind the loader ----- */

  try {
    if (renderer.compileAsync) await renderer.compileAsync(scene, camera);
  } catch (err) { /* non-fatal */ }

  const culled = [];
  model.traverse((o) => {
    if (o.isMesh) { culled.push(o); o.frustumCulled = false; }
  });
  applyState();
  renderer.render(scene, camera);
  culled.forEach((o) => { o.frustumCulled = true; });

  /* ----- Master scroll timeline ----- */

  gsap.ticker.add(render);

  const master = gsap.timeline({
    defaults: { ease: 'sine.inOut' },
    scrollTrigger: {
      trigger: '#story',
      start: 'top top',
      end: 'bottom bottom',
      scrub: 1.1,
      invalidateOnRefresh: true
    },
    onUpdate: markDirty
  });

  for (let i = 1; i < kf.length; i++) {
    const { t, ...vars } = kf[i];
    master.to(state, { ...vars, duration: t - kf[i - 1].t }, kf[i - 1].t);
  }

  /* ----- Section text, counter, progress rail, scroll cue ----- */

  const sections = gsap.utils.toArray('.section');
  sections.forEach((sec, i) => {
    const panel = $('.panel', sec);
    const isFirst = i === 0;
    const isLast = i === sections.length - 1;
    const tl = gsap.timeline({
      scrollTrigger: {
        trigger: sec,
        start: isFirst ? 'top top' : 'top 85%',
        end: isLast ? 'top 30%' : 'bottom 15%',
        scrub: true
      }
    });
    if (!isFirst) tl.fromTo(panel, { autoAlpha: 0, y: 48 }, { autoAlpha: 1, y: 0, duration: 0.22, ease: 'power1.out' });
    if (!isLast) {
      tl.to({}, { duration: isFirst ? 0.45 : 0.56 });
      tl.to(panel, { autoAlpha: 0, y: -48, duration: 0.22, ease: 'power1.in' });
    }
  });

  const curEl = $('#count-cur');
  const railFill = $('#rail-fill');
  const cue = $('#cue');
  const portraitRail = window.matchMedia('(max-width: 900px)');
  let currentIndex = -1;

  ScrollTrigger.create({
    trigger: '#story',
    start: 'top top',
    end: 'bottom bottom',
    onUpdate(self) {
      const y = self.scroll();
      let idx = 0;
      const probe = y + window.innerHeight * 0.5;
      for (let i = 0; i < sections.length; i++) if (sections[i].offsetTop <= probe) idx = i;
      if (idx !== currentIndex) {
        currentIndex = idx;
        curEl.textContent = String(idx + 1).padStart(2, '0');
        gsap.fromTo(curEl, { yPercent: 70, opacity: 0 }, { yPercent: 0, opacity: 1, duration: 0.45, ease: 'power3.out', overwrite: true });
      }
      if (portraitRail.matches) gsap.set(railFill, { scaleX: self.progress, scaleY: 1 });
      else gsap.set(railFill, { scaleY: self.progress, scaleX: 1 });
      cue.classList.toggle('is-hidden', y > 30);
    }
  });

  /* ----- Desktop pointer parallax (tiny) ----- */

  if (finePointer) {
    window.addEventListener('pointermove', (e) => {
      par.tx = (e.clientX / window.innerWidth - 0.5) * 0.28;
      par.ty = (e.clientY / window.innerHeight - 0.5) * 0.14;
    }, { passive: true });
  }

  /* ----- Reveal ----- */

  setLoadProgress(1);
  await new Promise((r) => setTimeout(r, 650));

  document.documentElement.classList.remove('is-locked');
  document.body.classList.add('is-ready');
  ScrollTrigger.refresh();

  gsap.to(ui.loader, {
    opacity: 0,
    duration: 1,
    ease: 'power2.inOut',
    onComplete() { ui.loader.remove(); }
  });
  gsap.to(state, {
    intro: 1,
    duration: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0.01 : 2.8,
    ease: 'power3.out',
    onUpdate: markDirty
  });

  /* ----- Cleanup ----- */

  function disposeMaterial(m) {
    for (const key in m) {
      const v = m[key];
      if (v && v.isTexture) v.dispose();
    }
    m.dispose();
  }

  function dispose() {
    gsap.ticker.remove(render);
    ScrollTrigger.getAll().forEach((t) => t.kill());
    window.removeEventListener('resize', onResize);
    window.removeEventListener('orientationchange', onResize);
    scene.traverse((o) => {
      if (o.geometry) o.geometry.dispose();
      if (o.material) (Array.isArray(o.material) ? o.material : [o.material]).forEach(disposeMaterial);
    });
    envTexture.dispose();
    bgTexture.dispose();
    if (composer) composer.dispose();
    renderer.dispose();
  }

  window.addEventListener('pagehide', (e) => { if (!e.persisted) dispose(); });
}

/* ---------- Helpers ---------- */

function boxOfMaterials(root, pattern) {
  const box = new THREE.Box3();
  let found = false;
  root.traverse((o) => {
    if (!o.isMesh) return;
    const mats = Array.isArray(o.material) ? o.material : [o.material];
    if (mats.some((m) => m && pattern.test(m.name || ''))) {
      box.expandByObject(o);
      found = true;
    }
  });
  return found ? box : null;
}

function radialTexture(stops, px = 256) {
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(px / 2, px / 2, 0, px / 2, px / 2, px / 2);
  stops.forEach(([o, col]) => grad.addColorStop(o, col));
  g.fillStyle = grad;
  g.fillRect(0, 0, px, px);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function makeBackdropTexture() {
  const px = 512;
  const c = document.createElement('canvas');
  c.width = c.height = px;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(px * 0.5, px * 0.62, 0, px * 0.5, px * 0.62, px * 0.75);
  grad.addColorStop(0, '#1b1c21');
  grad.addColorStop(0.45, '#0b0b0e');
  grad.addColorStop(1, '#000000');
  g.fillStyle = grad;
  g.fillRect(0, 0, px, px);
  const img = g.getImageData(0, 0, px, px);
  for (let i = 0; i < img.data.length; i += 4) {
    const n = (Math.random() - 0.5) * 3;
    img.data[i] = clamp(img.data[i] + n, 0, 255);
    img.data[i + 1] = clamp(img.data[i + 1] + n, 0, 255);
    img.data[i + 2] = clamp(img.data[i + 2] + n, 0, 255);
  }
  g.putImageData(img, 0, 0);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

main().catch((err) => {
  console.error(err);
  fail(
    'Could not load the experience. Serve this folder from a local server ' +
    '(for example: npx serve) and make sure nissan_skyline_gtr_r35.glb sits next to index.html.'
  );
});
