#!/usr/bin/env node
/**
 * scripts/deploy-scope.mjs
 *
 * Used by deploy-portal.yml: which of the runner images a push changes, so the deploy rebuilds only those.
 *
 *   runners  the Claude and Kiro runner images (deploy-agentcore.yml deploys them): a file listed in RUNNER_PATHS changed.
 *   codex    the Codex runner image: a file that goes into it changed. Its contents are the esbuild bundle of the runner's two
 *            entry points (codex-runner/build.mjs), so the files it is made of are read from that bundle, not listed by hand.
 *
 * `runners` is true only when the diff could be read (a push with a known previous commit), because the portal deploy then waits for
 * the runner deploy of the same commit; `codex` is true whenever the diff cannot be read, so an unknown change deploys.
 *
 * Environment: BEFORE (the commit before the push), SHA (the pushed commit), GITHUB_OUTPUT (where `runners=` and `codex=` go).
 */

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { HARNESS_SERVER_FILES } from '../infra/scripts/harness-sources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Paths whose change starts deploy-agentcore.yml (and so a runner image build). test/deploy-scope.test.ts keeps the workflow's
 * `paths:` equal to this list. `**` ends a folder pattern; anything else is one file.
 */
export const RUNNER_PATHS = [
  'agent-runner/**',
  'kiro-runner/**',
  'infra/**',
  // Staged into the images (infra/scripts/harness-sources.mjs).
  ...HARNESS_SERVER_FILES.map(f => `server/${f}`),
  // The portal's side of the runner protocol, and the end-to-end test that runs the real engine.
  'server/agent/agentcore-bridge.ts',
  'server/agent/claude-agentcore.ts',
  'server/agent/kiro-agentcore.ts',
  'test/engine/**',
  '.github/workflows/deploy-agentcore.yml',
];

/** Files outside the bundle that still change the Codex image: its Dockerfile and sources, the lockfile, the stack. */
export const CODEX_PATHS = [
  'codex-runner/**',
  'package.json',
  'package-lock.json',
  'tsconfig.json',
  'infra/lib/codex-runner-stack.ts',
];

export function matches(file, pattern) {
  return pattern.endsWith('/**') ? file.startsWith(pattern.slice(0, -2)) : file === pattern;
}

export const anyMatch = (files, patterns) => files.some(f => patterns.some(p => matches(f, p)));

/** The repository files the Codex runner bundle is made of (what `node codex-runner/build.mjs` reads), as repo-relative paths. */
export async function codexBundleFiles(repoRoot = root) {
  const esbuild = await import('esbuild');
  const result = await esbuild.build({
    absWorkingDir: repoRoot,
    entryPoints: { index: 'codex-runner/src/index.ts', 'mcp-proxy': 'codex-runner/src/mcp-proxy.ts' },
    bundle: true, platform: 'node', format: 'esm', target: 'node22', external: ['ws'],
    write: false, metafile: true, outdir: 'dist-scope', logLevel: 'silent',
  });
  return new Set(Object.keys(result.metafile.inputs).map(p => p.split(path.sep).join('/')).filter(p => !p.includes('node_modules')));
}

/** What a list of changed files means for the images. `codexFiles` is codexBundleFiles(). */
export function scopeFor(changed, codexFiles) {
  return {
    runners: anyMatch(changed, RUNNER_PATHS),
    codex: anyMatch(changed, CODEX_PATHS) || changed.some(f => codexFiles.has(f)),
  };
}

/** The files changed between two commits, or null when git cannot say (a first push, a commit missing from a shallow clone). */
export function changedFiles(before, sha, cwd = root) {
  if (!before || /^0+$/.test(before) || !sha) return null;
  try {
    const out = execFileSync('git', ['diff', '--name-only', `${before}`, `${sha}`], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return out.split('\n').map(s => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const changed = changedFiles(process.env.BEFORE, process.env.SHA);
  let scope;
  if (changed === null) {
    // Unknown: deploy everything that can be deployed without waiting for a runner deploy that may not exist.
    scope = { runners: false, codex: true };
    console.log('The changed files are not known: the Codex runner is deployed, and no runner deploy is waited for.');
  } else {
    scope = scopeFor(changed, await codexBundleFiles());
    console.log(`${changed.length} changed file(s): runners=${scope.runners} codex=${scope.codex}`);
  }
  if (process.env.GITHUB_OUTPUT) fs.appendFileSync(process.env.GITHUB_OUTPUT, `runners=${scope.runners}\ncodex=${scope.codex}\n`);
}
