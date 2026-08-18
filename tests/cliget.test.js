"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

// Load cliget.js into a sandboxed VM context.
// The file is a browser-targeted script, so we stub `browser` (for `ext`) and
// `window` (so the `_isBackground` block is skipped). Top-level `function`
// declarations become properties of the context and are returned for testing.
function loadCliget() {
  const source = fs.readFileSync(path.join(__dirname, "..", "plugins", "cliget.js"), "utf8");
  const sandbox = { browser: {}, window: {}, console };
  const context = vm.createContext(sandbox);
  vm.runInContext(source, context, { filename: "cliget.js" });
  return context;
}

const ctx = loadCliget();

function cliOpts(overrides) {
  return Object.assign({ cliTool: "curl", curlOptions: "", wgetOptions: "", aria2Options: "" }, overrides);
}

// ----------------------------------------------------------------
// escapeShellArg
// ----------------------------------------------------------------
test("escapeShellArg: single-quote mode (POSIX shell)", () => {
  assert.equal(ctx.escapeShellArg("abc"), "'abc'");
  assert.equal(ctx.escapeShellArg("O'Brien"), `'O'\\''Brien'`);
});

test("escapeShellArg: double-quote mode (cmd.exe)", () => {
  assert.equal(ctx.escapeShellArg("abc", true), '"abc"');
  assert.equal(ctx.escapeShellArg('a"b', true), '"a\\"b"');
  assert.equal(ctx.escapeShellArg("a\\b", true), '"a\\\\b"');
});

test("escapeShellArg: empty/falsy args", () => {
  assert.equal(ctx.escapeShellArg(""), "''");
  assert.equal(ctx.escapeShellArg("", true), "''");
  assert.equal(ctx.escapeShellArg(null), "''");
  assert.equal(ctx.escapeShellArg(undefined), "''");
});

// ----------------------------------------------------------------
// decodeHeaderValue
// ----------------------------------------------------------------
test("decodeHeaderValue: percent-encoded UTF-8 (CJK)", () => {
  assert.equal(ctx.decodeHeaderValue("%E6%B5%8B%E8%AF%95.txt"), "\u6d4b\u8bd5.txt");
});

test("decodeHeaderValue: mojibake UTF-8 bytes as chars", () => {
  // Raw UTF-8 bytes of "测试" re-interpreted as individual chars
  assert.equal(ctx.decodeHeaderValue("\u00e6\u00b5\u008b\u00e8\u00af\u0095"), "\u6d4b\u8bd5");
});

test("decodeHeaderValue: passes through plain ASCII", () => {
  assert.equal(ctx.decodeHeaderValue("plain.txt"), "plain.txt");
});

test("decodeHeaderValue: invalid sequences fall back to input", () => {
  assert.equal(ctx.decodeHeaderValue("%ZZ"), "%ZZ");
});

test("decodeHeaderValue: falsy input returned as-is", () => {
  assert.equal(ctx.decodeHeaderValue(null), null);
  assert.equal(ctx.decodeHeaderValue(undefined), undefined);
  assert.equal(ctx.decodeHeaderValue(""), "");
});

// ----------------------------------------------------------------
// getFilenameFromContentDisposition
// ----------------------------------------------------------------
test("getFilenameFromContentDisposition: filename* (RFC 5987, UTF-8)", () => {
  assert.equal(
    ctx.getFilenameFromContentDisposition("attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95.pdf"),
    "\u6d4b\u8bd5.pdf"
  );
});

test("getFilenameFromContentDisposition: quoted filename", () => {
  assert.equal(ctx.getFilenameFromContentDisposition('attachment; filename="report.pdf"'), "report.pdf");
});

test("getFilenameFromContentDisposition: escaped quotes in filename", () => {
  assert.equal(ctx.getFilenameFromContentDisposition('attachment; filename="a\\"b.pdf"'), 'a"b.pdf');
});

test("getFilenameFromContentDisposition: unquoted filename", () => {
  assert.equal(ctx.getFilenameFromContentDisposition("attachment; filename=report.pdf"), "report.pdf");
});

test("getFilenameFromContentDisposition: percent-encoded unquoted filename", () => {
  assert.equal(ctx.getFilenameFromContentDisposition("attachment; filename=caf%C3%A9.pdf"), "caf\u00e9.pdf");
});

test("getFilenameFromContentDisposition: no filename header", () => {
  assert.equal(ctx.getFilenameFromContentDisposition(null), null);
  assert.equal(ctx.getFilenameFromContentDisposition("attachment"), null);
});

