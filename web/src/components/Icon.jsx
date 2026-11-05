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

  // Distinct nav icons (one per nav item, no duplicates)
  // Sessions — terminal prompt box
  // (uses existing 'terminal' entry below)
  // Tests — flask / beaker
  flask:            'M8 4h8M9 4v5L5 18h14L15 9V4',
  // Code review — git pull-request (two circles + merge arrow)
  'git-pull-request': 'M6 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM18 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 9v8M18 9c0 3.5-4.5 5.5-12 5.5',
  // Branch scans — scan-frame with target circle
  radar:            'M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2M12 12a3 3 0 1 0 0-6 3 3 0 0 0 0 6',
  // Create — sparkles / magic wand star
  sparkles:         'M12 3l2 5.8 5.8 1.9-5.8 1.9-2 5.8-2-5.8-5.8-1.9 5.8-1.9 2-5.8ZM20 2l.8 2.2 2.2.8-2.2.8L20 8l-.8-2.2-2.2-.8 2.2-.8L20 2Z',
  // Vault — archive box
  archive:          'M21 8H3V6a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2ZM3 8v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8M10 12h4',
  // Integrations — plug / connector
  plug:             'M12 22v-5M9 8V2M15 8V2M8 8h8a4 4 0 0 1 4 4v1a4 4 0 0 1-4 4H8a4 4 0 0 1-4-4v-1a4 4 0 0 1 4-4Z',
  // AWS accounts — cloud
  cloud:            'M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z',
  // Review dashboard — layout-dashboard (4-panel grid)
  'layout-dashboard': 'M3 3h7v9H3zM14 3h7v5h-7zM14 10h7v8h-7zM3 14h7v7H3z',
  // Credentials — key
  key:              'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.78 7.78 5.5 5.5 0 0 1 7.77-7.77m0 0L15.5 7.5m0 0 3 3L22 7l-3-3m-3.5 3.5L19 4',
  // Configuration — file with code chevrons inside
  'file-cog':       'M14 3H6v18h12V7l-4-4Zm0 0v4h4M9 12l2 3-2 3m6-6 2 3-2 3',
  // API access — terminal prompt (>_)
  'code-2':         'M4 17l6-6-6-6M20 17H8',
  // Setup — sliders (horizontal with handles)
  sliders:          'M4 6h16M4 12h16M4 18h16M14 4v4M8 10v4M11 16v4',
  // Admin — shield with user silhouette
  'shield-user':    'M12 2L4 5v6c0 5 3 9.7 8 11 5-1.3 8-6 8-11V5l-8-3ZM12 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm-3.5 7a3.5 3.5 0 0 1 7 0',

  // Actions
  edit:         'M4 20h4L19 9l-4-4L4 16v4Zm9-13 4 4',
  trash:        'M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3',
  plus:         'M12 5v14M5 12h14',
  check:        'M5 12.5 10 17l9-10',
  x:            'M6 6l12 12M18 6 6 18',
  chevronRight: 'M9 6l6 6-6 6',
  chevronLeft:  'M15 6l-6 6 6 6',
  chevronDown:  'M6 9l6 6 6-6',
  chevronUp:    'M6 15l6-6 6 6',
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
  help:         'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01',

  // Misc
  menu:         'M4 6h16M4 12h16M4 18h16',
  logout:       'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  file:         'M14 3H6v18h12V7l-4-4Zm0 0v4h4',
  external:     'M14 4h6v6M20 4l-9 9M18 14v6H4V6h6',
  eye:          'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Zm10 3a3 3 0 1 0 0-6 3 3 0 0 0 0 6Z',
  copy:         'M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V6a2 2 0 0 0-2-2h-2M8 4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2M8 4h8',
  stop:         'M6 6h12v12H6z',

  // Portal group — 2×2 grid (reads as "apps" not "locked")
  portal:       'M3 3h8v8H3zM13 3h8v8h-8zM3 13h8v8H3zM13 13h8v8h-8z',

  // Theme icons (light / dark / system)
  sun:          'M12 1v2M12 21v2M4.22 4.22l1.42 1.42M18.36 18.36l1.42 1.42M1 12h2M21 12h2M4.22 19.78l1.42-1.42M18.36 5.64l1.42-1.42M12 7a5 5 0 1 0 0 10A5 5 0 0 0 12 7Z',
  moon:         'M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79Z',
  monitor:      'M3 4h18a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM8 20h8M12 16v4',

  // IDE / workspace icons
  explorer:     'M3 5a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Z',
  'source-control': 'M6 3v9M18 9a3 3 0 1 0 0 .01M6 12a3 3 0 1 0 0 .01M18 6a3 3 0 1 0 0 .01M18 9c0 3-4.5 4.5-9 5',
  terminal:     'M4 4h16a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1ZM8 9l3 3-3 3m5 0h3',
  browser:      'M3 5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5Zm0 5h18',
  agents:       'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7 1 2 2 4-4',
  'more-horiz': 'M5 12a1 1 0 1 0 0 .01M12 12a1 1 0 1 0 0 .01M19 12a1 1 0 1 0 0 .01',
  rename:       'M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5Z',
  'git-diff':   'M12 20V4M5 7l-3 3 3 3M19 7l3 3-3 3',
  'git-branch': 'M6 3v12M6 15a3 3 0 1 0 0 .01M18 6a3 3 0 1 0 0 .01M18 9c0 4-6 4-9 6',
  clock:        'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 6v6l4 2',
  'file-plus':  'M14 3H6v18h12V7l-4-4Zm0 0v4h4M9 12h6M12 9v6',
  'folder-plus': 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7ZM12 11v6M9 14h6',
  'zip-download': 'M12 18v-6M12 18l-3-3m3 3 3-3M5 8H3M5 8a2 2 0 0 1-2-2V5h18v1a2 2 0 0 1-2 2H5ZM3 8v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8',
  slash:        'M6 4h12M6 20h12M16 4 8 20',
  'idle-stop':  'M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20ZM12 8v4M12 16h.01',

  // Jira ticket stub (rounded rect with notch on each side)
  ticket:       'M3 7a1 1 0 0 1 1-1h16a1 1 0 0 1 1 1v3a2 2 0 0 0 0 4v3a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1v-3a2 2 0 0 0 0-4V7Z',
};

/**
 * SVG icon component.
 * @param {{ name: string, size?: number, className?: string, title?: string, style?: object }} props
 */
export function Icon({ name, size = 18, className, title, style }) {
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
      style={style}
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
    >
      {title ? <title>{title}</title> : null}
      <path d={d} />
    </svg>
  );
}
