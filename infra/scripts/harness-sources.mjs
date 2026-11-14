/**
 * The portal modules (paths under server/) that go into the Claude and Kiro runner images, besides the agent-runner/ and kiro-runner/
 * folders. deploy-harness.mjs stages exactly these, and scripts/deploy-scope.mjs and .github/workflows/deploy-agentcore.yml trigger a
 * runner deploy when one of them changes (test/deploy-scope.test.ts keeps the workflow's path list equal to this one). Add a module
 * to the runner images here, and nowhere else.
 */
export const HARNESS_SERVER_FILES = [
  'agent/guard.ts', 'agent/env-scrub.ts', 'agent/tool-policy.ts', 'agent/pricing.ts', 'agent/agentcore-approvals.ts', 'real-path.ts',
  // The runners' own pure modules (files, repositories, snapshots, MCP proxies, checks).
  'agent/runner-files.ts',
  'agent/runner-inspect.ts',
  'agent/runner-repos.ts',
  'agent/runner-snapshot.ts',
  'agent/runner-terminal.ts',
  'agent/runner-terminal-auth.ts',
  'agent/runner-mcp.ts',
  'agent/runner-checks.ts',
  'agent/runner-finalize.ts',
  'agent/runner-finalize-run.ts',
  'agent/runner-memory.ts',
  'agent/runner-graph.ts',
  'agent/runner-graph-build.ts',
];
