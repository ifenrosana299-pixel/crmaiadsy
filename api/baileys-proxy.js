// api/baileys-proxy.js — proxy frontend → VPS Baileys
const BAILEYS_URL   = process.env.BAILEYS_URL || 'http://13.140.178.4:3000';
const BAILEYS_SECRET = process.env.WEBHOOK_SECRET || 'adsysukses2026';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const { path, session_id, ...queryRest } = req.query;
  if (!path) return res.status(400).json({ error: 'path required' });

  const qs = new URLSearchParams(queryRest);
  const url = `${BAILEYS_URL}${path}${qs.toString() ? '?' + qs : ''}`;

  try {
    // Inject secret + session_id ke body untuk POST
    let body = undefined;
    if (['POST','PUT','PATCH'].includes(req.method)) {
      body = JSON.stringify({
        secret: BAILEYS_SECRET,
        session_id: session_id || '',
        ...req.body,
      });
    }

    const upstream = await fetch(url, {
      method: req.method,
      headers: { 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(25000)
    });
    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return res.status(upstream.status).json(data);
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
