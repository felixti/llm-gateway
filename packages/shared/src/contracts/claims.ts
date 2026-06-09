export type PrincipalKind = 'user' | 'sp';

/** Identity resolved per request from the Edge's forwarded claims (ADR-0009). */
export interface UserAuth {
  principalId: string;          // human: oid | sp: appid
  principalKind: PrincipalKind;
  projectId: string | null;     // required for sp, always null for user (ADR-0001)
  orgId: string;
  scopes: string[];
}

/** Claims the gateway extracts from YARP's per-hop M2M token. */
export interface M2mClaims {
  iss: string;
  aud: string;
  appId: string;
  exp: number;
}

/** Lowercase because Node/Hono normalises header names to lowercase. */
export const PRINCIPAL_HEADERS = {
  id: 'x-principal-id',
  kind: 'x-principal-kind',
  project: 'x-principal-project',
  scopes: 'x-principal-scopes',
} as const;
