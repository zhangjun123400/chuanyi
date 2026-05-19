const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { loadEnv } = require("./env");

loadEnv();

// ── v2.0: JWT_SECRET initialization ──

if (!process.env.JWT_SECRET) {
  const secret = crypto.randomBytes(32).toString("hex");
  const envPath = path.join(__dirname, "..", "..", ".env");
  const line = `\n# JWT secret (auto-generated)\nJWT_SECRET=${secret}\n`;
  fs.appendFileSync(envPath, line);
  process.env.JWT_SECRET = secret;
  console.log("JWT_SECRET 已自动生成并写入 .env");
}

// v2.0: rate limiting (imported from separate module to avoid circular deps)
const { checkRateLimit, recordRateLimit } = require("./rate-limiter");

const { ensureStore, readStore, writeStore, now, addEvent } = require("./store/store");
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
fs.mkdirSync(path.join(DATA_DIR, "uploads"), { recursive: true });
fs.mkdirSync(path.join(DATA_DIR, "models"), { recursive: true });

// Cancel orphaned tasks from previous server run
(function recoverOrphanedTasks() {
  const store = readStore();
  const terminalStatuses = ["completed", "partial_failed", "failed", "cancelled"];
  const orphaned = store.tasks.filter(t => !terminalStatuses.includes(t.status));
  if (!orphaned.length) return;
  console.log(`Recovering ${orphaned.length} orphaned task(s) from previous run...`);
  orphaned.forEach(t => {
    t.status = "cancelled";
    t.progress = 100;
    t.current_stage = "cancelled";
    t.message = "服务器重启，进行中任务已自动取消。额度已退回。";
    t.updated_at = now();
    addEvent(store, t.id, "cancelled", 100, t.message);
    const log = store.credit_logs.find(l => l.task_id === t.id && l.reason === "precharge");
    if (log && log.status === "reserved") {
      log.status = "refunded";
      const taskUser = store.users.find(u => u.id === t.user_id);
      if (taskUser) {
        taskUser.credit_balance += Math.abs(log.amount);
      }
    }
  });
  writeStore(store);
  console.log("Orphaned task recovery complete.");
})();

const server = http.createServer((req, res) => {
  route(req, res).catch(error => {
    send(res, 500, { error: "INTERNAL_ERROR", message: error.message || "服务异常" });
  });
});

server.listen(PORT, HOST, () => {
  console.log(`Virtual Try-On backend is running at http://${HOST}:${PORT}`);
});

module.exports = { send, checkRateLimit, recordRateLimit };
