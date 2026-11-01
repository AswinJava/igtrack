import { once } from "node:events";
import { createServer, type Server, type ServerResponse } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CapabilityErrorKind } from "@igtrack/core";
import {
  ANON_PAGE_RESPONSE_MAX_BYTES,
  AnonTransportError,
  buildInPageRequestExpression,
  connectCdp,
  decodeInPagePayload,
} from "../src/public/anonstories-chrome.js";

// ---------------------------------------------------------------------------
// The two reads this transport performs over a boundary it does not control:
// one API answer fetched inside a page, and the DevTools endpoint of a local
// browser. Neither is testable by launching Chrome, so each branch is driven
// here with a stream or a socket instead.
//
// What these tests pin is the shape of the refusals. A read that is too big is
// counted, not quoted: those bytes can be another account's payload, and an
// error string is something this product stores, prints and ships in evidence.
// ---------------------------------------------------------------------------

const CHUNK = 64 * 1024;

/** A stream that hands out one chunk per pull and records how far it got. */
function countedStream(
  chunkCount: number,
  hooks: { pull?: () => void; cancel?: () => void } = {},
): Response {
  const bytes = new TextEncoder().encode("a".repeat(CHUNK));
  let enqueued = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (enqueued >= chunkCount) {
          controller.close();
          return;
        }
        enqueued += 1;
        hooks.pull?.();
        controller.enqueue(bytes);
      },
      cancel() {
        hooks.cancel?.();
      },
    }),
    { status: 200 },
  );
}

/** Run the page script in Node with a stubbed fetch, as Chrome would. */
async function runInPage(
  fetchImpl: () => Promise<Response>,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  const expression = buildInPageRequestExpression(
    "https://anonstories.example.com/api/getstory.php",
    "auth-token-value",
    maxBytes,
  );
  const previous = globalThis.fetch;
  globalThis.fetch = fetchImpl as typeof globalThis.fetch;
  try {
    const result = (new Function(`return ${expression}`) as () => Promise<string>)();
    return JSON.parse(await result) as Record<string, unknown>;
  } finally {
    globalThis.fetch = previous;
  }
}

function refused(fn: () => unknown): AnonTransportError {
  try {
    fn();
  } catch (err) {
    if (err instanceof AnonTransportError) return err;
    throw err;
  }
  throw new Error("expected the read to be refused");
}

describe("the in-page API read", () => {
  it("returns an answer that fits under the cap whole", async () => {
    const read = await runInPage(
      async () => new Response('{"items":[1,2,3]}', { status: 200 }),
      ANON_PAGE_RESPONSE_MAX_BYTES,
    );
    expect(read).toEqual({ status: 200, body: '{"items":[1,2,3]}' });
  });

  it("reads a large-but-fitting answer whole", async () => {
    const read = await runInPage(
      () => Promise.resolve(countedStream(3)),
      CHUNK * 3,
    );
    expect(read.status).toBe(200);
    expect((read.body as string).length).toBe(CHUNK * 3);
  });

  it("stops at the cap and reports bytes, never the body", async () => {
    let pulls = 0;
    let cancelled = false;
    const read = await runInPage(
      () => Promise.resolve(countedStream(40, { pull: () => (pulls += 1), cancel: () => (cancelled = true) })),
      CHUNK * 3,
    );
    expect(read).toEqual({ status: 200, oversize: true, bytes: CHUNK * 4 });
    // The page stopped asking rather than collecting all forty chunks, and the
    // chunks it already held were dropped instead of crossing CDP as a body.
    expect(pulls).toBeLessThan(10);
    expect(cancelled).toBe(true);
    expect("body" in read).toBe(false);
  });

  it("reports a fetch that threw in the page instead of an empty answer", async () => {
    const read = await runInPage(
      () => Promise.reject(new TypeError("Failed to fetch")),
      ANON_PAGE_RESPONSE_MAX_BYTES,
    );
    expect(read).toEqual({ status: 0, body: "", error: "Failed to fetch" });
  });

  it("treats an answer with no body as no bytes, not as a cap failure", async () => {
    const read = await runInPage(
      async () => new Response(null, { status: 204 }),
      ANON_PAGE_RESPONSE_MAX_BYTES,
    );
    expect(read).toEqual({ status: 204, body: "" });
    expect(decodeInPagePayload(JSON.stringify(read))).toEqual({ status: 204, body: "" });
  });

  it("decodes a fitted answer into the response the provider expects", () => {
    expect(decodeInPagePayload('{"status":200,"body":"{\\"u\\":1}"}')).toEqual({
      status: 200,
      body: '{"u":1}',
    });
  });

  it("turns the oversize marker into a refusal that counts and does not quote", () => {
    const error = refused(() =>
      decodeInPagePayload(`{"status":200,"oversize":true,"bytes":5242880}`),
    );
    expect(error.kind).toBe(CapabilityErrorKind.PROVIDER_ERROR);
    expect(error.message).toContain(`${ANON_PAGE_RESPONSE_MAX_BYTES}-byte cap`);
    expect(error.message).toContain("at least 5242880 bytes were offered");
    expect(error.message).toContain("it was not read");
  });

  it("says a cap was passed when the page could not count the bytes", () => {
    const message = refused(() => decodeInPagePayload('{"status":200,"oversize":true}')).message;
    expect(message).toContain("cap");
    // No invented precision: a count the page did not return is not reported.
    expect(message).not.toContain("at least");
  });

  it("keeps a malformed answer malformed and payload-free", () => {
    const error = refused(() =>
      decodeInPagePayload(`{"status":200,"body":"${"leaked-token-XYZ".repeat(10)}`),
    );
    expect(error.kind).toBe(CapabilityErrorKind.PROVIDER_ERROR);
    expect(error.message).toBe("the in-page request returned malformed JSON");
  });

  it("raises an in-page failure as a network refusal", () => {
    const error = refused(() =>
      decodeInPagePayload('{"status":0,"body":"","error":"TypeError: Failed to fetch"}'),
    );
    expect(error.kind).toBe(CapabilityErrorKind.NETWORK);
    expect(error.message).toContain("Failed to fetch");
  });

  it("answers a payload with neither status nor body as nothing observed", () => {
    expect(decodeInPagePayload("{}")).toEqual({ status: 0, body: "" });
  });

  it("refuses an oversized stream end to end without its bytes", async () => {
    const read = await runInPage(() => Promise.resolve(countedStream(40)), CHUNK * 3);
    const error = refused(() => decodeInPagePayload(JSON.stringify(read), CHUNK * 3));
    expect(error.message).not.toContain("aaaa");
    expect(error.message).toContain(`${CHUNK * 3}-byte cap`);
  });

  it("refuses to build a page request whose cap can never fire", () => {
    // The bound is interpolated into plain JavaScript, so `NaN` compiles to
    // `total > NaN`: a cap that is present, silent, and never bites. That is
    // worse than no cap, because the reader believes there is one.
    for (const cap of [0, -1, Number.NaN, 1.5, Number.POSITIVE_INFINITY]) {
      const error = refused(() => buildInPageRequestExpression("https://x/y", "auth", cap));
      expect(error.message).toMatch(/positive byte count/);
      expect(error.kind).toBe(CapabilityErrorKind.PROVIDER_ERROR);
    }
    expect(buildInPageRequestExpression("https://x/y", "auth", 1024)).toContain("total > 1024");
  });
});

