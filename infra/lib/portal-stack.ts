/**
 * AgentPortalCloud: Path B (full serverless) core stack.
 *
 *   - DynamoDB tables (on-demand), generated from infra/tables.json
 *     (refresh with: node --import tsx scripts/dump-dynamo-tables.ts)
 *   - Lambda container image (Lambda Web Adapter, response streaming) behind a Function URL
 *     (open URL; the server rejects requests without CloudFront's secret header)
 *   - S3 bucket for the web UI + CloudFront: /* -> S3, /api/* -> Lambda Function URL
 *   - Secrets Manager secret for the portal master key
 *   - $10/month budget alert
 *
 * Deploy: cd infra && npx cdk deploy AgentPortalCloud --profile agentcore
 */
import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as budgets from 'aws-cdk-lib/aws-budgets';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as bedrock from 'aws-cdk-lib/aws-bedrock';
import * as s3vectors from 'aws-cdk-lib/aws-s3vectors';
import * as ecrAssets from 'aws-cdk-lib/aws-ecr-assets';
import { Construct } from 'constructs';
import tablesJson from '../tables.json';

/** Fixed so the function can be granted permission to invoke itself without a circular dependency. */
const PORTAL_FUNCTION_NAME = 'agent-portal';

interface KeyDef { AttributeName: string; KeyType: 'HASH' | 'RANGE' }
interface TableSpec {
  TableName: string;
  KeySchema: KeyDef[];
  AttributeDefinitions: { AttributeName: string; AttributeType: string }[];
  GlobalSecondaryIndexes?: {
    IndexName: string;
    KeySchema: KeyDef[];
    Projection: { ProjectionType: string; NonKeyAttributes?: string[] };
  }[];
  Ttl: string | null;
}

const attrType = (t: string) =>
  t === 'N' ? dynamodb.AttributeType.NUMBER : t === 'B' ? dynamodb.AttributeType.BINARY : dynamodb.AttributeType.STRING;


/**
 * AppSync Events Lambda authorizer. Verifies the portal's signed token (HS256, key derived from the master key)
 * and enforces channel access:
 *   connect: any valid token          publish: never (the portal publishes with IAM)
 *   subscribe /global/* and /run/*: any valid token
 *   subscribe /project/<id>: admin, or <id> is in the token's project list
 */
const REALTIME_AUTHORIZER_CODE = `
const crypto = require('crypto');
const { SecretsManagerClient, GetSecretValueCommand } = require('@aws-sdk/client-secrets-manager');
let key;
async function signingKey() {
  if (key) return key;
  const r = await new SecretsManagerClient({}).send(new GetSecretValueCommand({ SecretId: process.env.KEY_SECRET_ARN }));
  key = crypto.createHmac('sha256', r.SecretString.trim()).update('portal-realtime-v1').digest();
  return key;
}
function verify(token, k) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const expected = crypto.createHmac('sha256', k).update(parts[0] + '.' + parts[1]).digest('base64url');
  const a = Buffer.from(parts[2]), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  let c;
  try { c = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')); } catch (e) { return null; }
  if (!c || typeof c.exp !== 'number' || c.exp < Date.now() / 1000) return null;
  return c;
}
exports.handler = async (e) => {
  const claims = verify(e.authorizationToken, await signingKey());
  if (!claims) return { isAuthorized: false };
  const ctx = e.requestContext || {};
  if (ctx.operation === 'EVENT_CONNECT') return { isAuthorized: true };
  if (ctx.operation !== 'EVENT_SUBSCRIBE') return { isAuthorized: false };
  const ch = ctx.channel || '';
  if (ch.startsWith('/global/') || ch.startsWith('/run/')) return { isAuthorized: true };
  const m = ch.match(/^\/project\/([^/]+)/);
  if (m) return { isAuthorized: claims.adm === true || (Array.isArray(claims.prj) && claims.prj.includes(m[1])) };
  return { isAuthorized: false };
};
`.trim();

