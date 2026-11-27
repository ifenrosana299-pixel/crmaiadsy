// api/track-resi.js
// GET  /api/track-resi?resi=&ekspedisi=  → polling status dari Mengantar
// POST /api/track-resi (x-webhook-secret) → terima forward dari akuisisitracking webhook

const { trackShipment, trackPos } = require('../lib/mengantar');

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
const WEBHOOK_SECRET = process.env.TRACKING_WEBHOOK_SECRET || 'adsy-crm-track-2026';

async function sb(table, params = '', opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}${params ? '?' + params : ''}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || (opts.method === 'POST' ? 'return=representation' : 'return=minimal')
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await r.text();
  if (!r.ok) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
}

const COURIER_MAP = {
  'JNE': 'JNE', 'JNT': 'JT', 'JT': 'JT', 'J&T': 'JT',
  'SICEPAT': 'SiCepat', 'SICE': 'SiCepat',
  'ANTERAJA': 'anteraja', 'ANTER': 'anteraja',
  'NINJA': 'Ninja',
  'SAP': 'SAP',
  'LION': 'lion', 'LIONPARCEL': 'lion',
  'TIKI': 'tiki',
  'IDEXPRESS': 'iDexpress', 'IDEX': 'iDexpress',
  'REX': 'rex',
  'GRAB': 'grab',
  'GOJEK': 'gojek', 'GOSEND': 'gojek',
  'NINJAXPRESS': 'Ninja',
};

const RETUR_PATTERN   = /retur|dikembalikan|\brts\b|\brto\b|return to sender/i;
const PROBLEM_PATTERN = /gagal|kendala|bermasalah|tidak ditemukan|alamat tidak (lengkap|dikenal)|tidak ada orang|tidak ditempat|tidak dihuni|menunggu konfirmasi|disimpan di gudang|ditolak|pindah alamat|box undel/i;
const OTW_PATTERN     = /sedang diantar|dalam pengantaran|out for delivery|kurir menuju|\botw\b|akan dikirim ke alamat|with delivery courier|delivery courier|diantar ke alamat|on delivery|1st attempt|2nd attempt|percobaan/i;
const KOTA_PATTERN    = /kota tujuan|gudang tujuan|tiba di kota|received at destination|received at warehouse|process and forward|inbound|sti-dest/i;

