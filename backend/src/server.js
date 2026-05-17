const http = require("http");
const fs = require("fs");
const path = require("path");
const { loadEnv } = require("./env");

loadEnv();

const { ensureStore } = require("./store/store");
const { route } = require("./routes");

const PORT = Number(process.env.PORT || 4000);
const HOST = process.env.HOST || "127.0.0.1";
const DATA_DIR = path.join(__dirname, "..", "data");

function send(res, status, payload, headers = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS",
    ...headers
  });
  res.end(body);
}

ensureStore();
fs.mkdirSync(path.join(DATA_DIR, "generated"), { recursive: true });

const server = http.createServer((req, res) => {
  route(req, res).catch(error => {
    send(res, 500, { error: "INTERNAL_ERROR", message: error.message || "服务异常" });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Virtual Try-On backend is running at http://${HOST}:${PORT}`);
});
