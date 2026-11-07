import { NotFoundException } from '@nestjs/common';
import type { Prisma } from '../../prisma/generated/client';
import type { PrismaService } from '../prisma.service';
import { normalizeUsername } from './username';

export async function requireUserNamed<S extends Prisma.UserSelect>(
  prisma: PrismaService,
  username: string,
  select: S,
  where: Pick<Prisma.UserWhereInput, 'deleteAt'> = {},
) {
  const user = await prisma.user.findUnique({
    where: { username: normalizeUsername(username), ...where },
    select,
  });
  if (!user) throw new NotFoundException('User not found');
  return user;
}
