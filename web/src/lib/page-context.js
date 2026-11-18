import { useEffect, useLayoutEffect, useState } from 'react';

function read(key, fallback) {
  try { return JSON.parse(sessionStorage.getItem(`portal:page:${key}`)) ?? fallback; } catch { return fallback; }
}
function write(key, value) {
  try { sessionStorage.setItem(`portal:page:${key}`, JSON.stringify(value)); } catch { /* Storage is optional. */ }
}

/** Small, tab-local preferences. Call from a component keyed by its page/project. */
export function usePageState(key, fallback, validate = () => true) {
  const [value, setValue] = useState(() => {
    const saved = read(key, fallback);
    return validate(saved) ? saved : fallback;
  });
  useEffect(() => { write(key, value); }, [key, value]);
  return [value, setValue];
}

/** Restore the scrollable main area after its async content has loaded, without keeping pages running in the background. */
export function usePageScroll(key, ref) {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const positions = read('scroll', {});
    const wanted = Number(positions[key]) || 0;
    let observer;
    let timer;
    let frame;
    let lastTop = wanted;
    const capture = () => { lastTop = element.scrollTop; };
    const stop = () => { observer?.disconnect(); clearTimeout(timer); cancelAnimationFrame(frame); };
    const restore = () => {
      element.scrollTop = wanted;
      // Keep observing while independent panels finish loading: an initially
      // restored position can shift again when a skeleton or status strip shrinks.
    };
    element.focus({ preventScroll: true });
    element.scrollTop = 0;
    if (wanted > 0) {
      observer = new ResizeObserver(() => { frame = requestAnimationFrame(restore); });
      if (element.firstElementChild) observer.observe(element.firstElementChild);
      timer = setTimeout(stop, 5000);
      frame = requestAnimationFrame(restore);
    }
    // User input takes precedence over a pending restoration.
    const events = ['wheel', 'touchstart', 'pointerdown', 'keydown'];
    events.forEach((event) => element.addEventListener(event, stop, { passive: true }));
    element.addEventListener('scroll', capture, { passive: true });
    return () => {
      stop();
      events.forEach((event) => element.removeEventListener(event, stop));
      element.removeEventListener('scroll', capture);
      const latest = read('scroll', {});
      delete latest[key];
      const bounded = Object.fromEntries(Object.entries(latest).slice(-39));
      // React may already have detached the keyed main node; its scrollTop then reads as zero.
      write('scroll', { ...bounded, [key]: lastTop });
    };
  }, [key, ref]);
}
