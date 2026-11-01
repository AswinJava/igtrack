import { describe, expect, it } from "vitest";
import {
  readBoundedBytes,
  readBoundedJson,
  readBoundedText,
  ResponseParseError,
  ResponseTooLargeError,
} from "../src/http/bounded-response.js";

// ---------------------------------------------------------------------------
// `res.json()` allocates whatever the server decides to send. These tests pin
// the one reading primitive this package uses instead: the cap is enforced
// while the body streams, so neither a lying `content-length` nor a chunked
// response that simply never stops can size this process's memory.
// ---------------------------------------------------------------------------

const CHUNK = 64 * 1024;

function streamed(chunks: number, headers: Record<string, string> = {}): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const bytes = new TextEncoder().encode("a".repeat(CHUNK));
        for (let i = 0; i < chunks; i += 1) controller.enqueue(bytes);
        controller.close();
      },
    }),
    { status: 200, headers },
  );
}

describe("bounded response reads", () => {
  it("returns the whole body when it fits", async () => {
    const response = new Response('{"ok":true}', {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
    expect(await readBoundedText(response, 1_024, "test")).toBe('{"ok":true}');
  });

  it("parses JSON under the cap", async () => {
    const response = new Response('{"ok":true}', { status: 200 });
    const body = await readBoundedJson<{ ok: unknown }>(response, 1_024, "test");
    expect(body).toEqual({ ok: true });
  });

  it("refuses a body whose declared length already exceeds the cap", async () => {
    // The declared length is an early refusal, not the measurement: the byte
    // count is still checked as the stream arrives.
    const response = streamed(8, { "Content-Length": "9000000" });
    await expect(readBoundedText(response, 1_024, "example endpoint")).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
    await expect(
      readBoundedText(streamed(8, { "Content-Length": "9000000" }), 1_024, "example endpoint"),
    ).rejects.toThrow(/example endpoint response passed the 1024-byte cap/);
  });

  it("stops a chunked body that lies about its size", async () => {
    // No content-length at all, and the bytes keep coming: the cap must hold on
    // the actual count, which is the only number a streaming server controls.
    const response = streamed(8);
    let caught: unknown;
    try {
      await readBoundedText(response, CHUNK * 3, "chunked endpoint");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ResponseTooLargeError);
    const error = caught as ResponseTooLargeError;
    expect(error.maxBytes).toBe(CHUNK * 3);
    expect(error.receivedBytes).toBeGreaterThan(CHUNK * 3);
    // The message names the size, never the bytes read: a refused payload must
    // not leak into a log or a report through its own error string.
    expect(error.message).not.toContain("aaaa");
  });

  it("reads a large-but-fitting stream whole", async () => {
    const response = streamed(3);
    const text = await readBoundedText(response, CHUNK * 3, "chunked endpoint");
    expect(text.length).toBe(CHUNK * 3);
  });

  it("reports the cap, not a parse, for JSON that is too big", async () => {
    const response = new Response(JSON.stringify({ blob: "y".repeat(4_000) }), { status: 200 });
    await expect(readBoundedJson(response, 1_024, "json endpoint")).rejects.toBeInstanceOf(
      ResponseTooLargeError,
    );
  });

  it("reads a response that carries no body as zero bytes", async () => {
    // A 204 answer genuinely has no body stream. That is an empty read, not a
    // cap failure and not an error: reporting it as either would turn "the
    // server had nothing" into a claim about why it had nothing.
    const bytes = await readBoundedBytes(new Response(null, { status: 204 }), 1_024, "no-body endpoint");
    expect(bytes.byteLength).toBe(0);
    expect(await readBoundedText(new Response(null, { status: 204 }), 1_024, "no-body endpoint")).toBe("");
  });

  it("names the endpoint, never the bytes, when a bounded body is not JSON", async () => {
    // JSON.parse quotes the bytes it choked on, and those bytes are not this
    // product's to report: they can be a page, a token, or another owner's data.
    const response = new Response("<!doctype html>session-token-XYZ", { status: 200 });
    let caught: unknown;
    try {
      await readBoundedJson(response, 1_024, "graph account endpoint");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(ResponseParseError);
    expect((caught as Error).message).toBe(
      "the graph account endpoint response body is not the JSON object that endpoint documents",
    );
    expect((caught as Error).message).not.toContain("session-token");
  });
});
