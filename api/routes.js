// Vercel serverless function: GET /api/routes?from=SYD
// Needs the AIRLABS_API_KEY environment variable (set it in Vercel, never in the repo).
const BASE = "https://airlabs.co/api/v9";
const regions = new Intl.DisplayNames(["en"], { type: "region" });
const cache = globalThis.__airports || (globalThis.__airports = {});

async function call(path, params) {
  const u = new URL(BASE + path);
  for (const k in params) u.searchParams.set(k, params[k]);
  u.searchParams.set("api_key", process.env.AIRLABS_API_KEY);
  const r = await fetch(u);
  if (!r.ok) throw new Error("AirLabs HTTP " + r.status);
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || "AirLabs error");
  return j.response !== undefined ? j.response : j;
}

async function airport(code) {
  if (cache[code]) return cache[code];
  const a = await call("/airports", { iata_code: code });
  const x = Array.isArray(a) ? a[0] : a;
  if (!x || x.lat == null || x.lng == null) return null;
  let country = "";
  try { country = x.country_code ? regions.of(x.country_code) : ""; } catch (e) {}
  return (cache[code] = { name: x.city || x.name || code, country, lat: x.lat, lng: x.lng });
}

module.exports = async (req, res) => {
  const from = String(req.query.from || "").toUpperCase();
  if (!/^[A-Z]{3}$/.test(from)) return res.status(400).json({ error: "bad_airport" });
  if (!process.env.AIRLABS_API_KEY) return res.status(503).json({ error: "no_key" });
  try {
    const flights = await call("/routes", { dep_iata: from });
    const by = {};
    for (const f of flights) {
      if (!f.arr_iata || !f.duration || !f.airline_iata) continue;
      const o = by[f.arr_iata] || (by[f.arr_iata] = { d: [], al: {} });
      o.d.push(f.duration);
      o.al[f.airline_iata] = (o.al[f.airline_iata] || 0) + 1;
    }
    const codes = Object.keys(by).filter(c => c !== from);
    const info = {};
    for (let i = 0; i < codes.length; i += 8)
      await Promise.all(codes.slice(i, i + 8).map(async c => { info[c] = await airport(c).catch(() => null); }));
    const routes = codes.filter(c => info[c]).map(c => {
      const d = by[c].d.sort((a, b) => a - b);
      const al = Object.entries(by[c].al).sort((a, b) => b[1] - a[1]).map(e => e[0]);
      return { c, ...info[c], m: d[d.length >> 1], al };
    });
    res.setHeader("Cache-Control", "s-maxage=86400, stale-while-revalidate=604800");
    res.status(200).json({ source: "airlabs", from, routes });
  } catch (e) {
    res.status(502).json({ error: "upstream", message: e.message });
  }
};
