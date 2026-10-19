import { Fragment, useState } from 'react';
import { cx } from '../lib/util.js';
import { Icon } from './Icon.jsx';
import { Badge } from './ui.jsx';

/**
 * Renders parsed diff files. `findings` are shown under the line they point to;
 * file-level findings (no line) sit at the top of the file.
 */
export function DiffView({ files, findings = [], renderFinding, focusFile, collapsedByDefault }) {
  return (
    <div className="diff">
      {files.map((f) => (
        <DiffFile
          key={f.newPath + f.oldPath}
          file={f}
          findings={findings.filter((x) => x.file === f.newPath)}
          renderFinding={renderFinding}
          focus={focusFile === f.newPath}
          collapsed={collapsedByDefault && focusFile !== f.newPath}
        />
      ))}
    </div>
  );
}

function DiffFile({ file, findings, renderFinding, focus, collapsed }) {
  const [open, setOpen] = useState(!collapsed);
  const byLine = new Map();
  for (const fd of findings) {
    if (!fd.line) continue;
    const list = byLine.get(fd.line) || [];
    list.push(fd);
    byLine.set(fd.line, list);
  }
  const shown = new Set(file.hunks.flatMap((h) => h.lines.map((l) => l.newLine)).filter(Boolean));
  const fileLevel = findings.filter((x) => !x.line || !shown.has(x.line));
  return (
    <section className={cx('diff-file', focus && 'is-focus')} id={`file-${file.newPath}`}>
      <button type="button" className="diff-file-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? 'chevronDown' : 'chevronRight'} size={15} />
        <span className="diff-path">{file.newPath}</span>
        {file.status !== 'modified' ? <Badge tone="muted">{file.status}</Badge> : null}
        <span className="diff-stat">
          <span className="add">+{file.additions}</span> <span className="del">−{file.deletions}</span>
        </span>
        {findings.length ? <Badge tone={findings.some((x) => ['critical', 'high'].includes(x.severity)) ? 'danger' : 'warn'}>{findings.length}</Badge> : null}
      </button>
      {open ? (
        <div className="diff-body">
          {fileLevel.map((fd) => (
            <div key={fd.id || fd.message} className="diff-note">
              {renderFinding ? renderFinding(fd) : fd.message}
            </div>
          ))}
          {file.binary ? <p className="muted pad">Binary file not shown.</p> : null}
          <table className="diff-table">
            <tbody>
              {file.hunks.map((h, hi) => (
                <Fragment key={hi}>
                  <tr className="diff-hunk">
                    <td colSpan={3}>{h.header}</td>
                  </tr>
                  {h.lines.map((l, li) => (
                    <Fragment key={li}>
                      <tr className={cx('diff-line', `diff-${l.type}`)}>
                        <td className="ln">{l.oldLine ?? ''}</td>
                        <td className="ln">{l.newLine ?? ''}</td>
                        <td className="code">
                          <span className="sign">{l.type === 'add' ? '+' : l.type === 'del' ? '−' : ' '}</span>
                          {l.text}
                        </td>
                      </tr>
                      {l.newLine && byLine.has(l.newLine)
                        ? byLine.get(l.newLine).map((fd) => (
                            <tr key={fd.id || fd.message} className="diff-finding-row">
                              <td colSpan={3}>{renderFinding ? renderFinding(fd) : fd.message}</td>
                            </tr>
                          ))
                        : null}
                    </Fragment>
                  ))}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </section>
  );
}
