// api/generate-schedules.js
// Generate followup_schedule dari orders — auto-create customer kalau belum ada

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(table, params = '', opts = {}) {
  const r = await fetch(`${SB_URL}/rest/v1/${table}${params ? '?' + params : ''}`, {
    method: opts.method || 'GET',
    headers: {
      apikey: SB_KEY, Authorization: `Bearer ${SB_KEY}`,
      'Content-Type': 'application/json',
      Prefer: opts.prefer || (opts.method === 'POST' ? 'return=representation' : undefined)
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

  const { user_id, product_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  try {
    // 1. Rules aktif — filter by product kalau ada
    const ruleQ = product_id
      ? `user_id=eq.${user_id}&aktif=eq.true&or=(product_id.eq.${product_id},product_id.is.null)&order=urutan.asc`
      : `user_id=eq.${user_id}&aktif=eq.true&order=urutan.asc`;
    const rules = await sb('followup_rules', ruleQ);
    if (!rules.length) return res.json({ created: 0, skipped: 0, message: 'Tidak ada rule aktif' });

    // 2. Semua orders user (tidak filter by product_id — biar semua masuk)
    const orders = await sb('orders',
      `user_id=eq.${user_id}&select=id,nomer_hp,nama_customer,produk,tanggal,created_at,status_resi,last_tracked_at,product_id&order=created_at.desc&limit=2000`);
    if (!orders.length) return res.json({ created: 0, skipped: 0, message: 'Tidak ada order' });

    // 3. Semua customers user
    const customers = await sb('customers',
      `user_id=eq.${user_id}&select=id,wa_number,product_id`);
    const custMap = {};
    customers.forEach(c => { custMap[normalizePhone(c.wa_number)] = c; });

    // 4. Auto-create customers yang belum ada
    const missingOrders = orders.filter(o => {
      const phone = normalizePhone(o.nomer_hp);
      return phone && !custMap[phone];
    });

    if (missingOrders.length) {
      // Deduplicate by phone
      const seen = new Set();
      const toCreate = [];
      for (const o of missingOrders) {
        const phone = normalizePhone(o.nomer_hp);
        if (seen.has(phone)) continue;
        seen.add(phone);
        toCreate.push({
          user_id,
          wa_number: phone,
          nama: o.nama_customer || phone,
          produk: o.produk || '',
          product_id: o.product_id || product_id || null,
          source: 'import',
          status: 'baru'
        });
      }

      // Upsert customers — skip kalau sudah ada (ON CONFLICT DO NOTHING)
      for (let i = 0; i < toCreate.length; i += 200) {
        const created = await sb('customers', '', {
          method: 'POST',
          prefer: 'return=representation,resolution=ignore-duplicates',
          body: toCreate.slice(i, i + 200)
        });
        if (Array.isArray(created)) {
          created.forEach(c => { custMap[normalizePhone(c.wa_number)] = c; });
        }
      }
      // Re-fetch customers supaya custMap lengkap (termasuk yang sudah ada sebelumnya)
      const freshCusts = await sb('customers', `user_id=eq.${user_id}&select=id,wa_number,product_id`);
      freshCusts.forEach(c => { custMap[normalizePhone(c.wa_number)] = c; });
    }

    // 5. Existing schedules (cegah duplikat)
    const existing = await sb('followup_schedule',
      `user_id=eq.${user_id}&status=eq.pending&select=customer_id,rule_id`);
    const existSet = new Set(existing.map(e => `${e.customer_id}__${e.rule_id}`));

    const today = new Date().toISOString().slice(0, 10);
    const toInsert = [];
    let skipped = 0;

    for (const rule of rules) {
      const isSblm = rule.tipe === 'sebelum_deliv';
      const hari = isSblm
        ? (rule.hari_sebelum_deliv || rule.hari_setelah_delivered || 1)
        : (rule.hari_setelah_delivered || 1);

      for (const order of orders) {
        const phone = normalizePhone(order.nomer_hp);
        const cust  = custMap[phone];
        if (!cust) { skipped++; continue; }

        const key = `${cust.id}__${rule.id}`;
        if (existSet.has(key)) { skipped++; continue; }

        // Cek produk — hanya skip kalau keduanya ada tapi tidak match
        const orderProd = order.product_id || cust.product_id || null;
        if (rule.product_id && orderProd && rule.product_id !== orderProd) {
          skipped++; continue;
        }

        let scheduledDate = null;
        if (isSblm) {
          // Pakai tanggal order, fallback ke created_at kalau kosong
          const base = order.tanggal || (order.created_at ? order.created_at.slice(0, 10) : null);
          if (!base) { skipped++; continue; }
          scheduledDate = addDays(base, hari);
        } else {
          if (order.status_resi !== 'SAMPAI') { skipped++; continue; }
          const base = order.last_tracked_at || order.tanggal || order.created_at;
          if (!base) { skipped++; continue; }
          scheduledDate = addDays(base.slice(0, 10), hari);
        }

        // Skip jadwal yang sudah lewat >30 hari
        const diff = (new Date(today) - new Date(scheduledDate)) / 86400000;
        if (diff > 30) { skipped++; continue; }

        toInsert.push({
          user_id,
          customer_id: cust.id,
          product_id: cust.product_id || order.product_id || null,
          rule_id: rule.id,
          rule_nama: rule.nama,
          scheduled_date: scheduledDate,
          status: 'pending'
        });
        existSet.add(key);
      }
    }

    // 6. Insert jadwal batch
    let created = 0;
    for (let i = 0; i < toInsert.length; i += 200) {
      await sb('followup_schedule', '', {
        method: 'POST', prefer: 'return=minimal',
        body: toInsert.slice(i, i + 200)
      });
      created += Math.min(200, toInsert.length - i);
    }

    const ruleTypes = rules.map(r => `${r.nama}(${r.tipe||'?'})`).join(', ');
    return res.json({ created, skipped, rules: ruleTypes, orders_total: orders.length, customers_total: Object.keys(custMap).length });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
