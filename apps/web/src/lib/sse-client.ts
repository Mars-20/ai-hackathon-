// Buffered SSE frame parser for the validate page (client-safe: no
// server-only imports — this module ships to the browser).
//
// Root cause (prod 2026-10-05): the page decoded each TCP chunk standalone
// (`decoder.decode(value)`) and split on single "\n". An SSE event
// straddling two chunks produced half-JSON, threw in JSON.parse, and died
// in a silent `catch {}`. If the lost event was `done`, the stream then
// ended with no verdict and no error — frozen UI.
//
// Frames from /api/agent are `data: {...}\n\n`, so the parser buffers
// text and only emits complete `\n\n`-terminated frames. It also tracks
// whether a terminal event (`done`/`error`) arrived, letting the caller
// distinguish "stream ended cleanly" from "stream died mid-run".

export interface SseEvent {
  type?: string;
  [key: string]: unknown;
}

export interface SseParser {
  /** Feed a decoded text chunk; returns only complete events. */
  push(text: string): SseEvent[];
  /** True once a `done` or `error` event has been emitted. */
  hasTerminalEvent(): boolean;
  /** Malformed data-lines skipped so far (diagnostic counter). */
  droppedCount(): number;
}

export function createSseParser(): SseParser {
  let buf = "";
  let terminal = false;
  let dropped = 0;

  return {
    push(text: string): SseEvent[] {
      buf += text.replace(/\r\n/g, "\n");
      const events: SseEvent[] = [];
      let idx = buf.indexOf("\n\n");
      while (idx !== -1) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const lines = frame.split("\n").filter((l) => l.startsWith("data: "));
        for (const line of lines) {
          try {
            const data = JSON.parse(line.slice(6)) as SseEvent;
            events.push(data);
            if (data?.type === "done" || data?.type === "error") terminal = true;
          } catch {
            dropped += 1;
          }
        }
        idx = buf.indexOf("\n\n");
      }
      return events;
    },
    hasTerminalEvent(): boolean {
      return terminal;
    },
    droppedCount(): number {
      return dropped;
    },
  };
}
