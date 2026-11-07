import { JwtService } from '@nestjs/jwt';

const jwt = new JwtService();

export function bearerClaims(
  authorization: unknown,
): { sub?: number; iat?: number } | null {
  if (typeof authorization !== 'string') return null;
  if (!authorization.startsWith('Bearer ')) return null;
  try {
    return jwt.verify<{ sub?: number; iat?: number }>(authorization.slice(7), {
      secret: process.env.JWT_SECRET,
    });
  } catch {
    return null;
  }
}

export function bearerSubject(
  authorization: unknown,
): number | null | undefined {
  const claims = bearerClaims(authorization);
  return claims && claims.sub;
}
