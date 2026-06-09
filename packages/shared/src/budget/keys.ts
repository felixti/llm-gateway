import type { TenantContext } from '../contracts/tenant';

export function budgetScopeTag(
  tenant: Pick<TenantContext, 'principalKind' | 'principalId' | 'projectId'>,
): string {
  if (tenant.principalKind === 'user') return `{user:${tenant.principalId}}`;
  if (tenant.projectId) return `{proj:${tenant.projectId}}`;
  throw new Error('service principal missing projectId');
}

export function budgetKeys(scope: string) {
  return {
    spent: `${scope}:spent`,
    reserved: `${scope}:reserved`,
    policy: `${scope}:policy`,
    reservation: (id: string) => `${scope}:resv:${id}`,
    commitIdempotency: (requestId: string) => `${scope}:commit:${requestId}`,
    rpm: (minute: number) => `${scope}:rpm:${minute}`,
    tpm: (minute: number) => `${scope}:tpm:${minute}`,
  };
}
