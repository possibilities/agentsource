import { z } from "zod";

export const EVENT_PROTOCOL_VERSION = 1 as const;
export const MAX_REQUEST_BYTES = 1024 * 1024;
// GitHub accepts 25 MiB bodies; delivery frames and full CI snapshots need a larger bound.
export const MAX_FRAME_BYTES = 32 * 1024 * 1024;
export const MAX_QUEUED_BYTES = 64 * 1024 * 1024;
export const MAX_CLIENTS = 128;
export const MAX_PROJECTIONS = 1024;
export const MAX_PROJECTION_BYTES = 8 * 1024 * 1024;
export const filterSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^(?:\*|[a-z][a-z0-9._:/-]*\*?)$/);
export const filtersSchema = z.array(filterSchema).min(1).max(32);
export const subscriptionParamsSchema = z.object({ events: filtersSchema.optional() }).strict();
export const emptyParamsSchema = z.object({}).strict();
export const requestEnvelopeSchema = z
  .object({
    v: z.literal(EVENT_PROTOCOL_VERSION),
    type: z.literal("request"),
    id: z.string().min(1).max(128),
    method: z.string().min(1).max(128),
    params: z.unknown().optional(),
  })
  .strict();
const nullableString = z.string().nullable();
const check = z
  .object({
    kind: z.literal("check-run"),
    name: z.string(),
    status: z.string(),
    conclusion: nullableString,
    detailsUrl: nullableString,
    app: nullableString,
    startedAt: nullableString,
    completedAt: nullableString,
  })
  .strict();
const status = z
  .object({
    kind: z.literal("status"),
    name: z.string(),
    state: z.string(),
    description: nullableString,
    targetUrl: nullableString,
    createdAt: nullableString,
  })
  .strict();
export const ciProjectionSchema = z
  .object({
    schemaVersion: z.literal(3),
    revision: z.number().int().nonnegative(),
    projectedAt: z.string(),
    owner: z.string(),
    repo: z.string(),
    paths: z.array(z.string()),
    available: z.boolean(),
    visibility: z.enum(["PRIVATE", "PUBLIC", "INTERNAL"]).nullable(),
    defaultBranch: nullableString,
    primaryBranch: z.string(),
    heads: z.array(
      z
        .object({
          sha: z.string(),
          committedAt: nullableString,
          aggregateState: z.enum([
            "ERROR",
            "EXPECTED",
            "FAILURE",
            "PENDING",
            "SUCCESS",
            "NONE",
            "LOCAL",
            "UNAVAILABLE",
          ]),
          contexts: z.array(z.union([check, status])),
          diagnostics: z.array(z.string()),
        })
        .strict(),
    ),
    targets: z.array(
      z.union([
        z
          .object({
            kind: z.literal("branch"),
            branch: z.string(),
            role: z.enum(["primary", "default"]),
            headSha: nullableString,
          })
          .strict(),
        z
          .object({
            kind: z.literal("checkout"),
            path: z.string(),
            branch: nullableString,
            headSha: z.string(),
          })
          .strict(),
      ]),
    ),
    diagnostics: z.array(z.string()),
  })
  .strict();
export const contextSchema = {
  instanceId: z.string().min(1).describe("Random producer lifetime ID; changes on restart."),
  generation: z
    .number()
    .int()
    .min(1)
    .describe("Always 1: this producer has no replaceable runtime."),
  sequence: z
    .number()
    .int()
    .nonnegative()
    .describe("Publication watermark, not a durable replay cursor."),
};
export const inventorySchema = z.enum(["complete", "incomplete", "unavailable"]);
const ciName = z.string().regex(/^ci:[a-z0-9][a-z0-9-]{0,38}:[a-z0-9_.-]{1,100}$/);
export const snapshotSchema = z
  .object({
    ...contextSchema,
    inventory: inventorySchema,
    diagnostics: z.array(z.string()),
    projections: z.array(ciProjectionSchema).max(MAX_PROJECTIONS),
  })
  .strict()
  .describe(
    "Bounded current CI state independent of filters. No delivery history. Incomplete if capped; unavailable if source initialization failed.",
  );
const eventBase = { v: z.literal(1), type: z.literal("event") };
export const ciEventSchema = z
  .object({
    ...eventBase,
    event: ciName,
    data: z
      .object({
        ...contextSchema,
        emittedAt: z.string(),
        inventory: inventorySchema,
        projection: ciProjectionSchema
          .nullable()
          .describe("Replace this repository; null removes it, never means successful CI."),
      })
      .strict(),
  })
  .strict()
  .describe(
    "Current state: replace or remove ci:<owner>:<repo>. available:false inside a projection is source unavailability, not completion.",
  )
  .meta({ id: "ci:<owner>:<repo>" });
export const deliveryEventSchema = z
  .object({
    ...eventBase,
    event: z.literal("deliveries"),
    data: z
      .object({
        ...contextSchema,
        emittedAt: z.string(),
        delivery: z
          .object({
            schemaVersion: z.literal(1),
            receivedAt: z.string(),
            owner: z.string(),
            repo: z.string(),
            event: z.string(),
            deliveryId: z.string(),
            hookId: nullableString,
            payload: z.unknown(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict()
  .describe(
    "Transient authenticated webhook delivery; no persistence, replay or snapshot recovery. Never discard using a CI watermark.",
  )
  .meta({ id: "deliveries" });
export const eventSchema = z.union([ciEventSchema, deliveryEventSchema]).meta({ id: "events" });
const requestBase = { v: z.literal(1), type: z.literal("request"), id: z.string().min(1).max(128) };
export const requestsSchema = z
  .union([
    z
      .object({
        ...requestBase,
        method: z.literal("event.subscribe"),
        params: subscriptionParamsSchema.nullish(),
      })
      .strict(),
    z
      .object({
        ...requestBase,
        method: z.literal("state.get"),
        params: emptyParamsSchema.nullish(),
      })
      .strict(),
  ])
  .meta({ id: "requests" });
export const subscribedSchema = z
  .object({ subscribed: z.literal(true), events: filtersSchema })
  .strict();
export const responseSchema = z
  .union([
    z
      .object({
        v: z.literal(1),
        type: z.literal("response"),
        id: z.string().min(1).max(128),
        ok: z.literal(true),
        result: z.union([subscribedSchema, snapshotSchema]),
      })
      .strict(),
    z
      .object({
        v: z.literal(1),
        type: z.literal("response"),
        id: z.string().max(128).nullable(),
        ok: z.literal(false),
        error: z
          .object({
            code: z.enum(["invalid_request", "invalid_params", "unknown_method", "internal_error"]),
            message: z.string(),
          })
          .strict(),
      })
      .strict(),
  ])
  .meta({ id: "responses" });
export const socketFrameSchema = z.union([requestsSchema, responseSchema, eventSchema]);
export function eventCatalog(): object {
  return z.toJSONSchema(socketFrameSchema, { target: "draft-2020-12", io: "input" });
}
export function subscriptionMatches(patterns: readonly string[], event: string): boolean {
  return patterns.some((pattern) =>
    pattern.endsWith("*") ? event.startsWith(pattern.slice(0, -1)) : pattern === event,
  );
}
export type EventFrame = z.infer<typeof eventSchema>;
export type CiEvent = z.infer<typeof ciEventSchema>;
export type EventSnapshot = z.infer<typeof snapshotSchema>;
export type EventResponse = z.infer<typeof responseSchema>;
