import { describe, expect, it } from "vitest";
import { assertAgentEndpoint, checkAgentEndpoint } from "./url.js";

describe("checkAgentEndpoint", () => {
  it("allows normal public http(s) endpoints", () => {
    expect(checkAgentEndpoint("https://api.databot.example/feed").ok).toBe(true);
    expect(checkAgentEndpoint("http://93.184.216.34:8080/x").ok).toBe(true);
  });

  it("rejects non-http schemes", () => {
    for (const u of ["file:///etc/passwd", "ftp://x.example", "gopher://x", "javascript:alert(1)"]) {
      expect(checkAgentEndpoint(u).ok).toBe(false);
    }
  });

  it("rejects malformed URLs and embedded credentials", () => {
    expect(checkAgentEndpoint("not a url").ok).toBe(false);
    expect(checkAgentEndpoint("http://user:pass@example.com/").ok).toBe(false);
  });

  it("rejects loopback and internal hostnames", () => {
    for (const u of [
      "http://localhost:4021/x",
      "http://foo.localhost/x",
      "http://printer.local/x",
      "http://db.internal/x",
    ]) {
      expect(checkAgentEndpoint(u).ok).toBe(false);
    }
  });

  it("rejects private IPv4 literals", () => {
    for (const u of [
      "http://127.0.0.1/x",
      "http://10.0.0.5/x",
      "http://192.168.1.1/x",
      "http://172.16.9.9/x",
      "http://169.254.169.254/latest/meta-data", // cloud metadata
      "http://100.64.0.1/x",
      "http://0.0.0.0/x",
    ]) {
      expect(checkAgentEndpoint(u).ok).toBe(false);
    }
  });

  it("rejects private IPv6 literals", () => {
    for (const u of ["http://[::1]/x", "http://[fe80::1]/x", "http://[fd00::1]/x", "http://[::ffff:127.0.0.1]/x"]) {
      expect(checkAgentEndpoint(u).ok).toBe(false);
    }
  });

  it("allowPrivate permits localhost for the local demo network", () => {
    expect(checkAgentEndpoint("http://localhost:4021/x", { allowPrivate: true }).ok).toBe(true);
    expect(checkAgentEndpoint("file:///etc/passwd", { allowPrivate: true }).ok).toBe(false); // scheme still enforced
  });

  it("assert variant throws with the reason", () => {
    expect(() => assertAgentEndpoint("http://127.0.0.1/x")).toThrow(/private IPv4/);
    expect(() => assertAgentEndpoint("https://ok.example/x")).not.toThrow();
  });
});
