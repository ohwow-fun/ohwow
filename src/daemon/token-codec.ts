import { SignJWT, jwtVerify } from 'jose';

export interface DaemonTokenPayload {
  workspaceName: string;
}

export async function signDaemonToken(
  workspaceName: string,
  jwtSecret: string,
): Promise<string> {
  const key = new TextEncoder().encode(jwtSecret);
  return new SignJWT({ workspaceName })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(key);
}

export async function verifyDaemonToken(
  token: string,
  jwtSecret: string,
): Promise<DaemonTokenPayload | null> {
  try {
    const key = new TextEncoder().encode(jwtSecret);
    const { payload } = await jwtVerify(token, key);
    const workspaceName = payload['workspaceName'];
    if (typeof workspaceName !== 'string' || !workspaceName) return null;
    return { workspaceName };
  } catch {
    return null;
  }
}
