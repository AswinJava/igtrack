/**
 * One bounded read for every JSON/HTTP response in this package.
 *
 * `res.json()` allocates however many bytes the server decides to send. The
 * Graph and search endpoints are documented as returning small objects, and the
 * DevTools endpoint is a local Chrome — but "documented as small" is not a
 * guarantee, and a single hostile or misbehaving answer would otherwise size
 * the ingestion process's memory for it. The cap is enforced while streaming,
 * not after: the declared `content-length` is checked as an early refusal and
 * the real byte count is checked as the truth, because a chunked response can
 * claim anything.
 *
 * A refusal never quotes the body. These responses can carry tokens, page
 * payloads or another owner's data, and an error message is something this
 * product stores, prints and ships in evidence rows.
 */

/** Raised when a response is bigger than the caller's declared cap. */
export class ResponseTooLargeError extends Error {
  readonly receivedBytes: number;
  readonly maxBytes: number;

  constructor(label: string, receivedBytes: number, maxBytes: number) {
    super(
      `the ${label} response passed the ${maxBytes}-byte cap ` +
        `(at least ${receivedBytes} bytes were offered); it was not read`,
    );
    this.name = "ResponseTooLargeError";
    this.receivedBytes = receivedBytes;
    this.maxBytes = maxBytes;
  }
}

/** Raised when a bounded body is not the JSON its caller expected. No payload. */
export class ResponseParseError extends Error {
  readonly label: string;

  constructor(label: string) {
    super(`the ${label} response body is not the JSON object that endpoint documents`);
    this.name = "ResponseParseError";
    this.label = label;
  }
}

/**
 * The two parts of a response a bounded read touches. `Response` satisfies it,
 * and so can a stub: the cap is about how bytes are consumed, and a test should
 * be able to hand over a stream that never stops without standing up a server.
 */
export interface BoundedResponse {
  headers: { get(name: string): string | null };
  body: ReadableStream<Uint8Array> | null;
}

/** Read a response body as bytes, refusing anything past `maxBytes`. */
export async function readBoundedBytes(
  response: BoundedResponse,
  maxBytes: number,
  label: string,
): Promise<Uint8Array> {
  const declared = response.headers.get("content-length");
  if (declared !== null) {
    const size = Number.parseInt(declared, 10);
    if (Number.isSafeInteger(size) && size > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(label, size, maxBytes);
    }
  }

  const reader = response.body?.getReader();
  // A response with no body stream has no bytes: not an empty string read
  // around the cap, and not a failure.
  if (reader === undefined) return new Uint8Array(0);

  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value === undefined) continue;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new ResponseTooLargeError(label, total, maxBytes);
    }
    chunks.push(value);
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return merged;
}

/** Read a response body as text, refusing anything past `maxBytes`. */
export async function readBoundedText(
  response: BoundedResponse,
  maxBytes: number,
  label: string,
): Promise<string> {
  return new TextDecoder("utf-8", { fatal: false }).decode(
    await readBoundedBytes(response, maxBytes, label),
  );
}

/**
 * Read a response body as parsed JSON under the same cap. A body that is not
 * JSON becomes a `ResponseParseError` naming the endpoint and nothing else —
 * `JSON.parse` quotes the bytes it choked on, and those bytes are not this
 * product's to report.
 */
export async function readBoundedJson<T>(
  response: Response,
  maxBytes: number,
  label: string,
): Promise<T> {
  const text = await readBoundedText(response, maxBytes, label);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ResponseParseError(label);
  }
}
