import { ForbiddenException } from '@nestjs/common';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { EmailConfirmationService } from './email-confirmation.service';
import { verifyTurnstile } from './turnstile';

jest.mock('./turnstile', () => ({ verifyTurnstile: jest.fn() }));

const verify = verifyTurnstile as jest.MockedFunction<typeof verifyTurnstile>;

describe('Bot check on sign-up and login', () => {
  const authService = { signup: jest.fn(), login: jest.fn() };
  const controller = new AuthController(
    authService as unknown as AuthService,
    {} as EmailConfirmationService,
  );
  const req = { headers: { 'fly-client-ip': '203.0.113.7' }, ip: '10.0.0.1' };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('checks the token from the visitor’s real address before signing up', async () => {
    verify.mockResolvedValueOnce(undefined);

    await controller.signup(
      {
        email: 'a@example.com',
        username: 'aya',
        password: 'secret1',
        turnstileToken: 'token',
      },
      req,
    );

    expect(verify).toHaveBeenCalledWith('token', '203.0.113.7');
    expect(authService.signup).toHaveBeenCalledWith({
      email: 'a@example.com',
      username: 'aya',
      password: 'secret1',
    });
  });

  it('does not create the account when the check fails', async () => {
    verify.mockRejectedValueOnce(new ForbiddenException());

    await expect(
      controller.signup(
        { email: 'a@example.com', username: 'aya', password: 'secret1' },
        req,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(authService.signup).not.toHaveBeenCalled();
  });

  it('does not check the password when the check fails', async () => {
    verify.mockRejectedValueOnce(new ForbiddenException());

    await expect(
      controller.login({ identifier: 'aya', password: 'secret1' }, req),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(authService.login).not.toHaveBeenCalled();
  });

  it('logs in once the check passes', async () => {
    verify.mockResolvedValueOnce(undefined);

    await controller.login(
      { identifier: 'aya', password: 'secret1', turnstileToken: 'token' },
      req,
    );

    expect(verify).toHaveBeenCalledWith('token', '203.0.113.7');
    expect(authService.login).toHaveBeenCalledWith('aya', 'secret1');
  });
});