export interface AgentPortalCloudProps extends cdk.StackProps {
  /** Image build context: the repo root. */
  repoRoot: string;
  /** Kiro AgentCore runtime ARN from Spike B. */
  kiroRuntimeArn?: string;
  budgetEmail: string;
  /** Existing S3 bucket the portal may read and write for file storage (optional). */
  storageBucket?: string;
  /** https://<cloudfront domain>; needed for Google sign-in (redirect URI). */
  /** AgentCore runtime that runs Claude (the agent-runner image); enables Claude sessions on the cloud portal. */
  claudeRuntimeArn?: string;
  /** Give Claude runs on AgentCore the Browser tools (-c agentcoreBrowser=true). */
  agentcoreBrowser?: boolean;
  publicUrl?: string;
  /** Emails / @domains allowed to sign in with Google without an invite, comma separated. */
  googleAllowed?: string;
}

export class AgentPortalCloudStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AgentPortalCloudProps) {
    super(scope, id, props);

    // ── DynamoDB ──────────────────────────────────────────────────────────────
    const tables: dynamodb.Table[] = [];
    const tableEnv: Record<string, string> = {};
    for (const spec of tablesJson as unknown as TableSpec[]) {
      const typeOf = (n: string) => attrType(spec.AttributeDefinitions.find((a) => a.AttributeName === n)!.AttributeType);
      const pk = spec.KeySchema.find((k) => k.KeyType === 'HASH')!.AttributeName;
      const sk = spec.KeySchema.find((k) => k.KeyType === 'RANGE')?.AttributeName;
      const table = new dynamodb.Table(this, spec.TableName, {
        tableName: spec.TableName,
        partitionKey: { name: pk, type: typeOf(pk) },
        ...(sk ? { sortKey: { name: sk, type: typeOf(sk) } } : {}),
        billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
        pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        ...(spec.Ttl ? { timeToLiveAttribute: spec.Ttl } : {}),
      });
      for (const g of spec.GlobalSecondaryIndexes ?? []) {
        const gpk = g.KeySchema.find((k) => k.KeyType === 'HASH')!.AttributeName;
        const gsk = g.KeySchema.find((k) => k.KeyType === 'RANGE')?.AttributeName;
        const proj = g.Projection.ProjectionType;
        table.addGlobalSecondaryIndex({
          indexName: g.IndexName,
          partitionKey: { name: gpk, type: typeOf(gpk) },
          ...(gsk ? { sortKey: { name: gsk, type: typeOf(gsk) } } : {}),
          projectionType:
            proj === 'KEYS_ONLY' ? dynamodb.ProjectionType.KEYS_ONLY
            : proj === 'INCLUDE' ? dynamodb.ProjectionType.INCLUDE
            : dynamodb.ProjectionType.ALL,
          ...(proj === 'INCLUDE' ? { nonKeyAttributes: g.Projection.NonKeyAttributes } : {}),
        });
      }
      tables.push(table);
      // portal-users -> DYNAMODB_TABLE_PORTAL_USERS, and so on.
      tableEnv[`DYNAMODB_TABLE_${spec.TableName.replace(/-/g, '_').toUpperCase()}`] = spec.TableName;
    }

    // ── Master key ────────────────────────────────────────────────────────────
    // The portal encrypts stored credentials with a key that must be exactly 64 hex characters (32 bytes),
    // so only 0-9 and a-f may be generated. (The first version used any alphanumeric and failed at runtime.)
    const masterKey = new secretsmanager.Secret(this, 'MasterKeyHex', {
      secretName: 'agent-portal/master-key-hex',
      generateSecretString: {
        passwordLength: 64,
        excludePunctuation: true,
        excludeUppercase: true,
        excludeCharacters: 'ghijklmnopqrstuvwxyz',
      },
    });

