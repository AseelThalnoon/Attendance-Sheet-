// A static server for the repo root.
//
// The other browser suites load index.html over file://, which is fine for
// them: they measure layout after fixtures.js has unhidden the shell by hand,
// and never need app.js to have run. This suite is the opposite — it boots the
// real application against a scripted backend — and an ES module will not load
// from file:// at all. So it needs a real origin.
const http = require("http");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const TYPES = {
  ".html":"text/html; charset=utf-8", ".js":"text/javascript; charset=utf-8",
  ".mjs":"text/javascript; charset=utf-8", ".json":"application/json; charset=utf-8",
  ".css":"text/css; charset=utf-8", ".png":"image/png", ".webp":"image/webp",
  ".jpg":"image/jpeg", ".woff2":"font/woff2", ".svg":"image/svg+xml"
};

function start(){
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let rel = decodeURIComponent(req.url.split("?")[0]);
      if(rel === "/") rel = "/index.html";
      // Refuse to serve outside the repo: this is a test server, but it is
      // still a server, and ../../../etc/passwd is one string away.
      const file = path.normalize(path.join(ROOT, rel));
      if(!file.startsWith(ROOT)){ res.writeHead(403).end("no"); return; }
      fs.readFile(file, (err, buf) => {
        if(err){ res.writeHead(404).end("not found"); return; }
        res.writeHead(200, {"Content-Type": TYPES[path.extname(file)] || "application/octet-stream"});
        res.end(buf);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}`, close: () => server.close() });
    });
  });
}

module.exports = { start };
