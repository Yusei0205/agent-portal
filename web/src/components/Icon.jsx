// SVG icon registry — 24×24 viewBox, stroke-based icons.
const PATHS = {
  // Navigation
  play:         'M7 4v16l13-8L7 4Z',
  projects:     'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z',
  inbox:        'M3 13h5l1.5 3h5L16 13h5M5 5h14l2 8v6H3v-6l2-8Z',
  review:       'M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3Zm-3 9 2 2 4-4',
  knowledge:    'M4 5.5A2.5 2.5 0 0 1 6.5 3H20v15H6.5A2.5 2.5 0 0 0 4 20.5v-15ZM4 20.5A2.5 2.5 0 0 0 6.5 23H20v-5M8 7h8M8 11h6',
  builder:      'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM16.5 13v7M13 16.5h7',
  chart:        'M3 3v18h18M7 16l4-4 4 4 4-4M3 8l4 4',
  settings:     'M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.4 7.4 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a7.4 7.4 0 0 0-2.2-1.3L14.3 3h-4l-.4 2.4A7.4 7.4 0 0 0 7.7 6.7l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a7.4 7.4 0 0 0 2.2 1.3l.4 2.4h4l.4-2.4a7.4 7.4 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.1-.4.1-.9.1-1.3Z',
  lock:         'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  branch:       'M6 3v12M6 15a3 3 0 1 0 0 .01M18 6a3 3 0 1 0 0 .01M18 9c0 4-6 4-9 6',
  user:         'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm-8 9a8 8 0 0 1 16 0',

  // Actions
  edit:         'M4 20h4L19 9l-4-4L4 16v4Zm9-13 4 4',
  trash:        'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  plus:         'M12 5v14M5 12h14',
  check:        'M5 12.5 10 17l9-10',
  x:            'M6 6l12 12M18 6 6 18',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft:  'M15 6l-6 6 6 6',
  chevronDown:  'M6 9l6 6 6-6',
  // Hyphenated aliases for spec compliance
  'chevron-right': 'M9 6l6 6-6 6',
  'chevron-left':  'M15 6l-6 6 6 6',
  'chevron-down':  'M6 9l6 6 6-6',
  search:       'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm9 3-4.3-4.3',
  filter:       'M4 6h16M7 12h10M10 18h4',
  download:     'M12 4v12m0 0-4-4m4 4 4-4M4 18v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1',
  upload:       'M12 16V4m0 0-4 4m4-4 4 4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3',
  refresh:      'M20 11a8 8 0 0 0-14.9-3M4 4v4h4M4 13a8 8 0 0 0 14.9 3M20 20v-4h-4',
  send:         'M22 2L11 13M22 2l-7 20-4-9-9-4 20-7Z',
  attach:       'M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66L9.41 17.22a2 2 0 0 1-2.83-2.83l8.49-8.49',
  warning:      'M10.3 3.9 2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0ZM12 9v4M12 17h.01',
  info:         'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 11v5M12 8h.01',

  // Misc
  menu:         'M4 6h16M4 12h16M4 18h16',
  logout:       'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  file:         'M14 3H6v18h12V7l-4-4Zm0 0v4h4',
  external:     'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  eye:          'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  copy:         'M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2M8 4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2M8 4h8',
  stop:         'M6 6h12v12H6z',
};

/**
 * SVG icon component.
 * @param {{ name: string, size?: number, className?: string, title?: string }} props
 */
export function Icon({ name, size = 18, className, title }) {
  const d = PATHS[name] || PATHS.file;
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      <path d={d} />
    </svg>
  );
}