    // ── Live updates: AppSync Events ──────────────────────────────────────────
    const authorizerFn = new lambda.Function(this, 'RealtimeAuthorizer', {
      functionName: 'agent-portal-realtime-authorizer',
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(5),
      memorySize: 128,
      code: lambda.Code.fromInline(REALTIME_AUTHORIZER_CODE),
      environment: { KEY_SECRET_ARN: masterKey.secretArn },
    });
    masterKey.grantRead(authorizerFn);
    authorizerFn.addPermission('AllowAppSyncInvoke', {
      principal: new iam.ServicePrincipal('appsync.amazonaws.com'),
      action: 'lambda:InvokeFunction',
    });

    const eventsApi = new appsync.CfnApi(this, 'EventsApi', {
      name: 'agent-portal-events',
      eventConfig: {
        authProviders: [
          { authType: 'AWS_IAM' },
          {
            authType: 'AWS_LAMBDA',
            // No result caching: the cache is keyed by token, but access depends on the channel.
            lambdaAuthorizerConfig: { authorizerUri: authorizerFn.functionArn, authorizerResultTtlInSeconds: 0 },
          },
        ],
        connectionAuthModes: [{ authType: 'AWS_LAMBDA' }],
        defaultPublishAuthModes: [{ authType: 'AWS_IAM' }],
        defaultSubscribeAuthModes: [{ authType: 'AWS_LAMBDA' }],
      },
    });
    eventsApi.node.addDependency(authorizerFn);
    for (const ns of ['run', 'project', 'global']) {
      const channelNs = new appsync.CfnChannelNamespace(this, `${ns}Namespace`, {
        apiId: eventsApi.attrApiId,
        name: ns,
        publishAuthModes: [{ authType: 'AWS_IAM' }],
        subscribeAuthModes: [{ authType: 'AWS_LAMBDA' }],
      });
      channelNs.addDependency(eventsApi);
    }

    // CloudFront origin access control cannot sign POST bodies for Function URLs, so the URL is open and
    // the server only accepts requests that carry this secret header (PORTAL_ORIGIN_SECRET).
    const originSecret = new secretsmanager.Secret(this, 'OriginSecret', {
      secretName: 'agent-portal/origin-secret',
      generateSecretString: { passwordLength: 40, excludePunctuation: true },
    });

    // ── Lambda ────────────────────────────────────────────────────────────────
    // Google sign-in client. Created empty; paste the OAuth client id/secret into it (see docs/deployment/google-sign-in.md).
    const googleSecret = new secretsmanager.Secret(this, 'GoogleOAuth', {
      secretName: 'agent-portal/google-oauth',
      secretStringValue: cdk.SecretValue.unsafePlainText('{"clientId":"","clientSecret":""}'),
    });

