import { z } from "zod";
import { randomUUID } from "node:crypto";

export const wakeSourceSchema = z.enum(["api", "slack", "email", "paperplane", "paperclip", "cron", "task_event"]);
export type WakeSource = z.infer<typeof wakeSourceSchema>;

export const sandboxProviderNameSchema = z.enum(["local", "daytona", "e2b"]);
export type SandboxProviderName = z.infer<typeof sandboxProviderNameSchema>;

export const taskStatusSchema = z.enum(["todo", "in_progress", "blocked", "done"]);
export type TaskStatus = z.infer<typeof taskStatusSchema>;

export const runStatusSchema = z.enum(["queued", "starting_sandbox", "running", "succeeded", "failed", "cancelled"]);
export type RunStatus = z.infer<typeof runStatusSchema>;

export const idSegmentSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "must be a safe path segment");
export type IdSegment = z.infer<typeof idSegmentSchema>;

export const wakeRequestSchema = z.object({
  source: wakeSourceSchema.default("api"),
  agentId: idSegmentSchema,
  workspaceId: idSegmentSchema,
  message: z.string().min(1),
  taskId: z.string().min(1).optional(),
  conversationId: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1).optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type WakeRequest = z.infer<typeof wakeRequestSchema>;

export const agentSchema = z.object({
  id: idSegmentSchema,
  createdAt: z.string(),
});
export type Agent = z.infer<typeof agentSchema>;

export const workspaceSchema = z.object({
  id: idSegmentSchema,
  createdAt: z.string(),
});
export type Workspace = z.infer<typeof workspaceSchema>;

export const taskSchema = z.object({
  id: z.string(),
  agentId: idSegmentSchema,
  workspaceId: idSegmentSchema,
  title: z.string(),
  body: z.string(),
  status: taskStatusSchema,
  priority: z.number().int(),
  createdFromEventId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Task = z.infer<typeof taskSchema>;

export const wakeEventSchema = z.object({
  id: z.string(),
  source: wakeSourceSchema,
  agentId: idSegmentSchema,
  workspaceId: idSegmentSchema,
  message: z.string(),
  taskId: z.string().optional(),
  conversationId: z.string().optional(),
  idempotencyKey: z.string().optional(),
  metadata: z.record(z.unknown()).optional(),
  createdAt: z.string(),
});
export type WakeEvent = z.infer<typeof wakeEventSchema>;

export const runSchema = z.object({
  id: z.string(),
  wakeEventId: z.string(),
  agentId: idSegmentSchema,
  workspaceId: idSegmentSchema,
  taskId: z.string().optional(),
  sandboxProvider: sandboxProviderNameSchema,
  sharedBundleVersion: z.string(),
  status: runStatusSchema,
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  error: z.string().optional(),
});
export type Run = z.infer<typeof runSchema>;

export type RunEvent =
  | { type: "wake_received"; runId: string; timestamp: string; message: string }
  | { type: "run_created"; runId: string; timestamp: string }
  | { type: "sandbox_started"; runId: string; timestamp: string; provider: SandboxProviderName; sandboxId: string }
  | { type: "runtime_started"; runId: string; timestamp: string }
  | { type: "stdout"; runId: string; timestamp: string; data: string }
  | { type: "stderr"; runId: string; timestamp: string; data: string }
  | { type: "file_changed"; runId: string; timestamp: string; path: string }
  | { type: "task_updated"; runId: string; timestamp: string; taskId: string; status: TaskStatus }
  | { type: "artifact_created"; runId: string; timestamp: string; path: string }
  | { type: "run_finished"; runId: string; timestamp: string; status: "succeeded" | "failed"; error?: string }
  | { type: "sandbox_stopped"; runId: string; timestamp: string; sandboxId: string };

export const runtimeWakePayloadSchema = z.object({
  run: runSchema,
  wakeEvent: wakeEventSchema,
  task: taskSchema.optional(),
  agentHomePath: z.string(),
  workspacePath: z.string(),
  sharedPath: z.string(),
  controlPlaneApiUrl: z.string(),
  runToken: z.string(),
});
export type RuntimeWakePayload = z.infer<typeof runtimeWakePayloadSchema>;

export function nowIso() {
  return new Date().toISOString();
}

export function createId(prefix: string) {
  return `${prefix}_${randomUUID().replaceAll("-", "").slice(0, 20)}`;
}