// ---------------------------------------------------------------------------
// The DevTools endpoint: three different failures need three different
// sentences. "Chrome exposed no debuggable page target" sends someone hunting
// for a browser flag; "answered a target list that is not JSON" means a browser
// is running and something else is answering on that port.
// ---------------------------------------------------------------------------

let server: Server | undefined;
let port = 0;
let respond: (res: ServerResponse) => void = (res) => {
  res.writeHead(404, { "content-type": "text/plain" });
  res.end("no such endpoint");
};

async function captureConnectCdp(timeoutMs: number): Promise<AnonTransportError> {
  try {
    await connectCdp(port, timeoutMs);
  } catch (err) {
    if (err instanceof AnonTransportError) return err;
    throw err;
  }
  throw new Error("expected connectCdp to refuse");
}

beforeAll(async () => {
  server = createServer((req, res) => {
    if (req.url === "/json/list") respond(res);
    else {
      res.writeHead(404);
      res.end("no such endpoint");
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("test server did not bind a TCP port");
  }
  port = address.port;
});

afterAll(async () => {
  if (server !== undefined && server.listening) {
    const closed = once(server, "close");
    server.closeAllConnections();
    server.close();
    await closed;
  }
});

describe("the DevTools endpoint refusal", () => {
  it("says the endpoint answered with an error status", async () => {
    respond = (res) => {
      res.writeHead(500, { "content-type": "text/plain" });
      res.end("browser is confused");
    };
    expect((await captureConnectCdp(400)).message).toBe(
      "Chrome answered its target list with HTTP 500, so no debuggable page target could be reached.",
    );
  });

  it("says the target list was too big to read", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(`[{"type":"page","url":"https://x/${"y".repeat(300 * 1024)}"}]`);
    };
    expect((await captureConnectCdp(400)).message).toBe(
      "Chrome answered a target list past its read cap, so no debuggable page target could be reached.",
    );
  });

  it("says the target list was not a target list", async () => {
    respond = (res) => {
      res.writeHead(200, { "content-type": "text/html" });
      res.end("<!doctype html><title>another program is on this port</title>");
    };
    expect((await captureConnectCdp(400)).message).toBe(
      "Chrome answered a target list that is not JSON, so no debuggable page target could be reached.",
    );
  });

  it("says no page target when nothing answered at all", async () => {
    // Stop listening on the port first: the only honest answer for a browser
    // that never replies must not borrow one of the three sentences above.
    if (server !== undefined) {
      const closed = once(server, "close");
      server.closeAllConnections();
      server.close();
      await closed;
      server = undefined;
    }
    expect((await captureConnectCdp(400)).message).toBe(
      "Chrome exposed no debuggable page target.",
    );
  });
});
