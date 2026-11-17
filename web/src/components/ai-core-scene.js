/**
 * The 3D AI core: a glowing wireframe core with an inner light, orbiting rings and a shell of particles. It is loaded on demand
 * (AiCore.jsx imports this file only when WebGL and motion are available), so `three` stays out of the main bundle.
 *
 * The scene shows a state the portal really is in (idle, running, success, failed): the state changes the colour, spin speed,
 * breathing and ring speed, eased over about half a second. It stops drawing while the tab is hidden or the core is off screen,
 * and draws one still frame when motion is off.
 */
import {
  WebGLRenderer, Scene, PerspectiveCamera, Group, Mesh, IcosahedronGeometry, SphereGeometry, TorusGeometry,
  MeshBasicMaterial, Color, BufferGeometry, Float32BufferAttribute, Points, PointsMaterial, AdditiveBlending,
} from 'three';

/** What each state looks like. `tone` is the theme colour variable that tints it. */
export const CORE_STATES = {
  idle:    { spin: 0.18, breathe: 0.03, rate: 0.9, ring: 0.25, orbit: 0.08, glow: 0.4,  tone: '--accent' },
  running: { spin: 1.1,  breathe: 0.07, rate: 3.2, ring: 1.6,  orbit: 0.55, glow: 0.95, tone: '--info' },
  success: { spin: 0.35, breathe: 0.05, rate: 1.4, ring: 0.5,  orbit: 0.15, glow: 0.8,  tone: '--ok' },
  failed:  { spin: 0.08, breathe: 0.09, rate: 5,   ring: 0.1,  orbit: 0.04, glow: 0.7,  tone: '--danger' },
};
const FALLBACK_TONE = { '--accent': '#60a5fa', '--info': '#22d3ee', '--ok': '#34d399', '--danger': '#f87171' };

let probe = null;
/** Any CSS colour (a variable's value, color-mix(), oklch()…) as a three Color, resolved by the browser itself. */
function resolveColor(host, varName) {
  try {
    const raw = getComputedStyle(host).getPropertyValue(varName).trim();
    if (!raw) return new Color(FALLBACK_TONE[varName]);
    probe ??= document.createElement('canvas');
    probe.width = probe.height = 1;
    const ctx = probe.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = '#000';
    ctx.fillStyle = raw;
    ctx.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
    if (!a) return new Color(FALLBACK_TONE[varName]);
    return new Color(r / 255, g / 255, b / 255);
  } catch { return new Color(FALLBACK_TONE[varName]); }
}

/**
 * @param {HTMLCanvasElement} canvas
 * @param {HTMLElement} host   the element that sizes the canvas and carries the theme variables
 * @param {{ state?: keyof typeof CORE_STATES, animated?: boolean }} opts
 */
