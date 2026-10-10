/**
 * Pushable async message queue backing streaming session input: the initial
 * prompt is yielded first, then any steering messages pushed while the session
 * runs. `close()` ends the stream once the buffer drains; pushes after close
 * are refused so callers can fall back to queue-for-next-session.
 */
export class InputQueue {
  private buffer: string[] = [];
  private notify: (() => void) | null = null;
  private closed = false;

  push(text: string): boolean {
    if (this.closed) return false;
    this.buffer.push(text);
    this.notify?.();
    return true;
  }

  close(): void {
    this.closed = true;
    this.notify?.();
  }

  get isEmpty(): boolean {
    return this.buffer.length === 0;
  }

  async *drain(): AsyncGenerator<string> {
    while (true) {
      const next = this.buffer.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => {
        this.notify = resolve;
      });
      this.notify = null;
    }
  }
}
