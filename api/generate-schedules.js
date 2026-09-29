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
      `user_id=eq.${user_id}&select=id,nomer_hp,nama_customer,produk,tanggal,created_at,status_resi,last_tracked_at,product_id,qty&order=created_at.desc&limit=2000`);
    if (!orders.length) return res.json({ created: 0, skipped: 0, message: 'Tidak ada order' });

    // 3. Semua customers user + produk untuk konsumsi_hari
    const [customers, products] = await Promise.all([
      sb('customers', `user_id=eq.${user_id}&select=id,wa_number,product_id`),
      sb('products',  `user_id=eq.${user_id}&select=id,konsumsi_hari,buffer_reorder_hari`)
    ]);
    const productMap = {};
    products.forEach(p => { productMap[p.id] = p; });
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
    // Cek pending by rule_id — cegah double insert dalam satu run
    // Cek sent/skipped by rule_nama — cegah bikin ulang kalau rule dihapus lalu dibuat baru dengan nama sama
    const [existPendingRaw, existDone] = await Promise.all([
      sb('followup_schedule', `user_id=eq.${user_id}&status=eq.pending&select=id,customer_id,rule_id`),
      sb('followup_schedule', `user_id=eq.${user_id}&status=in.(sent,skipped)&select=customer_id,rule_nama`)
    ]);
    let existPending = existPendingRaw;
    const today = new Date().toISOString().slice(0, 10);
    const toInsert = [];
    const skipReasons = { no_cust: 0, duplicate: 0, prod_mismatch: 0, no_base: 0, not_sampai: 0, too_old: 0, auto_skip_sampai: 0 };

    // 5a. Auto-skip pending sebelum_deliv untuk customer yang paketnya sudah SAMPAI
    // → cegah customer dapat pesan "paket dalam perjalanan" padahal sudah diterima
    const sblmRuleIds = new Set(rules.filter(r => r.tipe === 'sebelum_deliv').map(r => r.id));
    if (sblmRuleIds.size) {
      const sampaiPhones = new Set(
        orders.filter(o => o.status_resi === 'SAMPAI').map(o => normalizePhone(o.nomer_hp))
      );
      const sampaiCustIds = new Set(
        [...sampaiPhones].map(p => custMap[p]?.id).filter(Boolean)
      );

      const toSkip = existPending.filter(e => sampaiCustIds.has(e.customer_id) && sblmRuleIds.has(e.rule_id));

      if (toSkip.length) {
        // Batch PATCH → skip per 50
        for (let i = 0; i < toSkip.length; i += 50) {
          const ids = toSkip.slice(i, i + 50).map(e => e.id);
          await sb('followup_schedule',
            `or=(${ids.map(id => `id.eq.${id}`).join(',')})`,
            { method: 'PATCH', body: { status: 'skipped' } }
          );
        }
        // Hapus dari existPending supaya tidak blokir generate setelah_deliv
        const skippedIds = new Set(toSkip.map(e => e.id));
        existPending = existPending.filter(e => !skippedIds.has(e.id));
        skipReasons.auto_skip_sampai = (skipReasons.auto_skip_sampai || 0) + toSkip.length;
      }
    }

    const existSet     = new Set(existPending.map(e => `${e.customer_id}__${e.rule_id}`));
    const existDoneSet = new Set(existDone.map(e => `${e.customer_id}__${e.rule_nama}`));

    for (const rule of rules) {
      const isSblm       = rule.tipe === 'sebelum_deliv';
      const isReorder    = rule.tipe === 'reorder';
      const isEventOtw   = rule.tipe === 'event_otw';
      const isEventSampai = rule.tipe === 'event_sampai';
      const isEvent      = isEventOtw || isEventSampai;
      const hari = isSblm
        ? (rule.hari_sebelum_deliv ?? rule.hari_setelah_delivered ?? 0)
        : (isReorder || isEvent) ? null  // calculated per order
        : (rule.hari_setelah_delivered ?? 1);

      for (const order of orders) {
        const phone = normalizePhone(order.nomer_hp);
        const cust  = custMap[phone];
        if (!cust) { skipReasons.no_cust++; continue; }

        const key     = `${cust.id}__${rule.id}`;
        const keyDone = `${cust.id}__${rule.nama}`;
        if (existSet.has(key) || existDoneSet.has(keyDone)) { skipReasons.duplicate++; continue; }

        // Cek produk — hanya skip kalau keduanya ada tapi tidak match
        const orderProd = order.product_id || cust.product_id || null;
        if (rule.product_id && orderProd && rule.product_id !== orderProd) {
          skipReasons.prod_mismatch++; continue;
        }

        let scheduledDate = null;
        if (isSblm) {
          // Pakai created_at (tanggal order masuk) sebagai base — bukan tanggal delivery
          const base = order.created_at ? order.created_at.slice(0, 10) : order.tanggal || null;
          if (!base) { skipReasons.no_base++; continue; }
          scheduledDate = addDays(base, hari);
        } else if (isReorder) {
          // Reorder: hitung dari qty × konsumsi_hari produk − buffer
          if (order.status_resi !== 'SAMPAI') { skipReasons.not_sampai++; continue; }
          const prod = productMap[order.product_id || cust.product_id];
          if (!prod?.konsumsi_hari) { skipReasons.no_base++; continue; }
          const qty    = parseInt(order.qty) || 1;
          const buffer = rule.buffer_reorder_hari ?? prod.buffer_reorder_hari ?? 5;
          const base   = order.last_tracked_at || order.tanggal || order.created_at;
          if (!base) { skipReasons.no_base++; continue; }
          const totalDays = (qty * prod.konsumsi_hari) - buffer;
          if (totalDays <= 0) { skipReasons.no_base++; continue; }
          scheduledDate = addDays(base.slice(0, 10), totalDays);
        } else if (isEventOtw) {
          // Event OTW: jadwal hari ini kalau status = OTW/KOTA_TUJUAN
          const OTW_STATUSES = ['OTW', 'KOTA_TUJUAN'];
          if (!OTW_STATUSES.includes(order.status_resi)) { skipReasons.not_sampai++; continue; }
          scheduledDate = today;
        } else if (isEventSampai) {
          // Event SAMPAI: jadwal hari yang sama paket tiba (D+0)
          if (order.status_resi !== 'SAMPAI') { skipReasons.not_sampai++; continue; }
          const base = order.last_tracked_at || order.tanggal || order.created_at;
          if (!base) { skipReasons.no_base++; continue; }
          scheduledDate = base.slice(0, 10); // hari paket tiba
        } else {
          if (order.status_resi !== 'SAMPAI') { skipReasons.not_sampai++; continue; }
          const base = order.last_tracked_at || order.tanggal || order.created_at;
          if (!base) { skipReasons.no_base++; continue; }
          scheduledDate = addDays(base.slice(0, 10), hari);
        }

        // Skip jadwal yang sudah lewat >30 hari
        const diff = (new Date(today) - new Date(scheduledDate)) / 86400000;
        if (diff > 30) { skipReasons.too_old++; continue; }

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

    const skipped = Object.values(skipReasons).reduce((a, b) => a + b, 0);
    const ruleTypes = rules.map(r => `${r.nama}(${r.tipe||'?'}) H+${r.hari_sebelum_deliv ?? r.hari_setelah_delivered ?? '?'}`).join(', ');
    return res.json({
      created, skipped, rules: ruleTypes,
      orders_total: orders.length,
      customers_in_db: customers.length,
      custmap_size: Object.keys(custMap).length,
      existing_schedules: existPendingRaw.length,
      skip_reasons: skipReasons
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
