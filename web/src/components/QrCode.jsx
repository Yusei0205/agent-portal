/**
 * A QR code for a short text (the authenticator setup link). Drawn as SVG from the code's modules, on a white square with a
 * 4-module quiet zone and black modules whatever the theme: scanners need dark on light.
 */
import { useEffect, useState } from 'react';

/** @param {{ text: string, size?: number, label?: string }} props */
export function QrCode({ text, size = 192, label = 'QR code' }) {
  const [shape, setShape] = useState(/** @type {null | { n: number, d: string }} */ (null));

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const qrcode = (await import('qrcode-generator')).default;
        const qr = qrcode(0, 'M');
        qr.addData(text);
        qr.make();
        const n = qr.getModuleCount();
        let d = '';
        for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
        if (!cancelled) setShape({ n, d });
      } catch {
        if (!cancelled) setShape(null);
      }
    })();
    return () => { cancelled = true; };
  }, [text]);

  if (!shape) return null;
  const view = shape.n + 8;
  return (
    <svg role="img" aria-label={label} width={size} height={size} viewBox={`0 0 ${view} ${view}`} shapeRendering="crispEdges" style={{ background: '#fff', borderRadius: 8, maxWidth: '100%' }}>
      <rect width={view} height={view} fill="#fff" />
      <path d={shape.d} fill="#000" />
    </svg>
  );
}
