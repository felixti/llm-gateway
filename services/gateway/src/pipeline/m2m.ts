import type { JWTVerifyGetKey } from 'jose';
export interface M2mVerifyOptions { jwks: JWTVerifyGetKey; issuer: string; audience: string; appId: string; }
