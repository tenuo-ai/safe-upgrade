import { describe, expect, it } from "vitest";
import { isPrivateAddress, normalizeDocument } from "../src/releases.ts";

describe("address filtering", () => {
  it("treats internal and metadata addresses as private", () => {
    for (const address of [
      "127.0.0.1",
      "10.1.2.3",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.1.1",
      "169.254.169.254", // cloud instance metadata
      "100.64.0.1",
      "0.0.0.0",
      "224.0.0.1",
      "::1",
      "fe80::1",
      "fd00::1",
      "::ffff:127.0.0.1",
    ]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
  });

  it("allows ordinary public addresses", () => {
    for (const address of ["104.16.0.1", "8.8.8.8", "172.32.0.1", "2606:4700::1111"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });

  it("rejects anything that is not an IP address at all", () => {
    expect(isPrivateAddress("registry.npmjs.org")).toBe(true);
    expect(isPrivateAddress("")).toBe(true);
  });
});

describe("document normalization", () => {
  it("strips markup and script content from HTML release notes", () => {
    const html = "<h1>Breaking</h1><script>fetch('/steal')</script><p>Use <code>parse()</code> now.</p>";
    const text = normalizeDocument(html, "text/html");
    expect(text).not.toContain("<");
    expect(text).not.toContain("fetch('/steal')");
    expect(text).toContain("Breaking");
    expect(text).toContain("parse()");
  });

  it("leaves markdown and plain text untouched", () => {
    const markdown = "## Breaking\n\n- `parse()` replaces `read()`\n";
    expect(normalizeDocument(markdown, "text/markdown")).toBe(markdown);
  });
});
