// اختبار: عربية فرملت، والتنبيه لازم يوصل للعربية اللي ورا بس، مش للي قدام ولا للبعيدة ولا للعكسية.
const BASE = process.env.BASE || "http://localhost:8090";

const cars = {
  A: { lat: 25.2, lng: 55.27, heading: 0 },      // العربية اللي فرملت (ماشية شمال)
  B: { lat: 25.199, lng: 55.27, heading: 0 },    // ورا A بحوالي 111 م -> لازم تتنبه
  C: { lat: 25.195, lng: 55.27, heading: 0 },    // ورا A بحوالي 555 م -> بعيدة، ما تتنبهش
  D: { lat: 25.201, lng: 55.27, heading: 0 },    // قدام A -> ما تتنبهش
  E: { lat: 25.199, lng: 55.27, heading: 180 },  // ورا بس عكس الاتجاه -> ما تتنبهش
};

const received = {};

async function connect(id) {
  const c = cars[id];
  const url = `${BASE}/events?id=${id}&lat=${c.lat}&lng=${c.lng}&heading=${c.heading}`;
  const ctrl = new AbortController();
  const res = await fetch(url, { signal: ctrl.signal });
  received[id] = [];
  (async () => {
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf("\n\n")) !== -1) {
          const block = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = block.match(/^event: (.+)$/m);
          const data = block.match(/^data: (.+)$/m);
          if (ev && data) received[id].push({ event: ev[1], data: JSON.parse(data[1]) });
        }
      }
    } catch { /* stream closed */ }
  })();
  return ctrl;
}

async function main() {
  const controllers = {};
  for (const id of Object.keys(cars)) controllers[id] = await connect(id);
  await new Promise((r) => setTimeout(r, 300));

  const body = { id: "A", eventId: "ev-1", ...cars.A };
  const r1 = await fetch(`${BASE}/brake`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  const j1 = await r1.json();
  console.log("first brake:", j1);

  const r2 = await fetch(`${BASE}/brake`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  console.log("same event again:", await r2.json());

  await new Promise((r) => setTimeout(r, 300));
  let pass = true;
  for (const id of Object.keys(cars)) {
    const warns = received[id].filter((m) => m.event === "warn");
    const expected = id === "B";
    const got = warns.length > 0;
    const ok = got === expected;
    if (!ok) pass = false;
    console.log(`${id}: warned=${got} expected=${expected} ${ok ? "OK" : "FAIL"}`, warns[0] ? `distance=${warns[0].data.distance}m` : "");
  }
  console.log(pass && j1.sent === 1 ? "RESULT: PASS" : "RESULT: FAIL");

  for (const c of Object.values(controllers)) c.abort();
  process.exit(pass && j1.sent === 1 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
