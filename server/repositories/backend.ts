/**
 * Backend selector and DynamoDB environment helpers.
 *
 * Imported by every repository factory to decide whether to activate the
 * DynamoDB implementation.  This file has NO dependency on
 * @aws-sdk/client-dynamodb so it is safe to import statically anywhere,
 * even when the AWS SDK optional dependency is not installed.
 *
 * ## Choosing a backend
 *
 * Set USE_DYNAMODB=true to activate DynamoDB across the entire portal.
 * DYNAMODB_TABLE_PORTAL_USERS is also honoured for backward compatibility
 * with the pilot environment.
 *
 * Using a single global flag prevents the portal from running with some
 * repositories on SQLite and others on DynamoDB.
 */

/**
 * True when DynamoDB mode is active.
 *
 * Checks (in order):
 *   USE_DYNAMODB=true           — recommended master switch
 *   DYNAMODB_TABLE_PORTAL_USERS — backward compat with pilot env
 */
export function usesDynamoDb(): boolean {
  return (
    process.env.USE_DYNAMODB === 'true' ||
    !!process.env.DYNAMODB_TABLE_PORTAL_USERS
  );
}

/**
 * DynamoDB service endpoint override (for DynamoDB Local in dev/test).
 * Undefined means use the standard AWS service endpoint.
 */
export function getDynamoDbEndpoint(): string | undefined {
  return process.env.DYNAMODB_ENDPOINT;
}

/**
 * Target AWS region for DynamoDB.
 * Priority: DYNAMODB_REGION → AWS_REGION → ap-southeast-1 (portal default).
 * Never defaults to us-east-1.
 */
export function getDynamoDbRegion(): string {
  return process.env.DYNAMODB_REGION ?? process.env.AWS_REGION ?? 'ap-southeast-1';
}
