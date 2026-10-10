import type { GroveEvent, GroveEventType } from "@grove/shared";
import type { Store } from "./store.ts";

export type EventListener = (event: GroveEvent) => void;

/**
 * The single realtime channel: every emit appends an event row (replayable via
 * GET /tasks/:id/events) and fans out to in-process listeners (the WS layer).
 */
export class EventBus {
  private readonly listeners = new Set<EventListener>();

  constructor(private readonly store: Store) {}

  emit(
    taskId: string,
    workerId: string | null,
    type: GroveEventType,
    payload: unknown,
  ): GroveEvent {
    const event = this.store.appendEvent(taskId, workerId, type, payload);
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // a broken subscriber must never break the orchestrator
      }
    }
    return event;
  }

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
