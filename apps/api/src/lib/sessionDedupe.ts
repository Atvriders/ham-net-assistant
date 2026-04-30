import type { PrismaClient } from '@prisma/client';

/**
 * Find any non-deleted session for a given net that started on the same
 * calendar day (server local timezone) as the provided Date.
 */
export async function findSameDaySession(
  prisma: PrismaClient,
  netId: string,
  on: Date,
): Promise<{ id: string; endedAt: Date | null } | null> {
  const dayStart = new Date(on);
  dayStart.setHours(0, 0, 0, 0);
  const dayEnd = new Date(on);
  dayEnd.setHours(23, 59, 59, 999);
  return prisma.netSession.findFirst({
    where: {
      netId,
      deletedAt: null,
      startedAt: { gte: dayStart, lte: dayEnd },
    },
    select: { id: true, endedAt: true },
  });
}
