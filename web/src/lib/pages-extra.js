/**
 * Extra command-palette page entries for Credentials and Configuration.
 * Import this and merge into CommandPalette's nav items to register the pages.
 *
 * Note: branch scans and tests are now nested inside the Reviews and Work
 * sections respectively. They are reachable via the Reviews tab or the
 * project navigation — no separate top-level palette entry is needed.
 */
export const EXTRA_NAV_ITEMS = [
  {
    id: 'goto_credentials',
    label: 'Credentials',
    description: 'Manage your engine sign-ins (Kiro, Claude Code)',
    keys: 'g y',
    href: '#/credentials',
  },
  {
    id: 'goto_config',
    label: 'Configuration',
    description: 'Edit ~/.kiro, ~/.claude and ~/.aws per-user config',
    keys: 'g x',
    href: '#/config',
  },
];
