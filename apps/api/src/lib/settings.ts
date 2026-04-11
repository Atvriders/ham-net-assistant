import { PrismaClient } from '@prisma/client';

export async function getSetting(
  prisma: PrismaClient,
  key: string,
): Promise<string | null> {
  const row = await prisma.setting.findUnique({ where: { key } });
  return row?.value ?? null;
}

export async function setSetting(
  prisma: PrismaClient,
  key: string,
  value: string,
): Promise<void> {
  await prisma.setting.upsert({
    where: { key },
    update: { value },
    create: { key, value },
  });
}
