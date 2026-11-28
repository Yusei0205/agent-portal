import { createCursorRunnerServer } from './service.ts';
createCursorRunnerServer().listen(Number(process.env.AGENT_RUNNER_PORT || 8080), '0.0.0.0', () => {
  console.log('Cursor AgentCore runner listening');
});
