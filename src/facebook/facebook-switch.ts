import { PrismaService } from '../prisma.service';

export async function readSwitch(
  prisma: PrismaService,
  key: string,
  fallback: boolean,
) {
  const setting = await prisma.setting.findUnique({
    where: { key },
    select: { value: true },
  });
  return setting ? setting.value === 'true' : fallback;
}

export async function saveSwitch(
  prisma: PrismaService,
  key: string,
  enabled: boolean,
) {
  await prisma.setting.upsert({
    where: { key },
    create: { key, value: String(enabled) },
    update: { value: String(enabled) },
  });
}
