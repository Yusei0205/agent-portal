/**
 * One line per security event, in a fixed shape that CloudWatch metric filters count: `[security] <event> {json}`.
 * Never put a password, token or email in `fields`.
 */
export function securityLog(event: string, fields: Record<string, string | number | boolean> = {}): void {
  console.warn(`[security] ${event} ${JSON.stringify(fields)}`);
}
