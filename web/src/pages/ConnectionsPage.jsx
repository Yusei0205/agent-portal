/**
 * Connections page — the portal's Git connections.
 *
 * URL:  #/connections/git   (old URL #/connections redirects here, handled in App.jsx)
 */

import { Connections as GitConnections } from './Connections.jsx';

export function ConnectionsPage({ user }) {
  return <GitConnections user={user} />;
}
