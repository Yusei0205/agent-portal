/**
 * AgentPortalSpikeC — AppSync Events CDK Stack
 *
 * Resources created:
 *   - Lambda function: portal-token Lambda authorizer (inline code)
 *   - AppSync Events API: IAM publish + Lambda authorizer for subscribe/connect
 *   - Channel namespaces: run (/run/<runId>), project (/project/<projectId>), global (/global/portal)
 *   - CloudWatch Log Group for AppSync Events logs
 *   - IAM role for AppSync → CloudWatch log delivery
 *
 * Auth model:
 *   - Publishing: AWS_IAM only (server-side, requires appsync:EventPublish on the API)
 *   - Connecting: AWS_LAMBDA (browser provides a portal-issued token)
 *   - Subscribing: AWS_LAMBDA (Lambda checks token scope vs channel path)
 *     Token format: base64(JSON { "projectId": "project-a" } or { "scope": "global" })
 *     - /global/* — any valid token
 *     - /run/*    — any valid token (run ownership verified by API in production)
 *     - /project/<id> — only if token.projectId === id (DENY cross-project)
 *
 * Channel namespaces (match portal scopes from server/events.ts):
 *   run     — per-run events, replaces subscribeRun(runId, fn)
 *   project — per-project events, replaces subscribe(projectId, res)
 *   global  — portal-wide events, replaces subscribeGlobalOnly(res)
 *
 * To destroy:
 *   cd infra && npx cdk destroy AgentPortalSpikeC --profile agentcore
 */

import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import { Construct } from 'constructs';

/**
 * Lambda authorizer inline code (CJS, Node.js 22).
 *
 * Token: base64-encoded JSON { "projectId": "..." } or { "scope": "global" }
 * Enforces:
 *   EVENT_CONNECT  → allow any valid token
 *   EVENT_PUBLISH  → deny (IAM only)
 *   EVENT_SUBSCRIBE → /global/* and /run/* allow any valid token;
 *                     /project/<id> allows only if token.projectId === id
 */
const AUTHORIZER_CODE = `
exports.handler = async (e) => {
  const t = e.authorizationToken || '';
  const op = (e.requestContext || {}).operation || '';
  const ch = (e.requestContext || {}).channel || '';
  let c;
  try { c = JSON.parse(Buffer.from(t, 'base64').toString('utf8')); } catch (err) { return { isAuthorized: false }; }
  if (!c) return { isAuthorized: false };
  if (op === 'EVENT_CONNECT') return { isAuthorized: true };
  if (op === 'EVENT_PUBLISH') return { isAuthorized: false };
  if (op === 'EVENT_SUBSCRIBE') {
    if (ch.startsWith('/global/')) return { isAuthorized: true };
    if (ch.startsWith('/run/')) return { isAuthorized: true };
    const m = ch.match(/^\\/project\\/([^/]+)/);
    if (m) return { isAuthorized: c.projectId === m[1], handlerContext: { tokenProject: c.projectId || '', channelProject: m[1] } };
    return { isAuthorized: false };
  }
  return { isAuthorized: false };
};
`.trim();

export class AgentPortalSpikeCStack extends cdk.Stack {
  public readonly apiId: string;
  public readonly httpDomain: string;
  public readonly realtimeDomain: string;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ── Lambda Authorizer ─────────────────────────────────────────────────────
    // Decodes portal-issued token and enforces channel access scopes.
    const authorizerFn = new lambda.Function(this, 'SubscribeAuthorizer', {
      functionName: 'agent-portal-spike-c-authorizer',
      description: 'Spike C: AppSync Events subscribe authorizer — checks portal token vs channel scope',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      code: lambda.Code.fromInline(AUTHORIZER_CODE),
    });

    // Allow AppSync to invoke the Lambda authorizer
    authorizerFn.addPermission('AllowAppSyncInvoke', {
      principal: new iam.ServicePrincipal('appsync.amazonaws.com'),
      action: 'lambda:InvokeFunction',
    });

