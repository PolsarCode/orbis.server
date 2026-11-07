import { createParamDecorator, ExecutionContext } from '@nestjs/common';

export const UserId = createParamDecorator(
  (_data: unknown, context: ExecutionContext): number =>
    context.switchToHttp().getRequest().user.userId,
);
