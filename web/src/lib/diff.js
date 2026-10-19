// Unified diff parser (same shape as the server's parseUnifiedDiff).
export function parseUnifiedDiff(diff) {
  const files = [];
  let file = null;
  let hunk = null;
  let oldNo = 0;
  let newNo = 0;
  for (const line of String(diff || '').split('\n')) {
    if (line.startsWith('diff --git ')) {
      const m = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
      file = { oldPath: m?.[1] ?? '', newPath: m?.[2] ?? '', status: 'modified', binary: false, hunks: [], additions: 0, deletions: 0 };
      files.push(file);
      hunk = null;
      continue;
    }
    if (!file) continue;
    if (line.startsWith('new file mode')) file.status = 'added';
    else if (line.startsWith('deleted file mode')) file.status = 'deleted';
    else if (line.startsWith('rename to ')) {
      file.status = 'renamed';
      file.newPath = line.slice(10);
    } else if (line.startsWith('Binary files')) file.binary = true;
    else if (line.startsWith('--- ') || line.startsWith('+++ ')) continue;
    else if (line.startsWith('@@')) {
      const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      oldNo = Number(m?.[1] ?? 1);
      newNo = Number(m?.[2] ?? 1);
      hunk = { header: line, lines: [] };
      file.hunks.push(hunk);
    } else if (hunk) {
      if (line.startsWith('+')) {
        hunk.lines.push({ type: 'add', text: line.slice(1), oldLine: null, newLine: newNo++ });
        file.additions++;
      } else if (line.startsWith('-')) {
        hunk.lines.push({ type: 'del', text: line.slice(1), oldLine: oldNo++, newLine: null });
        file.deletions++;
      } else if (line.startsWith(' ')) {
        hunk.lines.push({ type: 'ctx', text: line.slice(1), oldLine: oldNo++, newLine: newNo++ });
      }
    }
  }
  return files;
}
