// Minimal incremental SSE parser for the /api/ask stream. EventSource can't
// POST, so the client reads the fetch body and feeds decoded chunks here.
// Pure and stateful-by-closure: unit-testable without any network.
export interface SseEvent {
  event: string;
  data: unknown;
}

export function createSseParser(): (chunk: string) => SseEvent[] {
  let buffer = "";
  return (chunk: string): SseEvent[] => {
    buffer += chunk;
    const events: SseEvent[] = [];
    let boundary: number;
    while ((boundary = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      let event = "message";
      let data = "";
      for (const line of block.split("\n")) {
        if (line.startsWith("event: ")) event = line.slice(7);
        else if (line.startsWith("data: ")) data += line.slice(6);
      }
      if (data) events.push({ event, data: JSON.parse(data) });
    }
    return events;
  };
}
