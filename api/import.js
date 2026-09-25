// api/import.js — server-side Excel import (optional, frontend pakai SheetJS langsung)
// Endpoint ini untuk import dari CS Input Supabase (opsional, kedepannya)

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;
// CS Input Supabase (opsional, bisa diisi kalau mau sync)
const CS_SB_URL = process.env.CS_SUPABASE_URL;
const CS_SB_KEY = process.env.CS_SUPABASE_KEY;

async function sb(url, key, table, params = '', opts = {}) {
  const r = await fetch(`${url}/rest/v1/${table}${params ? '?' + params : ''}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: key, Authorization: `Bearer ${key}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || (opts.method === 'POST' ? 'return=minimal' : undefined)
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const text = await r.text();
  if (!r.ok) throw new Error(text);
  try { return JSON.parse(text); } catch { return text; }
}

function normalizePhone(p) {
  if (!p) return '';
  p = String(p).replace(/\D/g, '');
  if (p.startsWith('0')) p = '62' + p.slice(1);
  if (!p.startsWith('62')) p = '62' + p;
  return p;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { action, user_id, rows } = req.body || {};

  try {
    // ---- IMPORT ROWS (dari frontend setelah parse Excel) ----
    if (action === 'import-rows') {
      if (!rows?.length || !user_id) return res.status(400).json({ error: 'rows dan user_id required' });

      const payload = rows.map(r => ({
        user_id,
        nama:          r.nama || '',
        wa_number:     normalizePhone(r.wa || r.hp || r.telepon || ''),
        produk:        r.produk || '',
        qty:           parseInt(r.qty) || 1,
        harga:         parseInt(r.harga) || 0,
        no_resi:       r.resi || r.no_resi || '',
        ekspedisi:     r.ekspedisi || r.kurir || '',
        tgl_order:     r.tgl_order || null,
        tgl_delivered: r.tgl_delivered || null,
        alamat:        { jalan: r.alamat || '' },
        status:        r.status || 'baru',
        source:        'import',
      })).filter(r => r.nama && r.wa_number);

      let inserted = 0;
      for (let i = 0; i < payload.length; i += 500) {
        await sb(SB_URL, SB_KEY, 'customers', '', { method: 'POST', prefer: 'return=minimal', body: payload.slice(i, i + 500) });
        inserted += Math.min(500, payload.length - i);
      }
      return res.json({ ok: true, inserted });
    }

    // ---- SYNC FROM CS INPUT (kalau CS Input Supabase di-setup) ----
    if (action === 'sync-cs-input') {
      if (!CS_SB_URL || !CS_SB_KEY) return res.status(400).json({ error: 'CS Input Supabase tidak di-setup' });

      // Ambil data delivered dari CS Input (adaptasi sesuai struktur CS Input)
      const csOrders = await sb(CS_SB_URL, CS_SB_KEY, 'orders',
        'status=eq.delivered&select=nama,hp,produk,qty,resi,ekspedisi,tgl_order,tgl_delivered,alamat&limit=500');

      const payload = csOrders.map(o => ({
        user_id,
        nama: o.nama || '',
        wa_number: normalizePhone(o.hp || ''),
        produk: o.produk || '',
        qty: o.qty || 1,
        no_resi: o.resi || '',
        ekspedisi: o.ekspedisi || '',
        tgl_order: o.tgl_order || null,
        tgl_delivered: o.tgl_delivered || null,
        alamat: { jalan: o.alamat || '' },
        status: 'sukses',
        source: 'cs-input',
      })).filter(r => r.nama && r.wa_number);

      await sb(SB_URL, SB_KEY, 'customers', '', {
        method: 'POST', prefer: 'return=minimal', body: payload
      });

      return res.json({ ok: true, synced: payload.length });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
