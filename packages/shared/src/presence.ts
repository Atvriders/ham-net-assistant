import { z } from 'zod';

/** A user is considered "online" if their lastSeenAt is within this window. */
export const PRESENCE_ONLINE_WINDOW_MS = 2 * 60 * 1000;

/** Response shape for the presence heartbeat endpoint. */
export const HeartbeatResult = z.object({
  ok: z.literal(true),
  lastSeenAt: z.string().datetime(),
});
export type HeartbeatResult = z.infer<typeof HeartbeatResult>;

/** A single online-member entry returned by the presence roster endpoint. */
export const OnlineUser = z.object({
  id: z.string(),
  callsign: z.string(),
  name: z.string(),
  lastSeenAt: z.string().datetime().nullable(),
});
export type OnlineUser = z.infer<typeof OnlineUser>;