export function createCore(canvas, host, opts = {}) {
  const renderer = new WebGLRenderer({ canvas, alpha: true, antialias: true, powerPreference: 'low-power' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  const scene = new Scene();
  const camera = new PerspectiveCamera(40, 1, 0.1, 50);
  camera.position.z = 5.2;

  const color = new Color('#60a5fa');
  const wire = new MeshBasicMaterial({ color, wireframe: true, transparent: true, opacity: 0.85 });
  const inner = new MeshBasicMaterial({ color, transparent: true, opacity: 0.5 });
  const ringMat = new MeshBasicMaterial({ color, transparent: true, opacity: 0.7 });
  const dust = new PointsMaterial({ color, size: 0.035, transparent: true, opacity: 0.85, blending: AdditiveBlending, depthWrite: false });

  const group = new Group();
  const shell = new Mesh(new IcosahedronGeometry(1.15, 1), wire);
  const core = new Mesh(new SphereGeometry(0.62, 32, 24), inner);
  const rings = [0, 1, 2].map((i) => {
    const ring = new Mesh(new TorusGeometry(1.65 + i * 0.28, 0.014, 8, 128), ringMat);
    ring.rotation.set(Math.PI / 2 + i * 0.7, i * 0.9, i * 0.4);
    return ring;
  });
  const N = 160;
  const pos = new Float32Array(N * 3);
  for (let i = 0; i < N; i++) {
    const r = 2.2 + Math.random() * 0.9;
    const th = Math.random() * Math.PI * 2;
    const ph = Math.acos(2 * Math.random() - 1);
    pos[i * 3] = r * Math.sin(ph) * Math.cos(th);
    pos[i * 3 + 1] = r * Math.sin(ph) * Math.sin(th);
    pos[i * 3 + 2] = r * Math.cos(ph);
  }
  const dustGeo = new BufferGeometry();
  dustGeo.setAttribute('position', new Float32BufferAttribute(pos, 3));
  const points = new Points(dustGeo, dust);
  group.add(shell, core, ...rings, points);
  scene.add(group);

  let target = CORE_STATES[opts.state] ?? CORE_STATES.idle;
  let targetColor = resolveColor(host, target.tone);
  const cur = { ...target };
  let animated = opts.animated !== false;
  let hidden = document.hidden;
  let offscreen = false;
  let raf = 0;
  let last = performance.now();
  let t = 0;
  let disposed = false;

  const resize = () => {
    const w = Math.max(1, host.clientWidth);
    const h = Math.max(1, host.clientHeight);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  };

  const draw = (dt) => {
    // Ease every number toward the state it should show.
    const k = Math.min(1, dt * 4);
    for (const key of ['spin', 'breathe', 'rate', 'ring', 'orbit', 'glow']) cur[key] += (target[key] - cur[key]) * k;
    color.lerp(targetColor, k);
    t += dt;
    const pulse = 1 + Math.sin(t * cur.rate) * cur.breathe;
    group.scale.setScalar(pulse);
    shell.rotation.y += dt * cur.spin;
    shell.rotation.x += dt * cur.spin * 0.45;
    core.scale.setScalar(0.92 + Math.sin(t * cur.rate * 1.3) * 0.08);
    rings.forEach((r, i) => { r.rotation.z += dt * cur.ring * (i % 2 ? -1 : 1) * (0.6 + i * 0.3); });
    points.rotation.y += dt * cur.orbit;
    points.rotation.x += dt * cur.orbit * 0.3;
    inner.opacity = 0.25 + cur.glow * 0.45;
    wire.opacity = 0.5 + cur.glow * 0.4;
    ringMat.opacity = 0.3 + cur.glow * 0.45;
    renderer.render(scene, camera);
  };

  const loop = (now) => {
    raf = 0;
    if (disposed) return;
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    draw(dt);
    schedule();
  };
  const schedule = () => {
    if (raf || disposed || !animated || hidden || offscreen) return;
    last = performance.now();
    raf = requestAnimationFrame(loop);
  };
  const still = () => { if (!disposed) { cur.glow = target.glow; color.copy(targetColor); draw(0); } };

  const onVisibility = () => { hidden = document.hidden; if (hidden) { cancelAnimationFrame(raf); raf = 0; } else schedule(); };
  document.addEventListener('visibilitychange', onVisibility);
  const ro = new ResizeObserver(() => { resize(); if (!animated) still(); });
  ro.observe(host);
  const io = typeof IntersectionObserver === 'function'
    ? new IntersectionObserver((entries) => {
      offscreen = !entries[entries.length - 1].isIntersecting;
      if (offscreen) { cancelAnimationFrame(raf); raf = 0; } else schedule();
    })
    : null;
  io?.observe(host);

  resize();
  if (animated) schedule(); else still();

  return {
    setState(name) {
      target = CORE_STATES[name] ?? CORE_STATES.idle;
      targetColor = resolveColor(host, target.tone);
      if (!animated) still();
    },
    setAnimated(on) {
      animated = Boolean(on);
      if (animated) schedule(); else { cancelAnimationFrame(raf); raf = 0; still(); }
    },
    dispose() {
      disposed = true;
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
      ro.disconnect();
      io?.disconnect();
      for (const o of [shell, core, ...rings, points]) o.geometry.dispose();
      for (const m of [wire, inner, ringMat, dust]) m.dispose();
      renderer.dispose();
    },
  };
}
