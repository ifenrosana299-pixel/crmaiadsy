// api/generate-schedules.js
// Generate followup_schedule dari orders — auto-create customer kalau belum ada
// Dedup pakai kolom dedup_key (UNIQUE constraint di DB) → anti double

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
  if (p.startsWith('00')) p = p.slice(2);
  if (p.startsWith('0')) p = '62' + p.slice(1);
  if (!p.startsWith('62')) p = '62' + p;
  return p;
}

function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// Generate dedup_key: 1 customer + 1 rule + 1 produk = 1 schedule saja
function makeDedup(customerId, ruleName, productId) {
  return `${customerId}:${ruleName}:${productId || 'ALL'}`;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { user_id, product_id, rule_id } = req.body || {};
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  try {
    // 1. Rules aktif
    let ruleQ = `user_id=eq.${user_id}&aktif=eq.true&order=urutan.asc`;
    if (rule_id) ruleQ += `&id=eq.${rule_id}`;
    else if (product_id) ruleQ += `&or=(product_id.eq.${product_id},product_id.is.null)`;
    const rules = await sb('followup_rules', ruleQ);
    if (!rules.length) return res.json({ created: 0, skipped: 0, message: 'Tidak ada rule aktif' });

    // 2. Semua orders user
    const orders = await sb('orders',
      `user_id=eq.${user_id}&select=id,nomer_hp,nama_customer,produk,tanggal,created_at,status_resi,last_tracked_at,tgl_delivered,product_id,qty,jumlah_produk&order=created_at.desc&limit=2000`);
    if (!orders.length) return res.json({ created: 0, skipped: 0, message: 'Tidak ada order' });

    // 3. Customers + products (limit=10000, Supabase default cuma 1000!)
    const [customers, products] = await Promise.all([
      sb('customers', `user_id=eq.${user_id}&select=id,wa_number,product_id&limit=10000`),
      sb('products',  `user_id=eq.${user_id}&select=id,konsumsi_hari,buffer_reorder_hari&limit=1000`)
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
          status: 'baru',
          send_minute_slot: Math.floor(Math.random() * 720)
        });
      }
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
      const freshCusts = await sb('customers', `user_id=eq.${user_id}&select=id,wa_number,product_id`);
      freshCusts.forEach(c => { custMap[normalizePhone(c.wa_number)] = c; });
    }

    // 5. Existing dedup_keys — cek yang SUDAH ada di DB
    // Coba fetch dedup_key dulu; kalau kolom belum ada, fallback ke composite key
    let existKeys = new Set();
    let hasDedupCol = false;
    try {
      const existRows = await sb('followup_schedule',
        `user_id=eq.${user_id}&select=dedup_key&limit=50000`);
      existKeys = new Set(existRows.map(e => e.dedup_key).filter(Boolean));
      hasDedupCol = true;
    } catch {
      // Kolom dedup_key belum ada — fallback: fetch customer_id+rule_nama+product_id
      const existRows = await sb('followup_schedule',
        `user_id=eq.${user_id}&select=customer_id,rule_nama,product_id&limit=50000`);
      existKeys = new Set(existRows.map(e => `${e.customer_id}:${e.rule_nama}:${e.product_id || 'ALL'}`));
    }

    // 5a. Existing pending untuk auto-skip sebelum_deliv yang paketnya SAMPAI
    const existPending = await sb('followup_schedule',
      `user_id=eq.${user_id}&status=eq.pending&select=id,customer_id,rule_id&limit=10000`);

    const today = new Date().toISOString().slice(0, 10);
    const toInsert = [];
    const skipReasons = { no_cust: 0, duplicate: 0, prod_mismatch: 0, no_base: 0, not_sampai: 0, too_old: 0, auto_skip_sampai: 0 };

    // 5b. Auto-skip pending sebelum_deliv untuk customer yang paketnya sudah SAMPAI
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
        for (let i = 0; i < toSkip.length; i += 50) {
          const ids = toSkip.slice(i, i + 50).map(e => e.id);
          await sb('followup_schedule',
            `or=(${ids.map(id => `id.eq.${id}`).join(',')})`,
            { method: 'PATCH', body: { status: 'skipped' } }
          );
        }
        skipReasons.auto_skip_sampai = toSkip.length;
      }
    }

    // 6. Generate schedules
    for (const rule of rules) {
      const isSblm        = rule.tipe === 'sebelum_deliv';
      const isReorder     = rule.tipe === 'reorder';
      const isEventOtw    = rule.tipe === 'event_otw';
      const isEventSampai = rule.tipe === 'event_sampai';
      const isEvent       = isEventOtw || isEventSampai;
      const hari = isSblm
        ? (rule.hari_sebelum_deliv ?? rule.hari_setelah_delivered ?? 0)
        : (isReorder || isEvent) ? null
        : (rule.hari_setelah_delivered ?? 1);

      for (const order of orders) {
        const phone = normalizePhone(order.nomer_hp);
        const cust  = custMap[phone];
        if (!cust) { skipReasons.no_cust++; continue; }

        const pid = cust.product_id || order.product_id || null;
        const dk  = makeDedup(cust.id, rule.nama, pid);

        // Dedup: sudah ada di DB ATAU sudah ditambahkan di batch ini
        if (existKeys.has(dk)) { skipReasons.duplicate++; continue; }

        // Cek produk match
        if (rule.product_id && pid && rule.product_id !== pid) {
          skipReasons.prod_mismatch++; continue;
        }

        let scheduledDate = null;
        if (isSblm) {
          const base = order.created_at ? order.created_at.slice(0, 10) : order.tanggal || null;
          if (!base) { skipReasons.no_base++; continue; }
          scheduledDate = addDays(base, hari);
        } else if (isReorder) {
          if (order.status_resi !== 'SAMPAI') { skipReasons.not_sampai++; continue; }
          const prod = productMap[order.product_id || cust.product_id];
          if (!prod?.konsumsi_hari) { skipReasons.no_base++; continue; }
          const qty    = parseInt(order.jumlah_produk) || parseInt(order.qty) || 1;
          const buffer = rule.buffer_reorder_hari ?? prod.buffer_reorder_hari ?? 5;
          const base   = order.last_tracked_at || order.tanggal || order.created_at;
          if (!base) { skipReasons.no_base++; continue; }
          const totalDays = (qty * prod.konsumsi_hari) - buffer;
          if (totalDays <= 0) { skipReasons.no_base++; continue; }
          scheduledDate = addDays(base.slice(0, 10), totalDays);
        } else if (isEventOtw) {
          const OTW_STATUSES = ['OTW', 'KOTA_TUJUAN'];
          if (!OTW_STATUSES.includes(order.status_resi)) { skipReasons.not_sampai++; continue; }
          scheduledDate = today;
        } else if (isEventSampai) {
          if (order.status_resi !== 'SAMPAI') { skipReasons.not_sampai++; continue; }
          const base = order.last_tracked_at || order.tanggal || order.created_at;
          if (!base) { skipReasons.no_base++; continue; }
          scheduledDate = base.slice(0, 10);
        } else {
          if (order.status_resi !== 'SAMPAI') { skipReasons.not_sampai++; continue; }
          const base = order.tgl_delivered || order.last_tracked_at || order.tanggal || order.created_at;
          if (!base) { skipReasons.no_base++; continue; }
          scheduledDate = addDays(base.slice(0, 10), hari);
        }

        // Skip jadwal yang sudah lewat >30 hari
        const diff = (new Date(today) - new Date(scheduledDate)) / 86400000;
        if (diff > 30) { skipReasons.too_old++; continue; }

        const isPast = scheduledDate < today;

        const row = {
          user_id,
          customer_id: cust.id,
          product_id: pid,
          rule_id: rule.id,
          rule_nama: rule.nama,
          scheduled_date: scheduledDate,
          status: isPast ? 'skipped' : 'pending',
          send_after: null
        };
        if (hasDedupCol) row.dedup_key = dk;
        toInsert.push(row);
        existKeys.add(dk); // Cegah double dalam batch yang sama
      }
    }

    // 7. Assign send_after untuk jadwal hari ini
    const todayByProduct = {};
    for (const s of toInsert) {
      if (s.scheduled_date === today && s.status === 'pending') {
        const pid = s.product_id || 'default';
        if (!todayByProduct[pid]) todayByProduct[pid] = [];
        todayByProduct[pid].push(s);
      }
    }
    const now = new Date();
    for (const schedules of Object.values(todayByProduct)) {
      const rate = Math.min(Math.ceil(schedules.length / 10), 3);
      schedules.forEach((s, idx) => {
        const slotIndex = Math.floor(idx / rate) + 1;
        s.send_after = new Date(now.getTime() + slotIndex * 5 * 60 * 1000).toISOString();
      });
    }

    // 8. Insert batch — DB UNIQUE constraint on dedup_key prevents duplicates
    // resolution=ignore-duplicates → kalau dedup_key sudah ada, skip (no error)
    let created = 0;
    for (let i = 0; i < toInsert.length; i += 200) {
      await sb('followup_schedule', '', {
        method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates',
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
      skip_reasons: skipReasons
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
