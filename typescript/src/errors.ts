// ---------------------------------------------------------------------------
// Anvil DB TypeScript Client — Error types
// ---------------------------------------------------------------------------

/**
 * Error thrown by the Anvil DB client.
 *
 * Wraps HTTP status codes and server-provided error messages so callers can
 * distinguish network failures from application-level errors.
 */
export class AnvilError extends Error {
  /** HTTP status code, if the error originated from an HTTP response. */
  public readonly statusCode: number | undefined;

  /** Raw response body, when available. */
  public readonly body: unknown;

  constructor(message: string, statusCode?: number, body?: unknown) {
    super(message);
    this.name = "AnvilError";
    this.statusCode = statusCode;
    this.body = body;

    // Maintain proper prototype chain for instanceof checks.
    Object.setPrototypeOf(this, new.target.prototype);
  }

  /**
   * Create an {@link AnvilError} from a failed `fetch` {@link Response}.
   *
   * Attempts to parse the response body as JSON; falls back to plain text.
   */
  static async fromResponse(response: Response): Promise<AnvilError> {
    let body: unknown;
    const contentType = response.headers.get("content-type") ?? "";
    try {
      if (contentType.includes("application/json")) {
        body = await response.json();
      } else {
        body = await response.text();
      }
    } catch {
      body = undefined;
    }

    const msg =
      typeof body === "object" && body !== null && "error" in body
        ? String((body as Record<string, unknown>).error)
        : typeof body === "string" && body.length > 0
          ? body
          : `HTTP ${response.status} ${response.statusText}`;

    return new AnvilError(msg, response.status, body);
  }
}
