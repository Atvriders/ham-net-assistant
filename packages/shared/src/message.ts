import { z } from 'zod';
import { Callsign } from './auth.js';

export const MessageInput = z.object({
  body: z.string().trim().min(1).max(500),
});
export type MessageInput = z.infer<typeof MessageInput>;

export const MessageReaction = z.object({
  id: z.string(),
  emoji: z.string(),
  source: z.string(),
  userId: z.string().nullable(),
  authorTag: z.string().nullable(),
  createdAt: z.string().datetime(),
});
export type MessageReaction = z.infer<typeof MessageReaction>;

export const SessionMessage = z.object({
  id: z.string(),
  sessionId: z.string(),
  userId: z.string().nullable(),
  callsign: Callsign,
  nameAtMessage: z.string(),
  body: z.string(),
  createdAt: z.string().datetime(),
  reactions: z.array(MessageReaction).optional(),
});
export type SessionMessage = z.infer<typeof SessionMessage>;