function isPickupPhase(e) {
  return !!(e && e.code && /pickup/i.test(e.code));
}
function isSelfReceipt(e) {
  if (!e || !e.place) return false;
  const m = /diterima oleh\s+(.+)/i.exec(e.descOnly || '');
  if (!m) return false;
  const norm = s => (s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return norm(m[1]) === norm(e.place);
}

function mapTrackingStage(json) {
  if (!json || !json.success || !json.data) return { stage: 'DIKIRIM', step: 2 };
  const d = json.data;
  const history = Array.isArray(d.history) ? d.history : [];
  const cat = (d.statusCategory || d.status || '').toUpperCase();

  const entries = history.map(h => ({
    desc:     [h.desc, h.code].filter(Boolean).join(' '),
    descOnly: h.desc || '',
    code:     h.code || null,
    place:    h.counter_name || h.city_name || null,
    receivedBy: (h.receiver || '').trim() || null,
    group:    (h.type && h.type.group) || null,
    tag:      (h.type && h.type.tag) || null,
  }));

  const latest    = entries.length ? entries[entries.length - 1] : null;
  const latestD   = (latest && latest.desc || '').toLowerCase();

  // Retur
  if (cat.includes('RETUR') || cat.includes('RETURN') || entries.some(e => RETUR_PATTERN.test(e.desc))) {
    return { stage: 'RETUR', step: 4, detail: d };
  }
  // Sampai
  if (cat === 'DELIVERED' || (/diterima oleh|\bdelivered\b|\bpod\b/.test(latestD) && !isSelfReceipt(latest)) || (latest && latest.receivedBy)) {
    return { stage: 'SAMPAI', step: 5, detail: d };
  }
  // Bermasalah
  const hasStructProblem = entries.some(e => !isPickupPhase(e) && (e.group === 'UNDELIVERED' || e.tag === 'actionRequired'));
  if (hasStructProblem || entries.some(e => !isPickupPhase(e) && PROBLEM_PATTERN.test(e.desc))) {
    return { stage: 'BERMASALAH', step: 3, detail: d };
  }
  // Hitung step tertinggi
  let step = 2;
  entries.forEach(e => {
    if (isPickupPhase(e)) return;
    const dlow = (e.desc || '').toLowerCase();
    if (OTW_PATTERN.test(dlow))   step = Math.max(step, 4);
    else if (KOTA_PATTERN.test(dlow)) step = Math.max(step, 3);
  });
  const stage = step >= 4 ? 'OTW' : step >= 3 ? 'KOTA_TUJUAN' : 'DIKIRIM';
  return { stage, step, detail: d };
}

function normalizeCourier(raw) {
  const key = (raw || '').toUpperCase().replace(/[^A-Z0-9&]/g, '');
  return COURIER_MAP[key] || raw;
}

// ── POST: webhook receiver dari akuisisitracking ─────────────────────────────
async function handleWebhook(req, res) {
  const secret = req.headers['x-webhook-secret'];
  if (secret !== WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid secret' });
  }

  const { resi, stage, step, ekspedisi, status_category } = req.body || {};
  if (!resi || !stage) {
    return res.status(400).json({ error: 'resi dan stage wajib' });
  }

  const now = new Date().toISOString();

  try {
    // Cari orders yang punya resi ini
    const orders = await sb('orders',
      `nomer_resi=eq.${encodeURIComponent(resi)}&select=id,user_id,product_id,status_resi,nomer_hp`
    );

    if (!orders.length) {
      return res.json({ ok: true, matched: 0, message: 'Resi tidak ditemukan di CRM' });
    }

    // Update semua order yang match
    const patch = {
      status_resi: stage,
      status_resi_step: step || null,
      last_tracked_at: now,
    };
    if (stage === 'SAMPAI') patch.tgl_delivered = now.slice(0, 10);
    if (ekspedisi) patch.ekspedisi = ekspedisi;

    await sb('orders', `nomer_resi=eq.${encodeURIComponent(resi)}`, {
      method: 'PATCH', body: patch
    });

    // Update customers juga
    for (const order of orders) {
      if (!order.nomer_hp) continue;
      const custPatch = { updated_at: now };
      if (stage === 'SAMPAI') custPatch.tgl_delivered = now.slice(0, 10);
      await sb('customers',
        `wa_number=eq.${encodeURIComponent(order.nomer_hp)}&user_id=eq.${order.user_id}`,
        { method: 'PATCH', body: custPatch }
      ).catch(() => {});
    }

    // Kalau SAMPAI → trigger generate-schedules
    if (stage === 'SAMPAI') {
      const userIds = [...new Set(orders.map(o => o.user_id).filter(Boolean))];
      const baseUrl = req.headers['x-forwarded-proto'] && req.headers['x-forwarded-host']
        ? `${req.headers['x-forwarded-proto']}://${req.headers['x-forwarded-host']}`
        : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';

      if (baseUrl) {
        for (const uid of userIds) {
          const pids = [...new Set(orders.filter(o => o.user_id === uid).map(o => o.product_id).filter(Boolean))];
          for (const pid of (pids.length ? pids : [null])) {
            fetch(`${baseUrl}/api/generate-schedules`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ user_id: uid, product_id: pid })
            }).catch(e => console.warn('[track-resi webhook] generate-schedules failed:', e.message));
          }
        }
      }
    }

    console.log(`[track-resi webhook] ${resi} → ${stage} (${status_category || '-'}), matched ${orders.length}`);
    return res.json({ ok: true, resi, stage, matched: orders.length });
  } catch (e) {
    console.error('[track-resi webhook] Error:', e.message);
    return res.status(500).json({ error: e.message });
  }
}

// ── GET: polling status dari Mengantar ────────────────────────────────────────
async function handleGet(req, res) {
  const { resi, ekspedisi } = req.query;
  if (!resi || !ekspedisi) {
    return res.status(400).json({ error: 'resi and ekspedisi required' });
  }

  try {
    const eksKey = (ekspedisi || '').toUpperCase().replace(/[^A-Z]/g, '');
    const isPos  = eksKey === 'POS' || eksKey.includes('POSINDONESIA');

    let raw;
    if (isPos) {
      raw = await trackPos(resi);
    } else {
      const courier = normalizeCourier(ekspedisi);
      raw = await trackShipment(resi, courier);
    }

    const { stage, step, detail } = mapTrackingStage(raw);
    res.status(200).json({ stage, step, detail });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

// ── Router ────────────────────────────────────────────────────────────────────
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method === 'POST') return handleWebhook(req, res);
  if (req.method === 'GET')  return handleGet(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
};
