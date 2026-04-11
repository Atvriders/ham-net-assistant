import { z } from 'zod';

export const TopicStatus = z.enum(['OPEN', 'USED', 'DISMISSED']);
export type TopicStatus = z.infer<typeof TopicStatus>;

export const TopicSuggestionInput = z.object({
  title: z.string().min(3).max(160),
  details: z.string().max(2000).nullable().optional(),
});
export type TopicSuggestionInput = z.infer<typeof TopicSuggestionInput>;

export const TopicSuggestion = z.object({
  id: z.string(),
  title: z.string(),
  details: z.string().nullable(),
  status: TopicStatus,
  createdAt: z.string().datetime(),
  createdById: z.string(),
  createdByCallsign: z.string().optional(),
  createdByName: z.string().optional(),
});
export type TopicSuggestion = z.infer<typeof TopicSuggestion>;

export const UpdateTopicStatusInput = z.object({ status: TopicStatus });
export type UpdateTopicStatusInput = z.infer<typeof UpdateTopicStatusInput>;