// ----------------------------------------------------------------
// getFilenameFromUrl
// ----------------------------------------------------------------
test("getFilenameFromUrl: basic path", () => {
  assert.equal(ctx.getFilenameFromUrl("https://e.com/path/file.pdf"), "file.pdf");
});

test("getFilenameFromUrl: ignores query/hash", () => {
  assert.equal(ctx.getFilenameFromUrl("https://e.com/file.pdf?token=1&x=2"), "file.pdf");
  assert.equal(ctx.getFilenameFromUrl("https://e.com/file.pdf#frag"), "file.pdf");
});

test("getFilenameFromUrl: decodes percent-encoded names", () => {
  assert.equal(ctx.getFilenameFromUrl("https://e.com/file%20name.txt"), "file name.txt");
});

test("getFilenameFromUrl: invalid percent-encoding kept raw", () => {
  assert.equal(ctx.getFilenameFromUrl("https://e.com/%zz.bin"), "%zz.bin");
});

test("getFilenameFromUrl: no filename segment", () => {
  assert.equal(ctx.getFilenameFromUrl(""), "download");
  assert.equal(ctx.getFilenameFromUrl("https://e.com/dir/"), "download");
  assert.equal(ctx.getFilenameFromUrl("https://e.com/?a=1"), "download");
});

// ----------------------------------------------------------------
// toQueryString
// ----------------------------------------------------------------
test("toQueryString: scalar and array values", () => {
  assert.deepEqual(ctx.toQueryString({ a: "1", b: ["2", "3"] }), "a=1&b=2&b=3");
  assert.deepEqual(ctx.toQueryString({ a: 1 }), "a=1");
});

test("toQueryString: URL-encodes keys and values", () => {
  assert.deepEqual(ctx.toQueryString({ q: "hello world" }), "q=hello%20world");
  assert.deepEqual(ctx.toQueryString({ a: "x&y=z" }), "a=x%26y%3Dz");
});

test("toQueryString: empty input", () => {
  assert.deepEqual(ctx.toQueryString({}), "");
  assert.deepEqual(ctx.toQueryString({ a: [] }), "");
});

// ----------------------------------------------------------------
// escapeGlobbing
// ----------------------------------------------------------------
test("escapeGlobbing: escapes glob metacharacters", () => {
  assert.equal(ctx.escapeGlobbing("https://e.com/a[1].txt"), "https://e.com/a\\[1\\].txt");
  assert.equal(ctx.escapeGlobbing("https://e.com/{a,b}/x"), "https://e.com/\\{a,b\\}/x");
});

test("escapeGlobbing: leaves plain URLs unchanged", () => {
  assert.equal(ctx.escapeGlobbing("https://e.com/plain.txt"), "https://e.com/plain.txt");
});

// ----------------------------------------------------------------
// generateCurl
// ----------------------------------------------------------------
test("generateCurl: GET with UA/cookie/referer, skips content-length", () => {
  const headers = [
    { name: "User-Agent", value: "Mozilla/5.0" },
    { name: "Cookie", value: "session=abc123" },
    { name: "Referer", value: "https://referer.example.com/" },
    { name: "Content-Length", value: "1024" }
  ];
  const cmd = ctx.generateCurl("https://example.com/file.bin", "GET", headers, null, null, cliOpts());
  assert.equal(
    cmd,
    "curl --user-agent 'Mozilla/5.0' --cookie 'session=abc123' " +
      "--referer 'https://referer.example.com/' " +
      "'https://example.com/file.bin' --remote-name --remote-header-name"
  );
});

test("generateCurl: POST x-www-form-urlencoded body", () => {
  const headers = [{ name: "Content-Type", value: "application/x-www-form-urlencoded" }];
  const cmd = ctx.generateCurl(
    "https://e.com/submit",
    "POST",
    headers,
    { formData: { user: ["alice"], pass: ["s3cret"] } },
    null,
    cliOpts()
  );
  assert.equal(
    cmd,
    "curl --header 'Content-Type: application/x-www-form-urlencoded' " +
      "--request POST --data-urlencode 'user=alice' " +
      "--data-urlencode 'pass=s3cret' 'https://e.com/submit' " +
      "--remote-name --remote-header-name"
  );
});

test("generateCurl: multipart form truncates boundary in header", () => {
  const headers = [{ name: "Content-Type", value: "multipart/form-data; boundary=----8bba01" }];
  const cmd = ctx.generateCurl(
    "https://e.com/upload",
    "POST",
    headers,
    { formData: { field: ["value1"] } },
    null,
    cliOpts()
  );
  assert.equal(
    cmd,
    "curl --header 'Content-Type: multipart/form-data;' " +
      "--request POST --form-string 'field=value1' " +
      "'https://e.com/upload' --remote-name --remote-header-name"
  );
});

