// Lambda Web Adapter returns a proxy response for event passthrough. Keep that transport
// outside the state machine, which sees only projectId, runId and done.
const { LambdaClient, InvokeCommand } = require('@aws-sdk/client-lambda');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
const lambda = new LambdaClient({});
const secrets = new SecretsManagerClient({});
let secret;
exports.handler = async (event) => {
  if (!event.projectId || !event.runId) throw new Error('Missing workflow identity');
  if (!secret) secret = (await secrets.send(new GetSecretValueCommand({ SecretId: process.env.SECRET_ARN }))).SecretString;
  const response = await lambda.send(new InvokeCommand({
    FunctionName: process.env.PORTAL_FUNCTION_NAME,
    Payload: Buffer.from(JSON.stringify({ job: event.fail ? 'automation-fail' : 'automation-tick', secret, args: { projectId: event.projectId, runId: event.runId } })),
  }));
  if (response.FunctionError) throw new Error('Workflow coordinator invocation failed');
  let payload = JSON.parse(Buffer.from(response.Payload).toString('utf8'));
  if (payload.statusCode) {
    if (payload.statusCode >= 400) throw new Error('Workflow coordinator returned an error');
    payload = typeof payload.body === 'string' ? JSON.parse(payload.body) : payload.body;
  }
  if (typeof payload.result?.done !== 'boolean') throw new Error('Workflow coordinator returned an invalid result');
  return { projectId: event.projectId, runId: event.runId, done: payload.result.done };
};
