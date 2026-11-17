// The hero object: a polished chrome ibex on a stepped rise, cut into horizontal slats by the live plan.
// Vertical axis of the sculpture = the agent's price range (bottom = range low, top = range high).
// One slat per bin (at least 12, so it reads as slats; fewer bins are resampled), slat thickness = that bin's
// liquidity weight, warm edges on every slat, and the slat at the live price glows sodium yellow.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

const MAX = 48;
const MIN_SLATS = 18;
const HEIGHT = 4.2;
// the data axis: from the top of the rock rise to the horn tips (the base below it is neutral slats, cropped off-frame)
const Y0 = -1.75;
const Y1 = 2.1;
const ROT = 1.95; // three-quarter view, head towards the price staff

export function createScene(host, ruler, { poster = false } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, preserveDrawingBuffer: poster, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.15;
  host.prepend(renderer.domElement);
  renderer.domElement.setAttribute('aria-hidden', 'true');

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
  scene.environment = env;
  // a warm key from the side so slat edges catch light
  const key = new THREE.DirectionalLight(0xffe2a0, 1.2);
  key.position.set(4, 6, 3);
  scene.add(key, new THREE.AmbientLight(0xffffff, 0.15));

  const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 100);
  // desktop: object right of the hero column, seen slightly from below, base cropped by the bottom edge.
  // poster (phones): tighter, cropped on the right and bottom.
  const base = poster ? new THREE.Vector3(0.9, 0.2, 7.4) : new THREE.Vector3(0.9, -0.7, 10.4);
  const target = poster ? new THREE.Vector3(-1.75, 1.15, 0) : new THREE.Vector3(-1.8, 0.55, 0);

  const uniforms = {
    uN: { value: MIN_SLATS },
    uFill: { value: new Array(MAX).fill(0.6) },
    uLive: { value: -1 },
    uY0: { value: Y0 },
    uY1: { value: Y1 },
    uBob: { value: 0 },
  };
  const target_fill = new Array(MAX).fill(0.6);

  // the model keeps its own PBR textures (Tripo base colour + ORM); this only adds the data slicing + glow
  const slice = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vSy;\nvarying vec3 vWN;\nvarying vec3 vWP;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvec4 sw = modelMatrix * vec4(transformed, 1.0);\nvSy = sw.y;\nvWP = sw.xyz;\nvWN = normalize(mat3(modelMatrix) * objectNormal);');
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying float vSy; varying vec3 vWN; varying vec3 vWP;
uniform float uN; uniform float uFill[${MAX}]; uniform float uLive; uniform float uY0; uniform float uY1; uniform float uBob;`,
      )
      .replace(
        'void main() {',
        `void main() {
  float st = min((vSy - uBob - uY0) / (uY1 - uY0), 0.99999);
  float fs = st * uN;
  float idx = floor(fs);
  float fr = fract(fs);
  float fill = idx < 0.0 ? 0.72 : uFill[int(idx)];
  if (fr > fill) discard;
  float edge = smoothstep(fill - 0.07, fill, fr) + (1.0 - smoothstep(0.0, 0.06, fr));
  float live = 1.0 - step(0.5, abs(idx - uLive));`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
  vec3 warm = vec3(1.0, 0.81, 0.25);
  vec3 V = normalize(cameraPosition - vWP);
  float fres = pow(1.0 - abs(dot(normalize(vWN), V)), 3.0);
  gl_FragColor.rgb += vec3(1.0, 0.95, 0.85) * fres * 0.22;
  // the model's own sodium-yellow strips glow (yellow in the base colour)
  float yel = smoothstep(0.12, 0.35, diffuseColor.r - diffuseColor.b) * smoothstep(0.3, 0.5, diffuseColor.g);
  gl_FragColor.rgb += warm * yel * 1.4;
  gl_FragColor.rgb += warm * edge * (0.18 + 1.4 * live);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, warm * (0.55 + 0.6 * gl_FragColor.g), live * 0.6);
  if (!gl_FrontFacing) gl_FragColor.rgb *= 0.28;`,
      );
  };

  const holder = new THREE.Group();
  scene.add(holder);
  let model = null;
  let vm = null;
  let ready = false;

  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const loaded = new Promise((resolve, reject) => {
    loader.load(
      '/models/ibex-cyber.glb',
      (g) => {
        model = g.scene;
        model.traverse((o) => {
          if (!o.isMesh) return;
          const m = o.material;
          m.side = THREE.DoubleSide;
          m.envMapIntensity = 1.15;
          m.onBeforeCompile = slice;
          m.needsUpdate = true;
        });
        const box = new THREE.Box3().setFromObject(model);
        const size = box.getSize(new THREE.Vector3());
        const s = HEIGHT / size.y;
        model.scale.setScalar(s);
        box.setFromObject(model);
        const c = box.getCenter(new THREE.Vector3());
        model.position.sub(c);
        holder.add(model);
        ready = true;
        if (vm) update(vm);
        kick();
        resolve();
      },
      undefined,
      reject,
    );
  });

  /** slats from the plan */
  function update(next) {
    vm = next;
    const nb = vm.bins.length;
    const n = Math.min(MAX, Math.max(MIN_SLATS, nb));
    uniforms.uN.value = n;
    const maxW = Math.max(...vm.bins.map((b) => b.weight), 1e-12);
    for (let i = 0; i < MAX; i++) {
      if (i >= n || !nb) { target_fill[i] = 0.6; continue; }
      const b = vm.bins[Math.min(nb - 1, Math.floor((i * nb) / n))];
      target_fill[i] = 0.6 + 0.34 * (b.weight / maxW);
    }
    // the slat nearest the live price, with the range mapped bottom→top
    const l0 = Math.log(vm.range[0]), l1 = Math.log(vm.range[1]);
    const t = (Math.log(vm.price) - l0) / (l1 - l0 || 1);
    uniforms.uLive.value = t >= 0 && t <= 1 ? Math.min(n - 1, Math.floor(t * n)) : t < 0 ? 0 : n - 1;
    liveOutside = t < 0 || t > 1;
    kick();
    return { n, live: uniforms.uLive.value, outside: liveOutside ? (t < 0 ? 'below' : 'above') : null };
  }
  let liveOutside = false;

  const ptr = { x: 0, y: 0, tx: 0, ty: 0 };
  const onPointer = (e) => {
    const r = host.getBoundingClientRect();
    ptr.tx = ((e.clientX - r.left) / r.width - 0.5) * 2;
    ptr.ty = ((e.clientY - r.top) / r.height - 0.5) * 2;
  };
  if (!poster) window.addEventListener('pointermove', onPointer, { passive: true });

  function resize() {
    const r = host.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.fov = w / h < 0.9 ? 36 : 30;
    camera.updateProjectionMatrix();
    kick();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(host);

  const v = new THREE.Vector3();
  /** keep the HTML ruler aligned with the data axis (screen y of Y1 → Y0) */
  function placeRuler() {
    if (!ruler) return;
    const c = renderer.domElement;
    v.set(0, Y1 + holder.position.y, 0).project(camera);
    const top = (-v.y * 0.5 + 0.5) * c.clientHeight;
    v.set(0, Y0 + holder.position.y, 0).project(camera);
    const bot = (-v.y * 0.5 + 0.5) * c.clientHeight;
    ruler.style.top = top.toFixed(1) + 'px';
    ruler.style.height = Math.max(10, bot - top).toFixed(1) + 'px';
  }

  let raf = 0;
  let visible = true;
  const clock = new THREE.Clock();
  function kick() { if (!raf && visible) raf = requestAnimationFrame(frame); }
  function frame() {
    raf = 0;
    const dt = Math.min(clock.getDelta(), 0.05);
    const time = clock.elapsedTime;
    const f = uniforms.uFill.value;
    for (let i = 0; i < MAX; i++) f[i] += (target_fill[i] - f[i]) * Math.min(1, dt * 4);
    if (!poster) {
      holder.rotation.y = Math.sin(time * 0.16) * 0.35 + ROT;
      holder.position.y = Math.sin(time * 0.6) * 0.06;
    } else {
      holder.rotation.y = ROT;
    }
    uniforms.uBob.value = holder.position.y;
    ptr.x += (ptr.tx - ptr.x) * 0.05;
    ptr.y += (ptr.ty - ptr.y) * 0.05;
    camera.position.set(base.x + ptr.x * 0.6, base.y - ptr.y * 0.35, base.z);
    camera.lookAt(target);
    renderer.render(scene, camera);
    if (ready) placeRuler();
    if (!poster) raf = requestAnimationFrame(frame);
  }

  const io = new IntersectionObserver(([en]) => {
    visible = en.isIntersecting;
    if (visible) { clock.getDelta(); kick(); } else if (raf) { cancelAnimationFrame(raf); raf = 0; }
  });
  io.observe(host);
  resize();

  return {
    update,
    loaded,
    renderOnce: () => frame(),
    canvas: renderer.domElement,
    dispose() {
      cancelAnimationFrame(raf);
      ro.disconnect();
      io.disconnect();
      window.removeEventListener('pointermove', onPointer);
      renderer.dispose();
      renderer.domElement.remove();
    },
  };
}
