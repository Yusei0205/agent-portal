/**
 * Step types, validation, and vault/file ref patterns for the Tests module.
 */

// ── Locator shapes ─────────────────────────────────────────────────────────────

export type LocatorShape =
  | { role: string; name: string }
  | { label: string }
  | { text: string }
  | { testId: string }
  | { css: string };

function validateLocator(loc: unknown, field: string): LocatorShape {
  if (!loc || typeof loc !== 'object') throw new Error(`${field}: locator must be an object`);
  const l = loc as Record<string, unknown>;
  if (typeof l.role === 'string' && typeof l.name === 'string') return { role: l.role, name: l.name };
  if (typeof l.label === 'string') return { label: l.label };
  if (typeof l.text === 'string') return { text: l.text };
  if (typeof l.testId === 'string') return { testId: l.testId };
  if (typeof l.css === 'string') return { css: l.css };
  throw new Error(`${field}: locator must have role+name, label, text, testId, or css`);
}

// ── JSON assertion ─────────────────────────────────────────────────────────────

export interface JsonAssertion {
  jsonPath: string;
  expected: unknown;
}

// ── Step union ─────────────────────────────────────────────────────────────────

export type Step =
  | { kind: 'goto'; path: string }
  | { kind: 'click'; locator: LocatorShape }
  | { kind: 'fill'; locator: LocatorShape; value: string }
  | { kind: 'select'; locator: LocatorShape; value: string }
  | { kind: 'press'; key: string; locator?: LocatorShape }
  | { kind: 'upload'; locator: LocatorShape; file: string }
  | { kind: 'assert_visible'; locator: LocatorShape }
  | { kind: 'assert_text'; locator: LocatorShape; text: string; exact?: boolean }
  | { kind: 'assert_url'; url: string; exact?: boolean }
  | { kind: 'wait'; ms?: number; locator?: LocatorShape }
  | {
      kind: 'api_request';
      method: string;
      path: string;
      headers?: Record<string, string>;
      body?: unknown;
      expectedStatus?: number;
      jsonAssertions?: JsonAssertion[];
    }
  | { kind: 'agent'; instruction: string };

const STEP_KINDS = new Set([
  'goto', 'click', 'fill', 'select', 'press', 'upload',
  'assert_visible', 'assert_text', 'assert_url', 'wait',
  'api_request', 'agent',
]);

export function validateStep(raw: unknown, index: number): Step {
  if (!raw || typeof raw !== 'object') throw new Error(`step[${index}]: must be an object`);
  const s = raw as Record<string, unknown>;
  const kind = s.kind;
  if (typeof kind !== 'string' || !STEP_KINDS.has(kind)) {
    throw new Error(`step[${index}]: unknown kind "${String(kind)}"`);
  }

  switch (kind) {
    case 'goto': {
      if (typeof s.path !== 'string') throw new Error(`step[${index}] goto: path must be a string`);
      return { kind: 'goto', path: s.path };
    }
    case 'click':
      return { kind: 'click', locator: validateLocator(s.locator, `step[${index}] click`) };
    case 'fill': {
      if (typeof s.value !== 'string') throw new Error(`step[${index}] fill: value must be a string`);
      return { kind: 'fill', locator: validateLocator(s.locator, `step[${index}] fill`), value: s.value };
    }
    case 'select': {
      if (typeof s.value !== 'string') throw new Error(`step[${index}] select: value must be a string`);
      return { kind: 'select', locator: validateLocator(s.locator, `step[${index}] select`), value: s.value };
    }
    case 'press': {
      if (typeof s.key !== 'string') throw new Error(`step[${index}] press: key must be a string`);
      const loc = s.locator ? validateLocator(s.locator, `step[${index}] press`) : undefined;
      return { kind: 'press', key: s.key, ...(loc ? { locator: loc } : {}) };
    }
    case 'upload': {
      if (typeof s.file !== 'string') throw new Error(`step[${index}] upload: file must be a string`);
      if (!s.file.startsWith('{{file.')) {
        throw new Error(`step[${index}] upload: file must be "{{file.<name>}}"`);
      }
      return { kind: 'upload', locator: validateLocator(s.locator, `step[${index}] upload`), file: s.file };
    }
    case 'assert_visible':
      return { kind: 'assert_visible', locator: validateLocator(s.locator, `step[${index}] assert_visible`) };
    case 'assert_text': {
      if (typeof s.text !== 'string') throw new Error(`step[${index}] assert_text: text must be a string`);
      return {
        kind: 'assert_text',
        locator: validateLocator(s.locator, `step[${index}] assert_text`),
        text: s.text,
        ...(s.exact !== undefined ? { exact: Boolean(s.exact) } : {}),
      };
    }
    case 'assert_url': {
      if (typeof s.url !== 'string') throw new Error(`step[${index}] assert_url: url must be a string`);
      return { kind: 'assert_url', url: s.url, ...(s.exact !== undefined ? { exact: Boolean(s.exact) } : {}) };
    }
    case 'wait': {
      const ms = s.ms !== undefined ? Number(s.ms) : undefined;
      if (ms !== undefined && !Number.isFinite(ms)) throw new Error(`step[${index}] wait: ms must be a number`);
      const loc = s.locator ? validateLocator(s.locator, `step[${index}] wait`) : undefined;
      return {
        kind: 'wait',
        ...(ms !== undefined ? { ms } : {}),
        ...(loc ? { locator: loc } : {}),
      };
    }
    case 'api_request': {
      if (typeof s.method !== 'string' || !s.method) throw new Error(`step[${index}] api_request: method required`);
      if (typeof s.path !== 'string' || !s.path) throw new Error(`step[${index}] api_request: path required`);
      const headers = s.headers && typeof s.headers === 'object' ? (s.headers as Record<string, string>) : undefined;
      const expectedStatus = s.expectedStatus !== undefined ? Number(s.expectedStatus) : undefined;
      const jsonAssertions: JsonAssertion[] | undefined = Array.isArray(s.jsonAssertions)
        ? (s.jsonAssertions as unknown[]).map((a, ai) => {
            if (!a || typeof a !== 'object') throw new Error(`step[${index}] api_request jsonAssertions[${ai}]: must be object`);
            const ao = a as Record<string, unknown>;
            if (typeof ao.jsonPath !== 'string') throw new Error(`step[${index}] api_request jsonAssertions[${ai}]: jsonPath required`);
            return { jsonPath: ao.jsonPath, expected: ao.expected };
          })
        : undefined;
      return {
        kind: 'api_request',
        method: String(s.method).toUpperCase(),
        path: s.path,
        ...(headers ? { headers } : {}),
        ...(s.body !== undefined ? { body: s.body } : {}),
        ...(expectedStatus !== undefined ? { expectedStatus } : {}),
        ...(jsonAssertions ? { jsonAssertions } : {}),
      };
    }
    case 'agent': {
      if (typeof s.instruction !== 'string' || !s.instruction) {
        throw new Error(`step[${index}] agent: instruction required`);
      }
      return { kind: 'agent', instruction: s.instruction };
    }
    default:
      throw new Error(`step[${index}]: unknown kind "${kind}"`);
  }
}

