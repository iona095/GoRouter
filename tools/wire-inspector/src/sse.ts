/**
 * WI03 deterministic SSE parser for diagnostic comparison.
 *
 * Supports: event:, data:, id:, retry:, comments (:...), blank-line event
 * termination, multiple data: lines (joined with \n per SSE semantics).
 * OpenAI-style `data: [DONE]` is preserved as ordinary data content.
 * Event order is preserved; payload contents are never normalized.
 */

export interface SseEvent {
  event: string | null;
  data: string;
  id: string | null;
  retry: string | null;
  comments: string[];
}

/** Parse concatenated logical SSE bytes into ordered events. */
export function parseSSE(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  let event: string | null = null;
  let dataLines: string[] = [];
  let id: string | null = null;
  let retry: string | null = null;
  let comments: string[] = [];
  let hasField = false;

  const dispatch = (): void => {
    if (!hasField) return;
    events.push({ event, data: dataLines.join("\n"), id, retry, comments });
    event = null; dataLines = []; id = null; retry = null; comments = []; hasField = false;
  };

  // Normalize CRLF/CR to LF for line splitting (line endings are framing,
  // not payload; logical-byte comparison uses the raw text separately).
  const normalized = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  for (const rawLine of normalized.split("\n")) {
    if (rawLine === "") {
      dispatch();
      continue;
    }
    if (rawLine.startsWith(":")) {
      comments.push(rawLine.slice(1).replace(/^ /, ""));
      hasField = true;
      continue;
    }
    const colon = rawLine.indexOf(":");
    let field: string;
    let value: string;
    if (colon === -1) {
      field = rawLine;
      value = "";
    } else {
      field = rawLine.slice(0, colon);
      value = rawLine.slice(colon + 1).replace(/^ /, "");
    }
    switch (field) {
      case "event": event = value; hasField = true; break;
      case "data": dataLines.push(value); hasField = true; break;
      case "id": id = value; hasField = true; break;
      case "retry": retry = value; hasField = true; break;
      default:
        // Unknown fields are ignored per SSE spec (forward-compatible).
        break;
    }
  }
  dispatch();
  return events;
}

/** Canonical diagnostic form of one event (stable key order). */
export function canonicalEvent(e: SseEvent): string {
  return JSON.stringify({ event: e.event, data: e.data, id: e.id, retry: e.retry, comments: e.comments });
}

/** True when two parsed sequences are identical in order and content. */
export function eventsEqual(a: SseEvent[], b: SseEvent[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (canonicalEvent(a[i]!) !== canonicalEvent(b[i]!)) return false;
  }
  return true;
}

/** Event names in order (null for default data-only events). */
export function eventNames(events: SseEvent[]): (string | null)[] {
  return events.map((e) => e.event);
}

/** Data payloads in order. */
export function eventData(events: SseEvent[]): string[] {
  return events.map((e) => e.data);
}