    // ── CloudWatch Log Role for AppSync ────────────────────────────────────────
    const appsyncLogRole = new iam.Role(this, 'AppSyncLogRole', {
      roleName: 'agent-portal-spike-c-appsync-log-role',
      assumedBy: new iam.ServicePrincipal('appsync.amazonaws.com'),
      description: 'Allows AppSync Events API to write logs to CloudWatch',
    });
    appsyncLogRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSAppSyncPushToCloudWatchLogs'),
    );

    // ── AppSync Events API ────────────────────────────────────────────────────
    const api = new appsync.CfnApi(this, 'EventsApi', {
      name: 'agent-portal-spike-c',
      ownerContact: 'agent-portal spike-c',
      eventConfig: {
        authProviders: [
          // IAM: server-side publishing (Lambda→AppSync, publisher script)
          { authType: 'AWS_IAM' },
          // Lambda: browser subscribe / connect
          {
            authType: 'AWS_LAMBDA',
            lambdaAuthorizerConfig: {
              authorizerUri: authorizerFn.functionArn,
              authorizerResultTtlInSeconds: 0, // no caching — every subscribe re-checks token
            },
          },
        ],
        // Connection auth: Lambda authorizer validates the portal token on WebSocket connect
        connectionAuthModes: [{ authType: 'AWS_LAMBDA' }],
        // Publish auth: IAM only (server/Lambda side)
        defaultPublishAuthModes: [{ authType: 'AWS_IAM' }],
        // Subscribe auth: Lambda authorizer (cross-project deny is enforced here)
        defaultSubscribeAuthModes: [{ authType: 'AWS_LAMBDA' }],
        logConfig: {
          cloudWatchLogsRoleArn: appsyncLogRole.roleArn,
          logLevel: 'ALL',
        },
      },
      tags: [
        { key: 'project', value: 'agent-portal' },
        { key: 'purpose', value: 'spike-c' },
      ],
    });

    // Ensure Lambda permission is created before the AppSync API
    api.node.addDependency(authorizerFn);
    api.node.addDependency(appsyncLogRole);

    // ── Channel Namespaces ────────────────────────────────────────────────────
    // Each namespace inherits API-level auth defaults:
    //   publish = AWS_IAM, subscribe = AWS_LAMBDA

    // run namespace: per-run event streams (/run/<runId>)
    // Maps to server/events.ts subscribeRun() / publishRunEvent()
    const runNs = new appsync.CfnChannelNamespace(this, 'RunNamespace', {
      apiId: api.attrApiId,
      name: 'run',
      publishAuthModes: [{ authType: 'AWS_IAM' }],
      subscribeAuthModes: [{ authType: 'AWS_LAMBDA' }],
    });
    runNs.addDependsOn(api);

    // project namespace: per-project event streams (/project/<projectId>)
    // Maps to server/events.ts subscribe(projectId) / emit(projectId, event)
    const projectNs = new appsync.CfnChannelNamespace(this, 'ProjectNamespace', {
      apiId: api.attrApiId,
      name: 'project',
      publishAuthModes: [{ authType: 'AWS_IAM' }],
      subscribeAuthModes: [{ authType: 'AWS_LAMBDA' }],
    });
    projectNs.addDependsOn(api);

    // global namespace: portal-wide events (/global/portal)
    // Maps to server/events.ts subscribeGlobalOnly() / emitGlobal(event)
    const globalNs = new appsync.CfnChannelNamespace(this, 'GlobalNamespace', {
      apiId: api.attrApiId,
      name: 'global',
      publishAuthModes: [{ authType: 'AWS_IAM' }],
      subscribeAuthModes: [{ authType: 'AWS_LAMBDA' }],
    });
    globalNs.addDependsOn(api);

    // ── CloudWatch Log Group ──────────────────────────────────────────────────
    const logGroup = new logs.LogGroup(this, 'AppSyncLogGroup', {
      logGroupName: `/aws/appsync/spike-c`,
      retention: logs.RetentionDays.THREE_DAYS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Stack-level tags
    cdk.Tags.of(this).add('project', 'agent-portal');
    cdk.Tags.of(this).add('purpose', 'spike-c');

    // Store for external access
    this.apiId = api.attrApiId;
    this.httpDomain = api.attrDnsHttp;
    this.realtimeDomain = api.attrDnsRealtime;

    // ── Outputs ───────────────────────────────────────────────────────────────
    new cdk.CfnOutput(this, 'ApiId', {
      exportName: 'spike-c-api-id',
      value: api.attrApiId,
      description: 'AppSync Events API ID',
    });

    new cdk.CfnOutput(this, 'ApiArn', {
      exportName: 'spike-c-api-arn',
      value: cdk.Fn.sub(
        'arn:aws:appsync:${AWS::Region}:${AWS::AccountId}:apis/${ApiId}',
        { ApiId: api.attrApiId },
      ),
      description: 'AppSync Events API ARN (needed for IAM publish policy)',
    });

    new cdk.CfnOutput(this, 'HttpDomain', {
      exportName: 'spike-c-http-domain',
      value: api.attrDnsHttp,
      description: 'HTTP endpoint domain for publishing (IAM SigV4)',
    });

    new cdk.CfnOutput(this, 'RealtimeDomain', {
      exportName: 'spike-c-realtime-domain',
      value: api.attrDnsRealtime,
      description: 'WebSocket realtime endpoint domain for subscribing',
    });

    new cdk.CfnOutput(this, 'AuthorizerFunctionArn', {
      exportName: 'spike-c-authorizer-arn',
      value: authorizerFn.functionArn,
      description: 'Lambda authorizer function ARN',
    });

    new cdk.CfnOutput(this, 'PublishIamPolicyJson', {
      value: JSON.stringify({
        Effect: 'Allow',
        Action: ['appsync:EventPublish'],
        Resource: cdk.Fn.sub(
          'arn:aws:appsync:${AWS::Region}:${AWS::AccountId}:apis/${ApiId}/channelNamespace/*',
          { ApiId: api.attrApiId },
        ),
      }),
      description: 'IAM policy snippet needed to publish to this API',
    });

    new cdk.CfnOutput(this, 'LogGroupName', {
      value: logGroup.logGroupName,
      description: 'CloudWatch Log Group for AppSync Events logs',
    });
  }
}
