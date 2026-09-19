import { z } from "zod";

export const nativeAgentSessionSchema = z.object({
  id: z.string().uuid(),
  title: z.string().max(160),
  updatedAt: z.number().finite().nonnegative(),
  resumePath: z.string().max(2048),
});
export type NativeAgentSession = z.infer<typeof nativeAgentSessionSchema>;
export const nativeAgentSessionIndexSchema = z.object({
  sessions: z.array(nativeAgentSessionSchema).max(200),
  syncedAt: z.number().nullable(),
  partial: z.boolean(),
  launchId: z.string(),
  openedSessionId: z.string().nullable(),
});
export type NativeAgentSessionIndex = z.infer<
  typeof nativeAgentSessionIndexSchema
>;
export const openNativeAgentSessionSchema = z.object({
  sessionId: z.string().uuid().nullable(),
  expectedLaunchId: z.string().max(100),
  requestId: z.string().uuid(),
  confirmReplace: z.literal(true),
});
