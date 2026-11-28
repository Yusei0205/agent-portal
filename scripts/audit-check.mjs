// Fails when a production dependency has a high or critical advisory that is not listed in scripts/audit-allowlist.json.
// Lower severities are printed, not failed on. Every allowlist entry says why it is accepted; review them when updating packages.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const allow = new Map(JSON.parse(readFileSync(new URL('./audit-allowlist.json', import.meta.url), 'utf8')).map((a) => [a.id, a.reason]));

let raw;
try {
  raw = execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  raw = e.stdout; // npm audit exits non-zero when it finds anything
}
const report = JSON.parse(raw);
if (report.error) { console.error('npm audit failed:', report.error.summary ?? report.error); process.exit(2); }

const advisoryId = (url) => url.split('/').pop();
const blocking = [];
const accepted = [];
for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
  for (const via of v.via) {
    if (typeof via === 'string') continue; // a package that only depends on a vulnerable one; the advisory is reported on that package
    const id = advisoryId(via.url);
    const line = `${name} ${via.severity}: ${via.title} (${id})`;
    if (via.severity !== 'high' && via.severity !== 'critical') { console.log('note  ', line); continue; }
    if (allow.has(id)) { accepted.push(`${line}\n         accepted: ${allow.get(id)}`); continue; }
    blocking.push(line);
  }
}
for (const a of accepted) console.log('accept', a);
if (blocking.length) {
  console.error('\nHigh or critical advisories with no accepted reason:\n  ' + blocking.join('\n  '));
  process.exit(1);
}
console.log('\nNo unaccepted high or critical advisories in production dependencies.');
