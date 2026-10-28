// سيرفر تجريبي للتنبيه: بيستقبل حدث الفرملة وبيبعت التنبيه للعربيات اللي وراه.
// بدون مكتبات خارجية. كل البيانات في الذاكرة بس، ومفيش تخزين للمسارات.
const http = require("http");

const PORT = process.env.PORT || 8080;
const RANGE_M = 500;        // أقصى مسافة للتنبيه
const HEADING_TOL = 30;     // أقصى فرق في الاتجاه (درجة)
const CLIENT_TTL_MS = 30000; // العميل بيتشال لو ما بعتش موقعه ٣٠ ثانية
const DEDUPE_MS = 60000;    // نفس الحدث ما يتبعتش مرتين خلال دقيقة

const clients = new Map();  // id -> { res, lat, lng, heading, seen }
const seenEvents = new Map(); // eventId -> time

function metersBetween(a, b) {
  const dy = (b.lat - a.lat) * 110540;
  const dx = (b.lng - a.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180);
  return { dx, dy, dist: Math.hypot(dx, dy) };
}

function angleDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// هل العميل ده ورا العربية اللي فرملت؟ (على نفس الاتجاه، وفي نفس المسار تقريباً)
function isBehind(brake, other) {
  const { dx, dy, dist } = metersBetween(brake, other);
  if (dist === 0 || dist > RANGE_M) return null;
  const rad = (brake.heading * Math.PI) / 180;
  const forward = dx * Math.sin(rad) + dy * Math.cos(rad); // موجب = قدام
  if (forward >= 0) return null;                          // مش ورا
  if (angleDiff(brake.heading, other.heading) > HEADING_TOL) return null;
  return Math.round(dist);
}

function pushTo(client, event, data) {
  client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function handleBrake(body) {
  const { id, eventId, lat, lng, heading } = body;
  if (!id || !eventId || typeof lat !== "number" || typeof lng !== "number") return { ok: false, reason: "bad input" };
  if (seenEvents.has(eventId)) return { ok: true, sent: 0, duplicate: true };
  seenEvents.set(eventId, Date.now());
  const brake = { lat, lng, heading };
  let sent = 0;
  for (const [otherId, c] of clients) {
    if (otherId === id) continue;
    const distance = isBehind(brake, c);
    if (distance === null) continue;
    pushTo(c, "warn", { eventId, distance });
    sent++;
  }
  return { ok: true, sent };
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; if (raw.length > 4096) req.destroy(); });
    req.on("end", () => { try { resolve(JSON.parse(raw || "{}")); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "GET" && url.pathname === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true, clients: clients.size }));
  }

  // اتصال العميل: stream بيستقبل التنبيهات. بيسجل موقعه في الأول.
  if (req.method === "GET" && url.pathname === "/events") {
    const id = url.searchParams.get("id");
    if (!id) { res.writeHead(400); return res.end("missing id"); }
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    res.write("retry: 2000\n\n");
    clients.set(id, {
      res,
      lat: Number(url.searchParams.get("lat")),
      lng: Number(url.searchParams.get("lng")),
      heading: Number(url.searchParams.get("heading")),
      seen: Date.now(),
    });
    // نبضة كل ٢٠ ثانية عشان الاتصال ما يقفلش على الاستضافة
    const hb = setInterval(() => res.write(": ping\n\n"), 20000);
    req.on("close", () => { clearInterval(hb); clients.delete(id); });
    return;
  }

  // تحديث موقع العميل
  if (req.method === "POST" && url.pathname === "/position") {
    try {
      const { id, lat, lng, heading } = await readBody(req);
      const c = clients.get(id);
      if (!c) { res.writeHead(404); return res.end("not connected"); }
      Object.assign(c, { lat, lng, heading, seen: Date.now() });
      res.writeHead(200); return res.end("ok");
    } catch { res.writeHead(400); return res.end("bad json"); }
  }

  // حدث فرملة قوية
  if (req.method === "POST" && url.pathname === "/brake") {
    try {
      const result = handleBrake(await readBody(req));
      res.writeHead(result.ok ? 200 : 400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify(result));
    } catch { res.writeHead(400); return res.end("bad json"); }
  }

  // صفحة الموقع نفسها
  if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
    return require("fs").readFile(require("path").join(__dirname, "index.html"), (err, data) => {
      if (err) { res.writeHead(500); return res.end("index.html missing"); }
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(data);
    });
  }

  res.writeHead(404); res.end("not found");
});

// تنظيف دوري: العملاء القدام والرسايل القديمة
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of clients) {
    if (now - c.seen > CLIENT_TTL_MS) { c.res.end(); clients.delete(id); }
  }
  for (const [eid, t] of seenEvents) {
    if (now - t > DEDUPE_MS) seenEvents.delete(eid);
  }
}, 5000).unref();

server.listen(PORT, () => console.log(`ghost-jam server on :${PORT}`));
