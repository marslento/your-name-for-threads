import { readFileSync } from "node:fs";
import { createServer } from "node:https";
import { join } from "node:path";

// A stand-in for every host the probe visits. Nothing here talks to the real Threads.
// It needs key.pem and cert.pem from PROBE_CERT_DIR (see README.md); they are never kept in the repository.
const dir = process.env.PROBE_CERT_DIR;
if (!dir) throw new Error("Set PROBE_CERT_DIR to a directory holding key.pem and cert.pem (see README.md).");

const server = createServer({ key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) }, (req, res) => {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(`<!doctype html><title>probe ${req.headers.host}</title><h1>${req.headers.host}${req.url}</h1>`);
});
server.listen(8443, "127.0.0.1", () => console.log("probe server on 8443"));
