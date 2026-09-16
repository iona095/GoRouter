import { describe, test, expect } from "bun:test";
import { parseSSE, eventsEqual, eventNames, eventData, canonicalEvent } from "../src/sse.ts";

describe("WI03 SSE parser", () => {
  test("parses basic data events with blank-line termination", () => {
    const evs = parseSSE("data: first chunk\n\ndata: second chunk\n\n");
    expect(evs.length).toBe(2);
    expect(evs[0]!.data).toBe("first chunk");
    expect(evs[1]!.data).toBe("second chunk");
    expect(evs[0]!.event).toBeNull();
  });

  test("supports event:, id: and retry: fields", () => {
    const evs = parseSSE("event: message_start\nid: 7\nretry: 3000\ndata: {\"a\":1}\n\n");
    expect(evs.length).toBe(1);
    expect(evs[0]!.event).toBe("message_start");
    expect(evs[0]!.id).toBe("7");
    expect(evs[0]!.retry).toBe("3000");
    expect(evs[0]!.data).toBe("{\"a\":1}");
  });

  test("joins multiple data: lines with newline", () => {
    const evs = parseSSE("data: line one\ndata: line two\n\n");
    expect(evs.length).toBe(1);
    expect(evs[0]!.data).toBe("line one\nline two");
  });

  test("ignores comments but records them", () => {
    const evs = parseSSE(":wi03 heartbeat\ndata: x\n\n");
    expect(evs.length).toBe(1);
    expect(evs[0]!.data).toBe("x");
    expect(evs[0]!.comments).toEqual(["wi03 heartbeat"]);
  });

  test("preserves data: [DONE] as ordinary content", () => {
    const evs = parseSSE("data: {\"x\":1}\n\ndata: [DONE]\n\n");
    expect(evs.length).toBe(2);
    expect(evs[1]!.data).toBe("[DONE]");
  });

  test("preserves event order and detects reordering", () => {
    const a = parseSSE("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
    const b = parseSSE("event: a\ndata: 1\n\nevent: b\ndata: 2\n\n");
    const c = parseSSE("event: b\ndata: 2\n\nevent: a\ndata: 1\n\n");
    expect(eventsEqual(a, b)).toBe(true);
    expect(eventsEqual(a, c)).toBe(false);
    expect(eventNames(a)).toEqual(["a", "b"]);
    expect(eventData(a)).toEqual(["1", "2"]);
  });

  test("trailing event without blank line is still dispatched", () => {
    const evs = parseSSE("data: lone");
    expect(evs.length).toBe(1);
    expect(evs[0]!.data).toBe("lone");
  });

  test("canonical form is stable", () => {
    const [a, b] = [parseSSE("event: e\ndata: d\n\n")[0]!, parseSSE("event: e\ndata: d\n\n")[0]!];
    expect(canonicalEvent(a)).toBe(canonicalEvent(b));
  });
});
