// Login rate limiting counters (in-memory, reset on restart)
// Separated from server.js to avoid circular dependency with routes/index.js

const rateLimitCounters = new Map();

function checkRateLimit(ip, email) {
  const now = Date.now();
  const windowMs = 60 * 1000;

  const ipKey = `ip:${ip}`;
  const ipEntry = rateLimitCounters.get(ipKey);
  if (ipEntry && now - ipEntry.windowStart < windowMs) {
    if (ipEntry.count >= 5) return { limited: true, retryAfter: Math.ceil((ipEntry.windowStart + windowMs - now) / 1000) };
  }

  const emailKey = `email:${email}`;
  const emailEntry = rateLimitCounters.get(emailKey);
  if (emailEntry && now - emailEntry.windowStart < windowMs) {
    if (emailEntry.count >= 10) return { limited: true, retryAfter: Math.ceil((emailEntry.windowStart + windowMs - now) / 1000) };
  }

  return { limited: false };
}

function recordRateLimit(ip, email) {
  const now = Date.now();
  const windowMs = 60 * 1000;

  for (const key of [`ip:${ip}`, `email:${email}`]) {
    const entry = rateLimitCounters.get(key);
    if (!entry || now - entry.windowStart >= windowMs) {
      rateLimitCounters.set(key, { count: 1, windowStart: now });
    } else {
      entry.count++;
    }
  }
}

// Clean expired entries periodically
setInterval(() => {
  const now = Date.now();
  const windowMs = 60 * 1000;
  for (const [key, entry] of rateLimitCounters) {
    if (now - entry.windowStart >= windowMs) rateLimitCounters.delete(key);
  }
}, 60 * 1000);

module.exports = { checkRateLimit, recordRateLimit };
