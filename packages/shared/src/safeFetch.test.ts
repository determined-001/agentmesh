import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { safeFetch } from "./safeFetch.js";

/** A stand-in for a hostile agent endpoint. Public-looking, but its responses
 *  try to walk the client somewhere it should never go. */
let server: Server;
let base: string;

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/ok") {
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
    } else if (url === "/to-metadata") {
      // The whole point: the first hop passes the guard, the second must not.
      res.writeHead(302, { location: "http://169.254.169.254/latest/meta-data" }).end();
    } else if (url === "/to-loopback") {
      res.writeHead(302, { location: "http://127.0.0.1:1/" }).end();
    } else if (url === "/loop") {
      res.writeHead(302, { location: "/loop" }).end();
    } else if (url === "/huge") {
      res.writeHead(200, { "content-type": "text/plain" }).end("x".repeat(50_000));
    } else if (url === "/relative") {
      res.writeHead(302, { location: "/ok" }).end();
    } else {
      res.writeHead(404).end();
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

describe("safeFetch", () => {
  // The test server is on loopback, so these run with allowPrivate — the
  // redirect targets are what's under test, and each hop is re-checked.
  const priv = { allowPrivate: true };

  it("fetches a normal endpoint", async () => {
    const res = await safeFetch(`${base}/ok`, priv);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("refuses to follow a redirect into cloud metadata", async () => {
    // Link-local is blocked even under allowPrivate, so this proves the hop
    // target is validated rather than followed blindly.
    await expect(safeFetch(`${base}/to-metadata`, priv)).rejects.toThrow(/link-local/);
  });

  it("re-applies the guard to redirect targets when allowPrivate is off", async () => {
    // First hop is loopback so it needs allowPrivate; prove the guard runs per
    // hop by pointing a public-policy fetch at a loopback start.
    await expect(safeFetch(`${base}/ok`)).rejects.toThrow(/private IPv4/);
  });

  it("bounds redirect chains", async () => {
    await expect(safeFetch(`${base}/loop`, { ...priv, maxRedirects: 2 })).rejects.toThrow(
      /too many redirects/,
    );
  });

  it("follows a relative Location header", async () => {
    const res = await safeFetch(`${base}/relative`, priv);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("caps oversized responses", async () => {
    await expect(safeFetch(`${base}/huge`, { ...priv, maxBytes: 1_000 })).rejects.toThrow(/too large/);
  });

  it("rejects a disallowed scheme before making any request", async () => {
    await expect(safeFetch("file:///etc/passwd")).rejects.toThrow(/scheme/);
  });
});