    // ── Knowledge Base prerequisites: an S3 Vectors store and the service role a Knowledge Base runs as ──
    // They cost nothing while unused. The Knowledge Base itself and its data source are created from the portal
    // (Knowledge > Search setup), once, and shared by every project, so a deploy never has to be told about it.
    const embedModelArn = `arn:aws:bedrock:${this.region}::foundation-model/cohere.embed-multilingual-v3`;
    let kbEnv: Record<string, string> = {};
    let kbRoleArn: string | undefined;
    if (props.storageBucket) {
      const vectorBucket = new s3vectors.CfnVectorBucket(this, 'KnowledgeVectors', {
        vectorBucketName: `agent-portal-kb-${this.account}-${this.region}`,
      });
      const vectorIndex = new s3vectors.CfnIndex(this, 'KnowledgeIndex', {
        vectorBucketArn: vectorBucket.attrVectorBucketArn,
        indexName: 'documents',
        dataType: 'float32',
        dimension: 1024, // Cohere Embed v3
        distanceMetric: 'cosine',
        metadataConfiguration: { nonFilterableMetadataKeys: ['AMAZON_BEDROCK_TEXT', 'AMAZON_BEDROCK_METADATA'] },
      });
      const kbRole = new iam.Role(this, 'KnowledgeRole', {
        assumedBy: new iam.ServicePrincipal('bedrock.amazonaws.com', {
          conditions: {
            StringEquals: { 'aws:SourceAccount': this.account },
            ArnLike: { 'aws:SourceArn': `arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*` },
          },
        }),
      });
      kbRole.addToPolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [embedModelArn] }));
      kbRole.addToPolicy(new iam.PolicyStatement({
        actions: ['s3:GetObject', 's3:ListBucket'],
        resources: [`arn:aws:s3:::${props.storageBucket}`, `arn:aws:s3:::${props.storageBucket}/data/kb/*`],
      }));
      kbRole.addToPolicy(new iam.PolicyStatement({
        actions: ['s3vectors:GetIndex', 's3vectors:QueryVectors', 's3vectors:PutVectors', 's3vectors:GetVectors', 's3vectors:DeleteVectors', 's3vectors:ListVectors'],
        resources: [vectorIndex.attrIndexArn],
      }));
      kbRoleArn = kbRole.roleArn;
      kbEnv = {
        PORTAL_KB_ROLE_ARN: kbRole.roleArn,
        PORTAL_KB_INDEX_ARN: vectorIndex.attrIndexArn,
        PORTAL_KB_EMBED_MODEL_ARN: embedModelArn,
        PORTAL_KB_BUCKET_ARN: `arn:aws:s3:::${props.storageBucket}`,
      };
    }

    const fn = new lambda.DockerImageFunction(this, 'Portal', {
      functionName: PORTAL_FUNCTION_NAME,
      code: lambda.DockerImageCode.fromImageAsset(props.repoRoot, {
        file: 'Dockerfile.lambda',
        platform: ecrAssets.Platform.LINUX_AMD64,
        ignoreMode: cdk.IgnoreMode.DOCKER,
      }),
      memorySize: 1024,
      timeout: cdk.Duration.minutes(15),
      // Repository clones and agent files live on /tmp: the default 512 MB is too small for a large repository.
      ephemeralStorageSize: cdk.Size.mebibytes(4096),
      environment: {
        ...tableEnv,
        USE_DYNAMODB: 'true',
        SECRET_KEY_ARN: masterKey.secretArn,
        PORTAL_ORIGIN_SECRET: originSecret.secretValue.unsafeUnwrap(),
        PORTAL_EVENTS_HTTP_DOMAIN: eventsApi.attrDnsHttp,
        PORTAL_EVENTS_REALTIME_DOMAIN: eventsApi.attrDnsRealtime,
        ...(props.storageBucket
          ? { STORAGE_BACKEND: 's3', STORAGE_S3_BUCKET: props.storageBucket, STORAGE_S3_PREFIX: 'data', STORAGE_S3_REGION: this.region }
          : {}),
        // A run lives inside one Lambda invocation (15 min max): end agent runs a little before that.
        PORTAL_RUN_TIMEOUT_MS: String(14 * 60_000),
        // Lambda Web Adapter forwards non-HTTP events (EventBridge Scheduler) to this path.
        AWS_LWA_PASS_THROUGH_PATH: '/internal/events',
        PORTAL_GOOGLE_SECRET_ARN: googleSecret.secretArn,
        ...(props.publicUrl ? { PORTAL_PUBLIC_URL: props.publicUrl } : {}),
        ...(props.googleAllowed ? { PORTAL_GOOGLE_ALLOWED: props.googleAllowed } : {}),
        ...(props.claudeRuntimeArn ? { PORTAL_CLAUDE_AGENTCORE_RUNTIME_ARN: props.claudeRuntimeArn } : {}),
        ...(props.agentcoreBrowser ? { PORTAL_AGENTCORE_BROWSER: '1' } : {}),
        ...(props.kiroRuntimeArn ? { PORTAL_KIRO_AGENTCORE_RUNTIME_ARN: props.kiroRuntimeArn } : {}),
        ...kbEnv,
      },
    });
    tables.forEach((t) => t.grantReadWriteData(fn));
    masterKey.grantRead(fn);
    googleSecret.grantRead(fn);
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['appsync:EventPublish'],
      resources: [`arn:aws:appsync:${this.region}:${this.account}:apis/${eventsApi.attrApiId}/channelNamespace/*`],
    }));
    // Live View of the agent's cloud browser: the portal signs the stream address, the page connects to AWS.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock-agentcore:ConnectBrowserLiveViewStream', 'bedrock-agentcore:UpdateBrowserStream', 'bedrock-agentcore:GetBrowserSession'],
      resources: ['*'],
    }));
    // Settings › Model provider › Test connection, and the model pickers, list what Bedrock offers. Read-only, and
    // the list calls do not support resource-level permissions.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['bedrock:ListFoundationModels', 'bedrock:GetFoundationModel', 'bedrock:ListInferenceProfiles', 'bedrock:GetInferenceProfile'],
      resources: ['*'],
    }));
    // Meaning-based Knowledge search embeds passages and questions with this model.
    fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [embedModelArn] }));
    if (kbRoleArn) {
      // The portal creates, syncs, queries and removes the shared Knowledge Base. It may hand Bedrock only the one role above.
      const kbArns = [`arn:aws:bedrock:${this.region}:${this.account}:knowledge-base/*`];
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: [
          'bedrock:CreateKnowledgeBase', 'bedrock:DeleteKnowledgeBase', 'bedrock:GetKnowledgeBase',
          'bedrock:CreateDataSource', 'bedrock:DeleteDataSource', 'bedrock:GetDataSource', 'bedrock:ListDataSources',
          'bedrock:Retrieve', 'bedrock:StartIngestionJob', 'bedrock:GetIngestionJob', 'bedrock:ListIngestionJobs',
        ],
        resources: kbArns,
      }));
      // Listing has no resource to name: it shows which Knowledge Bases exist, so an admin can link one.
      fn.addToRolePolicy(new iam.PolicyStatement({ actions: ['bedrock:ListKnowledgeBases'], resources: ['*'] }));
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['iam:PassRole'],
        resources: [kbRoleArn],
        conditions: { StringEquals: { 'iam:PassedToService': 'bedrock.amazonaws.com' } },
      }));
    }
    if (props.kiroRuntimeArn) {
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:StopRuntimeSession'],
        resources: [props.kiroRuntimeArn, `${props.kiroRuntimeArn}/*`],
      }));
    }
    // Background work (scans, document conversion) invokes this function asynchronously. The ARN is built
    // from the fixed function name: granting fn.grantInvoke(fn) would make the role depend on itself.
    fn.addToRolePolicy(new iam.PolicyStatement({
      actions: ['lambda:InvokeFunction'],
      resources: [`arn:aws:lambda:${this.region}:${this.account}:function:${PORTAL_FUNCTION_NAME}`],
    }));
    if (props.claudeRuntimeArn) {
      fn.addToRolePolicy(new iam.PolicyStatement({
        actions: ['bedrock-agentcore:InvokeAgentRuntime', 'bedrock-agentcore:StopRuntimeSession'],
        resources: [props.claudeRuntimeArn, `${props.claudeRuntimeArn}/*`],
      }));
    }
    if (props.storageBucket) {
      const storage = s3.Bucket.fromBucketName(this, 'StorageBucket', props.storageBucket);
      storage.grantReadWrite(fn);
    }
    const fnUrl = fn.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
      invokeMode: lambda.InvokeMode.RESPONSE_STREAM,
    });

    // ── Web + CloudFront ──────────────────────────────────────────────────────
    const webBucket = new s3.Bucket(this, 'WebBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const dist = new cloudfront.Distribution(this, 'Cdn', {
      defaultRootObject: 'index.html',
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        // Single-page app: paths without a file extension serve index.html. This only applies to the web
        // files; a distribution-wide error response would also turn API 404s into the HTML page.
        functionAssociations: [{
          eventType: cloudfront.FunctionEventType.VIEWER_REQUEST,
          function: new cloudfront.Function(this, 'SpaRewrite', {
            code: cloudfront.FunctionCode.fromInline(
              "function handler(event) { var r = event.request; if (r.uri.indexOf('.') === -1) { r.uri = '/index.html'; } return r; }",
            ),
            runtime: cloudfront.FunctionRuntime.JS_2_0,
          }),
        }],
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.FunctionUrlOrigin(fnUrl, {
            customHeaders: { 'x-portal-origin': originSecret.secretValue.unsafeUnwrap() },
          }),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
    });

    // ── Scheduled jobs ────────────────────────────────────────────────────────
    // Replaces the in-process timers (setInterval) that cannot run on Lambda. Each schedule invokes the
    // function with {job, secret}; server/scheduled-jobs.ts checks the secret and runs the job.
    const schedulerRole = new iam.Role(this, 'SchedulerRole', { assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com') });
    fn.grantInvoke(schedulerRole);
    const jobs: Array<{ name: string; job: string; every: string }> = [
      { name: 'idle-stop', job: 'idle-stop', every: 'rate(1 minute)' },
      { name: 'attachment-cleanup', job: 'attachment-cleanup', every: 'rate(6 hours)' },
      // Starts loop specs whose cron or interval trigger is due (server/loop-triggers.ts).
      { name: 'loop-triggers', job: 'loop-triggers', every: 'rate(1 minute)' },
    ];
    for (const j of jobs) {
      new scheduler.CfnSchedule(this, `Job-${j.name}`, {
        name: `agent-portal-${j.name}`,
        scheduleExpression: j.every,
        flexibleTimeWindow: { mode: 'OFF' },
        target: {
          arn: fn.functionArn,
          roleArn: schedulerRole.roleArn,
          input: JSON.stringify({ job: j.job, secret: originSecret.secretValue.unsafeUnwrap() }),
          retryPolicy: { maximumRetryAttempts: 0 },
        },
      });
    }

    // ── Web files ─────────────────────────────────────────────────────────────
    // Uploads the built web app (npm run build:web -> dist/web) and clears the CDN cache on every deploy.
    const webDir = path.join(props.repoRoot, 'dist', 'web');
    if (!fs.existsSync(path.join(webDir, 'index.html'))) {
      throw new Error(`Web build not found at ${webDir}. Run "npm run build:web" before deploying.`);
    }
    new s3deploy.BucketDeployment(this, 'WebFiles', {
      sources: [s3deploy.Source.asset(webDir)],
      destinationBucket: webBucket,
      distribution: dist,
      distributionPaths: ['/*'],
      memoryLimit: 512,
    });

    // ── Budget ────────────────────────────────────────────────────────────────
    new budgets.CfnBudget(this, 'Budget10', {
      budget: { budgetName: 'agent-portal-10-usd', budgetType: 'COST', timeUnit: 'MONTHLY', budgetLimit: { amount: 10, unit: 'USD' } },
      notificationsWithSubscribers: [80, 100].map((threshold) => ({
        notification: { notificationType: 'ACTUAL', comparisonOperator: 'GREATER_THAN', threshold, thresholdType: 'PERCENTAGE' },
        subscribers: [{ subscriptionType: 'EMAIL', address: props.budgetEmail }],
      })),
    });

    new cdk.CfnOutput(this, 'PortalUrl', { value: `https://${dist.distributionDomainName}` });
    new cdk.CfnOutput(this, 'WebBucketName', { value: webBucket.bucketName });
    new cdk.CfnOutput(this, 'DistributionId', { value: dist.distributionId });
  }
}
