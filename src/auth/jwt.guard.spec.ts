import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtAuthGuard } from './jwt.guard';
import { GUEST_USER_ID } from './allow-guest';

describe('JwtAuthGuard.handleRequest', () => {
  const context = {
    getHandler: () => undefined,
    getClass: () => undefined,
  } as unknown as ExecutionContext;
  const guard = (allowGuest: boolean) =>
    new JwtAuthGuard({
      getAllAndOverride: () => allowGuest,
    } as unknown as Reflector);

  it('passes a logged-in user through', () => {
    expect(
      guard(true).handleRequest(null, { userId: 5 }, null, context),
    ).toEqual({ userId: 5 });
  });

  it('lets a logged-out visitor in as a guest on guest routes', () => {
    expect(guard(true).handleRequest(null, false, null, context)).toEqual({
      userId: GUEST_USER_ID,
    });
  });

  it('rejects a logged-out visitor on other routes', () => {
    expect(() =>
      guard(false).handleRequest(null, false, null, context),
    ).toThrow(UnauthorizedException);
  });
});
