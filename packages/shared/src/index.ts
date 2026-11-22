import { z } from "zod";

export const projectSchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  prompt: z.string(),
  status: z.enum(["draft", "ready", "running", "error"]),
  createdAt: z.string(),
  updatedAt: z.string(),
  model: z.string().nullable().optional(),
});
export type Project = z.infer<typeof projectSchema>;

export const publicUserSchema = z.object({ id: z.string(), email: z.string().email() });
export type PublicUser = z.infer<typeof publicUserSchema>;

export const providerSchema = z.object({
  id: z.string().uuid(), providerId: z.string(), baseUrl: z.string().url(), api: z.enum(["openai-completions", "openai-responses"]),
  modelId: z.string(), displayName: z.string(), hasApiKey: z.boolean(), createdAt: z.string(), updatedAt: z.string(),
});
export type Provider = z.infer<typeof providerSchema>;

export const ompEventSchema = z.object({
  id: z.number().int().nonnegative(), projectId: z.string().uuid(), type: z.enum(["session_status", "prompt_accepted", "assistant_delta", "assistant_completed", "tool_started", "tool_progress", "tool_finished", "tool_error", "files_modified", "model_changed", "prompt_aborted", "agent_error", "session_settled", "preview_log", "preview_status"]),
  payload: z.record(z.string(), z.unknown()), createdAt: z.string(),
});
export type OmpEvent = z.infer<typeof ompEventSchema>;

export const sessionEventSchema = z.object({ type: z.string(), message: z.string().optional(), timestamp: z.string(), projectId: z.string().uuid().optional(), eventId: z.number().int().optional(), payload: z.record(z.string(), z.unknown()).optional() });
export type SessionEvent = z.infer<typeof sessionEventSchema>;

export type BrowserCommand = { type: "prompt"; message: string } | { type: "abort" } | { type: "replay"; afterEventId?: number } | { type: "set_model"; provider: string; modelId: string };

export type PreviewProblem = {
  id: string;
  severity: "error" | "warning";
  kind: "dependency" | "startup" | "compile" | "runtime";
  summary: string;
  detail: string;
  location?: { path: string; line: number; column?: number };
  stale: boolean;
};

export type PreviewProblems = {
  runId: string | null;
  phase: "idle" | "starting" | "running" | "failed" | "stopped";
  problems: PreviewProblem[];
  logs: string;
};
