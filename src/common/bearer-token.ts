import { JwtService } from '@nestjs/jwt';

const jwt = new JwtService();

export function bearerSubject(
  authorization: unknown,
): number | null | undefined {
  if (typeof authorization !== 'string') return null;
  if (!authorization.startsWith('Bearer ')) return null;
  try {
    return jwt.verify<{ sub?: number }>(authorization.slice(7), {
      secret: process.env.JWT_SECRET,
    }).sub;
  } catch {
    return null;
  }
}
