// E2E fixture server for ext267 / cliget.
// Serves download-shaped responses so the extension's webRequest pipeline
// (main_frame / sub_frame, statusCode 200, !fromCache) actually fires.
import http from "node:http";

const PORT = Number(process.env.E2E_PORT || 8799);
const PDF = Buffer.from("%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n".repeat(60), "utf8");
const BIN = Buffer.alloc(9000, 0x7a);

const routes = {
  attachment: {
    type: "application/pdf",
    disp: `attachment; filename="quarterly-report.pdf"`,
    body: PDF
  },
  cjk: {
    type: "application/pdf",
    disp: `attachment; filename="fallback.pdf"; filename*=UTF-8''%E6%B5%8B%E8%AF%95%E6%96%87%E4%BB%B6-%E2%9C%93.pdf`,
    body: PDF
  },
  noheader: {
    type: "application/octet-stream",
    disp: null,
    body: BIN
  },
  weird: {
    type: "application/zip",
    disp: `attachment; filename="O'Brien's file [1].zip"`,
    body: BIN
  },
  glob: {
    type: "application/pdf",
    disp: `attachment; filename="glob[1]{2}.pdf"`,
    body: PDF
  },
  inline: {
    type: "text/html; charset=utf-8",
    disp: null,
    body: Buffer.from("<!doctype html><title>inline</title><body>not a download</body>", "utf8")
  },
  iframe: {
    type: "text/html; charset=utf-8",
    disp: null,
    body: Buffer.from(
      '<!doctype html><meta charset="utf-8"><title>iframe host</title>' +
        '<body style="font:14px monospace;background:#111;color:#0f0">sub_frame fixture' +
        '<iframe src="/dl/noheader?frame=1" width="320" height="120"></iframe>' +
        '<img src="/dl/attachment?asimg=1" width="1" height="1" alt="">' +
        "</body>",
      "utf8"
    )
  },
  image: {
    type: "image/png",
    disp: `attachment; filename="image-attachment.png"`,
    body: BIN
  }
};

const index = `<!doctype html><meta charset="utf-8"><title>e2e fixture host</title>
<body style="font:14px monospace;background:#111;color:#0f0">
<h2>ext267 cliget e2e fixtures</h2>
<ul>
${Object.keys(routes)
  .map(
    (k) => `<li><a href="/dl/${k}?n=1">/dl/${k}</a> — ${routes[k].disp ?? "(no disposition)"} · ${routes[k].type}</li>`
  )
  .join("\n")}
</ul>
`;

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const seg = url.pathname.split("/").filter(Boolean);
  const key = seg[0] === "dl" ? seg[1] : seg.length === 0 ? "index" : seg[0];
  if (key === "index") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(index);
    return;
  }
  if (key === "redir") {
    res.writeHead(302, { location: "/dl/attachment?n=99" });
    res.end();
    return;
  }
  const r = routes[key];
  if (!r) {
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
    return;
  }
  const headers = {
    "content-type": r.type,
    "content-length": String(r.body.length),
    "cache-control": "no-store, must-revalidate",
    "access-control-allow-origin": "*"
  };
  if (r.disp) headers["content-disposition"] = r.disp;
  res.writeHead(200, headers);
  res.end(req.method === "HEAD" ? undefined : r.body);
});

server.listen(PORT, "127.0.0.1", () => {
  process.stdout.write(`fixture server listening on http://127.0.0.1:${PORT}\n`);
});
