import { randomUUID } from "node:crypto";
import {
  type CiEvent,
  type EventFrame,
  type EventSnapshot,
  MAX_PROJECTION_BYTES,
  MAX_PROJECTIONS,
} from "./event-schema.ts";
import { ciChannel } from "./github-ci.ts";
import type { CiProjection, WebhookDelivery } from "./types.ts";

/** All mutation and watermark allocation is synchronous on the producer event loop. */
export class EventFeed {
  readonly instanceId = randomUUID();
  readonly generation = 1;
  sequence = 0;
  inventory: EventSnapshot["inventory"] = "complete";
  diagnostics: string[] = [];
  readonly projections = new Map<string, CiProjection>();
  #bytes = 0;
  readonly #sizes = new Map<string, number>();
  constructor(
    readonly publish: (frame: EventFrame) => void,
    readonly now: () => Date,
  ) {}
  context() {
    return { instanceId: this.instanceId, generation: this.generation, sequence: this.sequence };
  }
  snapshot(): EventSnapshot {
    return {
      ...this.context(),
      inventory: this.inventory,
      diagnostics: [...this.diagnostics],
      projections: [...this.projections.values()],
    };
  }
  set(projection: CiProjection, emit = true): void {
    const name = ciChannel(projection.owner, projection.repo);
    const copy = structuredClone(projection);
    const bytes = Buffer.byteLength(JSON.stringify(copy));
    const oldBytes = this.#sizes.get(name) ?? 0;
    if (
      (!this.projections.has(name) && this.projections.size >= MAX_PROJECTIONS) ||
      this.#bytes - oldBytes + bytes > MAX_PROJECTION_BYTES
    ) {
      this.inventory = "incomplete";
      this.diagnostics = [
        "CI projection exceeds 1024 repositories or 8 MiB; omitted repositories are unknown.",
      ];
      this.remove(name, emit);
      return;
    }
    this.#bytes += bytes - oldBytes;
    this.#sizes.set(name, bytes);
    this.projections.set(name, copy);
    if (emit) this.#ci(name, copy);
  }
  remove(name: string, emit = true): void {
    this.#bytes -= this.#sizes.get(name) ?? 0;
    this.#sizes.delete(name);
    this.projections.delete(name);
    if (emit) this.#ci(name, null);
  }
  #ci(name: string, projection: CiProjection | null): void {
    this.sequence++;
    const frame: CiEvent = {
      v: 1,
      type: "event",
      event: name,
      data: {
        ...this.context(),
        emittedAt: this.now().toISOString(),
        inventory: this.inventory,
        projection,
      },
    };
    this.publish(frame);
  }
  delivery(delivery: WebhookDelivery): void {
    this.sequence++;
    this.publish({
      v: 1,
      type: "event",
      event: "deliveries",
      data: { ...this.context(), emittedAt: this.now().toISOString(), delivery },
    });
  }
}
