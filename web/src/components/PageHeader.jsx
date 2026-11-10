/**
 * The one page header every page uses: title (h1) and a one-line description on the
 * left, the page's main actions on the right.
 *
 *   <PageHeader title="Workspaces" description="Group repositories…">
 *     <button className="btn btn-primary">New workspace</button>
 *   </PageHeader>
 *
 * SectionHead is the smaller version for a tab inside a page (the tab already names it):
 * a description on the left and that tab's actions on the right.
 */

import { createContext, useContext } from 'react';

/** True inside a hub tab (Connect): the tab already names the page, so the h1 is left out. */
export const HubContext = createContext(false);

export function PageHeader({ title, description, children }) {
  const inHub = useContext(HubContext);
  if (inHub) {
    if (!description && !children) return null;
    return (
      <div className="section-head">
        <p className="muted">{description}</p>
        {children && <div className="page-actions">{children}</div>}
      </div>
    );
  }
  return (
    <div className="page-head">
      <div className="page-head-text">
        <h1>{title}</h1>
        {description && <p className="muted">{description}</p>}
      </div>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

export function SectionHead({ description, children }) {
  return (
    <div className="section-head">
      <p className="muted">{description}</p>
      {children && <div className="page-actions">{children}</div>}
    </div>
  );
}

export default PageHeader;
