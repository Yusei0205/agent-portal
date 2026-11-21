import { useEffect, useRef, useState } from 'react';

const seen = new Set();
/** Reveal a newly-created version once in this browser tab, including across page remounts. */
export function useArtifactReveal(id, ready, createdAt) {
  const [fresh, setFresh] = useState(false);
  const claimed = useRef(null);
  useEffect(() => {
    setFresh(false);
    if (!ready || !id) return;
    const age = Date.now() - Date.parse(createdAt || '');
    if (!Number.isFinite(age) || age < 0 || age >= 120_000) return;
    const key = `portal:artifact-reveals`;
    let stored = [];
    try { stored = JSON.parse(sessionStorage.getItem(key)) || []; } catch { /* Memory fallback. */ }
    if (!Array.isArray(stored)) stored = [];
    if ((seen.has(id) || stored.includes(id)) && claimed.current !== id) return;
    claimed.current = id;
    seen.add(id);
    try { sessionStorage.setItem(key, JSON.stringify([...stored.slice(-199), id])); } catch { /* Memory fallback. */ }
    setFresh(true);
    const timer = setTimeout(() => setFresh(false), 1800);
    return () => clearTimeout(timer);
  }, [id, ready, createdAt]);
  return fresh;
}