export function validateSteps(raw: unknown): Step[] {
  if (!Array.isArray(raw)) throw new Error('steps must be an array');
  return (raw as unknown[]).map((s, i) => validateStep(s, i));
}

// ── Vault / file ref patterns ──────────────────────────────────────────────────

/** Matches {{vault.<name>.username|password|totp|value}} */
export const VAULT_REF_RE = /\{\{vault\.([^.}]+)\.(username|password|totp|value)\}\}/g;

/** Matches {{file.<name>}} */
export const FILE_REF_RE = /^\{\{file\.([^}]+)\}\}$/;

// ── Step repair ────────────────────────────────────────────────────────────────

function hasValidLocatorKey(loc: Record<string, unknown>): boolean {
  return (typeof loc.role === 'string' && typeof loc.name === 'string') ||
    typeof loc.label === 'string' ||
    typeof loc.text === 'string' ||
    typeof loc.testId === 'string' ||
    typeof loc.css === 'string';
}

/**
 * Attempt to repair a single step that failed validation.
 *
 * Conservative repairs only — currently handles:
 *   - Steps with a missing/invalid locator but a top-level `text` property:
 *     locator is set to { text } so the step can locate by visible text.
 *     Applies to click, fill, select, assert_visible, assert_text.
 *
 * Returns:
 *   - `step` + `repair` description if repaired successfully.
 *   - `error` if the step cannot be repaired (caller should drop it).
 */
export function attemptRepairStep(
  raw: unknown,
  index: number,
): { step: Step | null; repair: string | null; error: string | null } {
  // First try normal validation — if it passes, no repair needed
  try {
    const step = validateStep(raw, index);
    return { step, repair: null, error: null };
  } catch { /* fall through to repair attempts */ }

  if (raw && typeof raw === 'object') {
    const s = raw as Record<string, unknown>;
    const kind = String(s.kind ?? '');

    // Steps with locator that's missing or invalid but has a top-level text property
    const locatorKinds = new Set(['click', 'fill', 'select', 'assert_visible', 'assert_text']);
    if (locatorKinds.has(kind) && typeof s.text === 'string' && s.text) {
      const hasNoValidLocator =
        !s.locator ||
        typeof s.locator !== 'object' ||
        !hasValidLocatorKey(s.locator as Record<string, unknown>);

      if (hasNoValidLocator) {
        const repaired = { ...s, locator: { text: s.text } };
        try {
          const step = validateStep(repaired, index);
          return {
            step,
            repair: `${kind} locator repaired using text "${s.text}"`,
            error: null,
          };
        } catch { /* repair attempt failed, fall through */ }
      }
    }
  }

  // Could not repair — return the validation error
  let errMsg = 'Unknown validation error';
  try { validateStep(raw, index); } catch (e) { errMsg = (e as Error).message; }
  return { step: null, repair: null, error: errMsg };
}
