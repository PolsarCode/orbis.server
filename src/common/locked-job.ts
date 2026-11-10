import { PrismaService } from '../prisma.service';

export async function runLocked(
  prisma: PrismaService,
  lock: number,
  timeout: number,
  work: () => Promise<void>,
) {
  await prisma.$transaction(
    async (tx) => {
      const [{ locked }] = await tx.$queryRaw<{ locked: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${lock}::bigint) AS locked
      `;
      if (locked) await work();
    },
    { timeout },
  );
}
