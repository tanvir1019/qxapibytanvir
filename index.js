// Quotex data store on Cloudflare D1. Day-packed rows keep D1 writes low (free tier: 100k rows/day).
const KEEP_DAYS = 30;
const API_KEY = "7c4e6b5db0f075f4b6c5104bb5d6e67e";
let ready = false;
async function init(env) {
  if (ready) return;
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS candles_day(pair TEXT, day INTEGER, data TEXT, mask TEXT, PRIMARY KEY(pair,day)) WITHOUT ROWID"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS payouts_day(pair TEXT, day INTEGER, data TEXT, PRIMARY KEY(pair,day)) WITHOUT ROWID"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS live(k TEXT PRIMARY KEY, data TEXT, ts INTEGER) WITHOUT ROWID"),
  ]);
  ready = true;
}
const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });
const dayOf = (ts) => Math.floor(ts / 86400);
const dayStr = (d) => new Date(d * 86400000).toISOString().slice(0, 10);

async function ingest(env, body) {
  const jobs = [];
  for (const kind of ["candles", "payouts"])
    for (const [pair, rows] of Object.entries(body[kind] || {})) {
      const g = {};
      for (const r of rows) (g[dayOf(r[0])] ||= []).push(r);
      for (const [d, rs] of Object.entries(g)) jobs.push({ kind, pair, day: +d, rs });
    }
  if (!jobs.length) return { saved: 0 };
  const reads = await env.DB.batch(jobs.map((j) =>
    env.DB.prepare(`SELECT data FROM ${j.kind}_day WHERE pair=? AND day=?`).bind(j.pair, j.day)));
  const writes = jobs.map((j, i) => {
    const old = reads[i].results[0] ? JSON.parse(reads[i].results[0].data) : [];
    const m = new Map(old.map((r) => [r[0], r]));
    for (const r of j.rs) m.set(r[0], r);
    const arr = [...m.values()].sort((a, b) => a[0] - b[0]);
    if (j.kind === "payouts")
      return env.DB.prepare("INSERT OR REPLACE INTO payouts_day VALUES(?,?,?)").bind(j.pair, j.day, JSON.stringify(arr));
    const mask = new Array(1440).fill("0");
    for (const r of arr) mask[Math.floor((r[0] - j.day * 86400) / 60)] = "1";
    return env.DB.prepare("INSERT OR REPLACE INTO candles_day VALUES(?,?,?,?)").bind(j.pair, j.day, JSON.stringify(arr), mask.join(""));
  });
  await env.DB.batch(writes);
  return { saved: jobs.length };
}

async function gaps(env, pair, days) {
  const now = Math.floor(Date.now() / 1000), today = dayOf(now), from = today - days + 1;
  const { results } = await env.DB.prepare("SELECT day,mask FROM candles_day WHERE pair=? AND day>=?").bind(pair, from).all();
  const have = Object.fromEntries(results.map((r) => [r.day, r.mask]));
  const out = [];
  for (let d = from; d <= today; d++) {
    const limit = d === today ? Math.floor((now - d * 86400) / 60) : 1440;
    const mask = have[d] || "0".repeat(1440);
    let miss = 0;
    for (let i = 0; i < limit; i++) if (mask[i] === "0") miss++;
    if (miss) out.push({ day: dayStr(d), day_no: d, missing: miss });
  }
  return { pair, gaps: out };
}

async function rows(env, table, pair, days) {
  const from = dayOf(Date.now() / 1000) - days + 1;
  const { results } = await env.DB.prepare(`SELECT data FROM ${table}_day WHERE pair=? AND day>=? ORDER BY day`).bind(pair, from).all();
  return results.flatMap((r) => JSON.parse(r.data));
}

function agg(c, tf) {
  if (tf <= 1) return c;
  const out = [], s = tf * 60;
  for (const r of c) {
    const b = Math.floor(r[0] / s) * s, l = out[out.length - 1];
    if (l && l[0] === b) { l[2] = Math.max(l[2], r[2]); l[3] = Math.min(l[3], r[3]); l[4] = r[4]; }
    else out.push([b, r[1], r[2], r[3], r[4]]);
  }
  return out;
}

export default {
  async fetch(req, env) {
    const t0 = Date.now(), u = new URL(req.url), q = u.searchParams, p = u.pathname;
    try {
      if (req.method === "OPTIONS") return J({});
      await init(env);
      if (p === "/health") return J({ ok: true });
      if (req.method === "POST") {
        if (req.headers.get("x-api-key") !== API_KEY) return J({ error: "unauthorized" }, 401);
        if (p === "/ingest") return J(await ingest(env, await req.json()));
        if (p === "/live") {
          await env.DB.prepare("INSERT OR REPLACE INTO live VALUES('all',?,?)").bind(JSON.stringify(await req.json()), Date.now()).run();
          return J({ ok: true });
        }
      }
      if (p === "/api/v1/live/all" || p === "/api/v1/payout") {
        const r = await env.DB.prepare("SELECT data,ts FROM live WHERE k='all'").first();
        if (!r) return J({ error: "no live data yet" }, 404);
        const d = JSON.parse(r.data);
        return J({ ...(p === "/api/v1/payout" ? { payout: d.payout } : { live: d.live, payout: d.payout }), age_ms: Date.now() - r.ts, execution_time: (Date.now() - t0) / 1000 });
      }
      const pair = (q.get("pair") || "").toUpperCase(), days = Math.min(+q.get("days") || 1, KEEP_DAYS);
      if (p === "/api/v1/gaps") return J(await gaps(env, pair, days));
      if (p === "/api/v1/candles") {
        const c = agg(await rows(env, "candles", pair, days), +q.get("tf") || 1);
        return J({ pair, count: c.length, candles: c, execution_time: (Date.now() - t0) / 1000 });
      }
      if (p === "/api/v1/payouts") {
        const r = await rows(env, "payouts", pair, days);
        return J({ pair, count: r.length, payouts: r, execution_time: (Date.now() - t0) / 1000 });
      }
      return J({ error: "not found" }, 404);
    } catch (e) { return J({ error: String(e) }, 500); }
  },
  async scheduled(_, env) {
    const old = dayOf(Date.now() / 1000) - KEEP_DAYS;
    await env.DB.batch([env.DB.prepare("DELETE FROM candles_day WHERE day<?").bind(old), env.DB.prepare("DELETE FROM payouts_day WHERE day<?").bind(old)]);
  },
};