test("generateCurl: output filename + double-quote escaping", () => {
  const cmd = ctx.generateCurl("https://e.com/x.bin", "GET", [], null, "my file.bin", cliOpts({ doubleQuotes: true }));
  assert.equal(cmd, 'curl "https://e.com/x.bin" --output "my file.bin"');
});

test("generateCurl: escapes glob metacharacters in URL", () => {
  const cmd = ctx.generateCurl("https://e.com/a[1].txt", "GET", [], null, null, cliOpts());
  assert.equal(cmd, "curl 'https://e.com/a\\[1\\].txt' --remote-name --remote-header-name");
});

test("generateCurl: appends extra curl options last", () => {
  const cmd = ctx.generateCurl("https://e.com/x.bin", "GET", [], null, null, cliOpts({ curlOptions: "--insecure" }));
  assert.equal(cmd, "curl 'https://e.com/x.bin' --remote-name --remote-header-name --insecure");
});

// ----------------------------------------------------------------
// generateWget
// ----------------------------------------------------------------
test("generateWget: GET with output document", () => {
  const headers = [
    { name: "User-Agent", value: "Mozilla/5.0" },
    { name: "Referer", value: "https://referer.example.com/" },
    { name: "Content-Length", value: "1024" }
  ];
  const cmd = ctx.generateWget("https://example.com/file.pdf", "GET", headers, null, "file.pdf", cliOpts());
  assert.equal(
    cmd,
    "wget --user-agent 'Mozilla/5.0' " +
      "--referer 'https://referer.example.com/' " +
      "'https://example.com/file.pdf' --output-document 'file.pdf'"
  );
});

test("generateWget: POST body-data via query string", () => {
  const headers = [{ name: "Content-Type", value: "application/x-www-form-urlencoded" }];
  const cmd = ctx.generateWget(
    "https://e.com/submit",
    "POST",
    headers,
    { formData: { a: ["1"], b: ["2"] } },
    null,
    cliOpts()
  );
  assert.equal(
    cmd,
    "wget --header 'Content-Type: application/x-www-form-urlencoded' " +
      "--method POST --body-data 'a=1&b=2' 'https://e.com/submit'"
  );
});

test("generateWget: appends extra wget options last", () => {
  const cmd = ctx.generateWget(
    "https://e.com/x.bin",
    "GET",
    [],
    null,
    null,
    cliOpts({ wgetOptions: "--no-check-certificate" })
  );
  assert.equal(cmd, "wget 'https://e.com/x.bin' --no-check-certificate");
});

// ----------------------------------------------------------------
// generateAria2
// ----------------------------------------------------------------
test("generateAria2: GET with headers and out filename", () => {
  const headers = [
    { name: "Referer", value: "https://r.example.com/" },
    { name: "User-Agent", value: "UA/1.0" },
    { name: "X-Foo", value: "bar" }
  ];
  const cmd = ctx.generateAria2("https://e.com/file.iso", "GET", headers, null, "file.iso", cliOpts());
  assert.equal(
    cmd,
    "aria2c --referer 'https://r.example.com/' --user-agent 'UA/1.0' " +
      "--header 'X-Foo: bar' 'https://e.com/file.iso' --out 'file.iso'"
  );
});

test("generateAria2: appends extra aria2 options last", () => {
  const cmd = ctx.generateAria2(
    "https://e.com/x.bin",
    "GET",
    [],
    null,
    null,
    cliOpts({ aria2Options: "--max-connection-per-server=4" })
  );
  assert.equal(cmd, "aria2c 'https://e.com/x.bin' --max-connection-per-server=4");
});

test("generateAria2: rejects non-GET methods", () => {
  assert.throws(
    () => ctx.generateAria2("https://e.com/x.bin", "POST", [], null, null, cliOpts()),
    /Unsupported HTTP method/
  );
});

// ----------------------------------------------------------------
// generate dispatch
// ----------------------------------------------------------------
test("generate: dispatches to the selected CLI tool", () => {
  assert.match(ctx.generate("https://e.com/x", "GET", [], null, null, cliOpts({ cliTool: "curl" })), /^curl /);
  assert.match(ctx.generate("https://e.com/x", "GET", [], null, null, cliOpts({ cliTool: "wget" })), /^wget /);
  assert.match(ctx.generate("https://e.com/x", "GET", [], null, null, cliOpts({ cliTool: "aria2" })), /^aria2c /);
});

test("generate: unknown CLI tool throws", () => {
  assert.throws(
    () => ctx.generate("https://e.com/x", "GET", [], null, null, cliOpts({ cliTool: "unknown" })),
    /Unknown CLI tool/
  );
});
