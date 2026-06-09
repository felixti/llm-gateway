import { PRINCIPAL_HEADERS, type UserAuth, type PrincipalKind } from '@shared/contracts/claims';
import { ok, err, type Result } from '@shared/result';

const PRINCIPAL_HEADER_NAMES: string[] = Object.values(PRINCIPAL_HEADERS);

/** rawHeaders = Node IncomingMessage.rawHeaders = [name0, value0, name1, value1, ...]. */
export function checkDuplicatePrincipalHeaders(rawHeaders: string[]): Result<void> {
  const seen = new Set<string>();
  for (let i = 0; i < rawHeaders.length; i += 2) {
    const name = (rawHeaders[i] ?? '').toLowerCase();
    if (PRINCIPAL_HEADER_NAMES.includes(name)) {
      if (seen.has(name)) return err(`duplicate principal header: ${name}`);
      seen.add(name);
    }
  }
  return ok(undefined);
}

export function parsePrincipalHeaders(headers: Headers, orgId: string): Result<UserAuth> {
  const id = headers.get(PRINCIPAL_HEADERS.id);
  const kind = headers.get(PRINCIPAL_HEADERS.kind);
  const project = headers.get(PRINCIPAL_HEADERS.project);
  const scopesRaw = headers.get(PRINCIPAL_HEADERS.scopes) ?? '';

  if (!id || id.includes(',')) return err('missing or malformed x-principal-id');
  if (kind !== 'user' && kind !== 'sp') return err('invalid x-principal-kind');
  if (kind === 'sp' && (!project || project.includes(','))) return err('sp requires x-principal-project');

  const projectId = kind === 'sp' ? (project as string) : null;
  const scopes = scopesRaw.split(' ').map((s) => s.trim()).filter(Boolean);

  return ok({ principalId: id, principalKind: kind as PrincipalKind, projectId, orgId, scopes });
}
