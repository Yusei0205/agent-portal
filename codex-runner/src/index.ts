import { createCodexRunnerServer } from './service.ts';
createCodexRunnerServer().listen(Number(process.env.AGENT_RUNNER_PORT || 8080), '0.0.0.0', () => {
  console.log('Codex AgentCore runner listening');
});
