/**
 * Checking an OpenAPI document someone hands us, and putting it in the shape the engine expects.
 *
 * We accept the JSON form of OpenAPI 3.x and use only what the engine needs: paths, methods, parameters, the JSON request
 * body, the JSON responses and `security`. Anything else is ignored, not rejected. $ref is not resolved here.
 */

import type { ApiSpec, HttpMethod, Operation } from './types.ts';

const METHODS: HttpMethod[] = ['get', 'post', 'put', 'patch', 'delete'];
const MAX_BYTES = 2_000_000;

export interface OpenApiCheck { spec?: ApiSpec; errors: string[] }

function slugOp(method: string, path: string): string {
  const parts = `${method} ${path}`.replace(/[{}]/g, '').replace(/[^A-Za-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  return parts.map((p, i) => (i === 0 ? p.toLowerCase() : p.charAt(0).toUpperCase() + p.slice(1))).join('');
}

export function checkOpenApi(input: unknown): OpenApiCheck {
  const errors: string[] = [];
  if (!input || typeof input !== 'object') return { errors: ['The spec must be a JSON object'] };
  const doc = input as Record<string, unknown>;
  if (JSON.stringify(doc).length > MAX_BYTES) return { errors: ['The spec is larger than 2 MB'] };
  if (typeof doc.openapi !== 'string' || !doc.openapi.startsWith('3.')) errors.push('"openapi" must be a 3.x version string');
  if (!doc.paths || typeof doc.paths !== 'object') errors.push('"paths" is required');
  if (errors.length > 0) return { errors };

  const info = (doc.info ?? {}) as Record<string, unknown>;
  const paths: ApiSpec['paths'] = {};
  const seen = new Set<string>();
  for (const [path, item] of Object.entries(doc.paths as Record<string, unknown>)) {
    if (!path.startsWith('/')) { errors.push(`Path "${path}" must start with "/"`); continue; }
    if (!item || typeof item !== 'object') continue;
    for (const method of METHODS) {
      const raw = (item as Record<string, unknown>)[method];
      if (!raw || typeof raw !== 'object') continue;
      const op = raw as Record<string, unknown>;
      let operationId = typeof op.operationId === 'string' && op.operationId ? op.operationId : slugOp(method, path);
      while (seen.has(operationId)) operationId += '_';
      seen.add(operationId);
      if (!op.responses || typeof op.responses !== 'object') errors.push(`${method.toUpperCase()} ${path} has no "responses"`);
      const clean: Operation = {
        ...(op as unknown as Operation),
        operationId,
        responses: (op.responses ?? {}) as Operation['responses'],
      };
      (paths[path] ??= {})[method] = clean;
    }
  }
  if (Object.keys(paths).length === 0 && errors.length === 0) errors.push('The spec has no operations');
  if (errors.length > 0) return { errors };

  return {
    errors,
    spec: {
      openapi: '3.0.3',
      info: { title: typeof info.title === 'string' && info.title ? info.title : 'Imported API', version: typeof info.version === 'string' ? info.version : '1' },
      paths,
      ...(doc.components && typeof doc.components === 'object' ? { components: doc.components as ApiSpec['components'] } : {}),
    },
  };
}
