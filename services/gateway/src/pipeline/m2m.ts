import { jwtVerify, type JWTVerifyGetKey } from 'jose';
import { ok, err, type Result } from '@shared/result';
import type { M2mClaims } from '@shared/contracts/claims';

export interface M2mVerifyOptions {
  jwks: JWTVerifyGetKey;
  issuer: string;
  audience: string;
  appId: string;
}

export async function verifyM2mToken(token: string, opts: M2mVerifyOptions): Promise<Result<M2mClaims>> {
  try {
    const { payload } = await jwtVerify(token, opts.jwks, {
      issuer: opts.issuer,
      audience: opts.audience,
      algorithms: ['RS256'],
    });
    const appId = (payload.appid ?? payload.azp) as string | undefined;
    if (appId !== opts.appId) return err('m2m appid mismatch');
    return ok({ iss: payload.iss as string, aud: opts.audience, appId, exp: payload.exp as number });
  } catch (e) {
    return err(`m2m verify failed: ${(e as Error).message}`);
  }
}
