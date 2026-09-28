// api/generate-schedules.js
// Generate followup_schedule entries dari orders berdasarkan followup_rules aktif

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(table, params = '', opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}${params ? '?' + params : ''}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || (opts.method === 'POST' ? 'return=minimal' : undefined)
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const txt = await r.text();
  if (!r.ok) throw new Error(txt);
  try { return JSON.parse(txt); } catch { return txt; }
}

function normalizePhone(p) {
  if (!p) return '';
  p = String(p).replace(/\D/g, '');
  if (p.startsWith('0')) p = '62' + p.slice(1);
  if (!p.startsWith('62')) p = '62' + p;
  return p;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { user_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  try {
    // 1. Ambil semua rules aktif
    const rules = await sb('followup_rules',
      `user_id=eq.${user_id}&aktif=eq.true&order=urutan.asc`);
    if (!rules.length) return res.json({ created: 0, skipped: 0, message: 'Tidak ada rule aktif' });

    // 2. Ambil semua orders user
    const orders = await sb('orders',
      `user_id=eq.${user_id}&select=id,nomer_hp,nama_customer,produk,tanggal,status_resi,last_tracked_at&order=tanggal.desc&limit=2000`);

    // 3. Ambil customers user (untuk mapping phone → customer_id)
    const customers = await sb('customers',
      `user_id=eq.${user_id}&select=id,wa_number,product_id`);
    const custMap = {};
    customers.forEach(c => { custMap[normalizePhone(c.wa_number)] = c; });

    // 4. Ambil schedule yang sudah ada (cegah duplikat)
    const existing = await sb('followup_schedule',
      `user_id=eq.${user_id}&status=eq.pending&select=customer_id,rule_id`);
    const existSet = new Set(existing.map(e => `${e.customer_id}__${e.rule_id}`));

    let created = 0, skipped = 0;
    const toInsert = [];
    const today = new Date().toISOString().slice(0, 10);

    for (const rule of rules) {
      const isSblm = rule.tipe === 'sebelum_deliv';
      const hari   = isSblm
        ? (rule.hari_sebelum_deliv || rule.hari_setelah_delivered || 1)
        : (rule.hari_setelah_delivered || 1);

      for (const order of orders) {
        const phone = normalizePhone(order.nomer_hp);
        const cust  = custMap[phone];
        if (!cust) { skipped++; continue; } // customer tidak ada di tabel customers

        const key = `${cust.id}__${rule.id}`;
        if (existSet.has(key)) { skipped++; continue; } // sudah ada jadwal pending

        let scheduledDate = null;

        if (isSblm) {
          // Sebelum terima: tanggal_order + hari
          if (!order.tanggal) { skipped++; continue; }
          scheduledDate = addDays(order.tanggal, hari);
        } else {
          // Setelah terima: butuh status SAMPAI
          if (order.status_resi !== 'SAMPAI') { skipped++; continue; }
          const deliveredDate = (order.last_tracked_at || order.tanggal);
          if (!deliveredDate) { skipped++; continue; }
          scheduledDate = addDays(deliveredDate.slice(0, 10), hari);
        }

        // Kalau jadwal sudah lewat > 30 hari, skip
        const diff = (new Date(today) - new Date(scheduledDate)) / 86400000;
        if (diff > 30) { skipped++; continue; }

        toInsert.push({
          user_id,
          customer_id: cust.id,
          product_id: cust.product_id || null,
          rule_id: rule.id,
          rule_nama: rule.nama,
          scheduled_date: scheduledDate,
          status: 'pending'
        });
        existSet.add(key); // cegah duplikat dalam batch yang sama
      }
    }

    // Insert batch
    if (toInsert.length) {
      for (let i = 0; i < toInsert.length; i += 200) {
        await sb('followup_schedule', '', {
          method: 'POST', prefer: 'return=minimal',
          body: toInsert.slice(i, i + 200)
        });
        created += Math.min(200, toInsert.length - i);
      }
    }

    return res.json({ created, skipped, total_rules: rules.length, total_orders: orders.length });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
