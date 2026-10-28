# Phone / Local PC -> Cloudflare sync.
import os, time, requests, threading

os.environ.setdefault("CF_URL", "https://qxapibytanvir.tanvirsk2244.workers.dev")
os.environ.setdefault("CF_KEY", "7c4e6b5db0f075f4b6c5104bb5d6e67e")

LOCAL = os.getenv("LOCAL", "http://127.0.0.1:8000")
CF = os.environ["CF_URL"].rstrip("/")
KEY = os.environ["CF_KEY"]
done = {}  # (pair, day) -> missing count already pushed

def local(path, **p):
    r = requests.get(LOCAL + path, params=p, timeout=90)
    r.raise_for_status()
    return r.json()

def items(j):
    if isinstance(j, list): return j
    for k in ("candles", "data", "history", "series", "payouts", "pairs", "items"):
        if isinstance(j.get(k), list): return j[k]
    for v in j.values():
        if isinstance(v, list) and v: return v
    return []

def sec(t):
    if isinstance(t, str): return int(__import__("datetime").datetime.fromisoformat(t.replace("Z", "+00:00")).timestamp())
    t = int(t); return t // 1000 if t > 1e11 else t

def cndl(x):
    if isinstance(x, dict):
        g = lambda *k: next(x[a] for a in k if a in x)
        return [sec(g("time", "t", "ts", "timestamp")), g("open", "o"), g("high", "h"), g("low", "l"), g("close", "c")]
    return [sec(x[0]), *x[1:5]]

def payo(x):
    g = lambda *k: next((x[a] for a in k if a in x), None)
    pct = g("payout", "pct", "percent", "p"); op = g("open", "is_open", "o")
    return [sec(g("time", "t", "ts", "timestamp")) // 60 * 60, pct, 1 if op is None else int(bool(op))]

def push(body):
    r = requests.post(CF + "/ingest", json=body, headers={"x-api-key": KEY}, timeout=90)
    r.raise_for_status()

def pairs():
    out = []
    for x in items(local("/api/v1/pairs")):
        n = x if isinstance(x, str) else (x.get("pair") or x.get("name") or x.get("code"))
        if n: out.append(n)
    return out

def get_c(pair, days): return [cndl(x) for x in items(local("/api/v1/history", pair=pair, days=days, tf="M1"))]
def get_p(pair, days):
    try: return [payo(x) for x in items(local("/api/v1/payouts/series", pair=pair, res="1m", days=days))]
    except Exception: return []

def live(pair):
    now = time.time(); cut = now - 1800
    push({"candles": {pair: [c for c in get_c(pair, 1) if c[0] >= cut]},
          "payouts": {pair: [p for p in get_p(pair, 1) if p[0] >= cut]}})

def fill(pair):
    g = requests.get(CF + "/api/v1/gaps", params={"pair": pair, "days": 30}, timeout=60).json().get("gaps", [])
    today = int(time.time() // 86400)
    for x in g:
        if done.get((pair, x["day_no"])) == x["missing"]: continue
        ago = today - x["day_no"] + 1
        cs = [c for c in get_c(pair, ago) if c[0] // 86400 == x["day_no"]]
        ps = [p for p in get_p(pair, ago) if p[0] // 86400 == x["day_no"]]
        push({"candles": {pair: cs}, "payouts": {pair: ps}})
        done[(pair, x["day_no"])] = x["missing"]

def live_loop():
    while True:
        try:
            body = {"live": local("/api/v1/live/all"), "payout": local("/api/v1/payout")}
            requests.post(CF + "/live", json=body, headers={"x-api-key": KEY}, timeout=20)
        except Exception as e: print("live-push", e)
        time.sleep(5)

threading.Thread(target=live_loop, daemon=True).start()

last_fill = 0
while True:
    try:
        ps = pairs()
        for p in ps:
            try: live(p)
            except Exception as e: print("live", p, e)
        if time.time() - last_fill > 3600:
            for p in ps:
                try: fill(p)
                except Exception as e: print("fill", p, e)
            last_fill = time.time()
        print(time.strftime("%H:%M:%S"), "synced", len(ps))
    except Exception as e: print("loop", e)
    time.sleep(600)
