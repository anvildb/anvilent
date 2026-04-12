import { describe, expect, it } from "vitest";

import { AnvilError } from "../src/errors.js";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function textResponse(status: number, body: string, statusText?: string): Response {
  return new Response(body, {
    status,
    statusText,
    headers: { "content-type": "text/plain" },
  });
}

describe("AnvilError", () => {
  it("stores message, statusCode, and body", () => {
    const err = new AnvilError("boom", 500, { error: "boom" });
    expect(err.name).toBe("AnvilError");
    expect(err.message).toBe("boom");
    expect(err.statusCode).toBe(500);
    expect(err.body).toEqual({ error: "boom" });
  });

  it("is an instance of Error and AnvilError", () => {
    const err = new AnvilError("x");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(AnvilError);
  });

  describe("fromResponse", () => {
    it("extracts 'error' field from a JSON body", async () => {
      const err = await AnvilError.fromResponse(
        jsonResponse(400, { error: "bad query" }),
      );
      expect(err.message).toBe("bad query");
      expect(err.statusCode).toBe(400);
      expect(err.body).toEqual({ error: "bad query" });
    });

    it("uses a plain-text body as the message", async () => {
      const err = await AnvilError.fromResponse(textResponse(404, "not found"));
      expect(err.message).toBe("not found");
      expect(err.statusCode).toBe(404);
      expect(err.body).toBe("not found");
    });

    it("falls back to HTTP status when the body has no useful message", async () => {
      const res = new Response(null, { status: 503, statusText: "Service Unavailable" });
      const err = await AnvilError.fromResponse(res);
      expect(err.message).toBe("HTTP 503 Service Unavailable");
      expect(err.statusCode).toBe(503);
    });

    it("falls back to HTTP status when JSON body has no 'error' key", async () => {
      const err = await AnvilError.fromResponse(
        jsonResponse(500, { unrelated: "field" }),
      );
      expect(err.message).toBe("HTTP 500 ");
      expect(err.statusCode).toBe(500);
      expect(err.body).toEqual({ unrelated: "field" });
    });
  });
});
