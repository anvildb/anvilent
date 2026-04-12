import { describe, expect, it } from "vitest";

import { buildBaseUrl, parseAnvilUri } from "../src/uri.js";

describe("parseAnvilUri", () => {
  it("parses a minimal anvil:// URI with defaults", () => {
    const parts = parseAnvilUri("anvil://localhost");
    expect(parts).toEqual({
      tls: false,
      host: "localhost",
      port: 7474,
      database: undefined,
      username: undefined,
      password: undefined,
    });
  });

  it("parses host, port, and database", () => {
    const parts = parseAnvilUri("anvil://db.example.com:9999/mydb");
    expect(parts.tls).toBe(false);
    expect(parts.host).toBe("db.example.com");
    expect(parts.port).toBe(9999);
    expect(parts.database).toBe("mydb");
    expect(parts.username).toBeUndefined();
    expect(parts.password).toBeUndefined();
  });

  it("parses credentials", () => {
    const parts = parseAnvilUri("anvil://admin:secret@localhost:7474/graph");
    expect(parts.username).toBe("admin");
    expect(parts.password).toBe("secret");
    expect(parts.database).toBe("graph");
  });

  it("parses a username-only credential", () => {
    const parts = parseAnvilUri("anvil://admin@localhost/mydb");
    expect(parts.username).toBe("admin");
    expect(parts.password).toBeUndefined();
  });

  it("percent-decodes credentials", () => {
    const parts = parseAnvilUri("anvil://us%40er:p%40ss@localhost");
    expect(parts.username).toBe("us@er");
    expect(parts.password).toBe("p@ss");
  });

  it("uses the last '@' to split credentials (so '@' in password is fine)", () => {
    const parts = parseAnvilUri("anvil://admin:p@ss@host:1234/db");
    expect(parts.username).toBe("admin");
    expect(parts.password).toBe("p@ss");
    expect(parts.host).toBe("host");
    expect(parts.port).toBe(1234);
    expect(parts.database).toBe("db");
  });

  it("sets tls=true for anvil+tls://", () => {
    const parts = parseAnvilUri("anvil+tls://host:8443/db");
    expect(parts.tls).toBe(true);
    expect(parts.host).toBe("host");
    expect(parts.port).toBe(8443);
  });

  it("treats an empty trailing slash as no database", () => {
    const parts = parseAnvilUri("anvil://localhost/");
    expect(parts.database).toBeUndefined();
  });

  it("defaults an empty host to 'localhost'", () => {
    const parts = parseAnvilUri("anvil://:1234/db");
    expect(parts.host).toBe("localhost");
    expect(parts.port).toBe(1234);
  });

  it("throws on an invalid scheme", () => {
    expect(() => parseAnvilUri("http://localhost")).toThrow(/Invalid Anvil URI scheme/);
  });

  it("throws on a non-numeric port", () => {
    expect(() => parseAnvilUri("anvil://host:abc/db")).toThrow(/Invalid port/);
  });

  it("throws on an out-of-range port", () => {
    expect(() => parseAnvilUri("anvil://host:70000/db")).toThrow(/Invalid port/);
    expect(() => parseAnvilUri("anvil://host:0/db")).toThrow(/Invalid port/);
  });
});

describe("buildBaseUrl", () => {
  it("builds an http:// URL when tls=false", () => {
    expect(
      buildBaseUrl({
        tls: false,
        host: "localhost",
        port: 7474,
        database: undefined,
        username: undefined,
        password: undefined,
      }),
    ).toBe("http://localhost:7474");
  });

  it("builds an https:// URL when tls=true", () => {
    expect(
      buildBaseUrl({
        tls: true,
        host: "db.example.com",
        port: 8443,
        database: undefined,
        username: undefined,
        password: undefined,
      }),
    ).toBe("https://db.example.com:8443");
  });
});
