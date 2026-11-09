// api/generate-schedules-pelanggan.js
// Generate followup_schedule_pelanggan dari repeat_orders + followup_rules_pelanggan
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
    // 1. Rules pelanggan aktif
    let ruleQ = `user_id=eq.${user_id}&aktif=eq.true&order=urutan.asc`;
    if (rule_id) ruleQ += `&id=eq.${rule_id}`;
    else if (product_id) ruleQ += `&or=(product_id.eq.${product_id},product_id.is.null)`;
    const rules = await sb('followup_rules_pelanggan', ruleQ);
    if (!rules.length) return res.json({ created: 0, skipped: 0, message: 'Tidak ada rule pelanggan aktif' });

    // 2. Repeat orders yang sudah dikirim
    let orderQ = `user_id=eq.${user_id}&status=in.(dikirim,selesai)&select=*&order=created_at.desc&limit=2000`;
    if (product_id) orderQ += `&product_id=eq.${product_id}`;
    const repeatOrders = await sb('repeat_orders', orderQ);
    if (!repeatOrders.length) return res.json({ created: 0, skipped: 0, message: 'Tidak ada repeat order yang sudah dikirim' });

    // 3. Customers & products (limit=10000, Supabase default cuma 1000!)
    const [customers, products] = await Promise.all([
      sb('customers', `user_id=eq.${user_id}&select=id,wa_number,product_id&limit=10000`),
      sb('products', `user_id=eq.${user_id}&select=id,konsumsi_hari,buffer_reorder_hari&limit=1000`)
    ]);
    const productMap = {};
    products.forEach(p => { productMap[p.id] = p; });
    const custMap = {};
    customers.forEach(c => { custMap[c.id] = c; });

    // 4. Existing dedup_keys — fallback kalau kolom belum ada
    let existKeys = new Set();
    let hasDedupCol = false;
    try {
      const existRows = await sb('followup_schedule_pelanggan',
        `user_id=eq.${user_id}&select=dedup_key&limit=50000`);
      existKeys = new Set(existRows.map(e => e.dedup_key).filter(Boolean));
      hasDedupCol = true;
    } catch {
      const existRows = await sb('followup_schedule_pelanggan',
        `user_id=eq.${user_id}&select=customer_id,rule_nama,product_id&limit=50000`);
      existKeys = new Set(existRows.map(e => `${e.customer_id}:${e.rule_nama}:${e.product_id || 'ALL'}`));
    }

    // 4a. Existing pending untuk auto-skip
    const existPending = await sb('followup_schedule_pelanggan',
      `user_id=eq.${user_id}&status=eq.pending&select=id,customer_id,rule_id&limit=10000`);

    const today = new Date().toISOString().slice(0, 10);
    const toInsert = [];
    const skipReasons = { no_cust: 0, duplicate: 0, prod_mismatch: 0, no_base: 0, not_dikirim: 0, too_old: 0, auto_skip_sampai: 0 };

    // 4b. Auto-skip pending sebelum_deliv untuk repeat orders yang sudah selesai
    const sblmRuleIds = new Set(rules.filter(r => r.tipe === 'sebelum_deliv').map(r => r.id));
    if (sblmRuleIds.size) {
      const sampaiCustIds = new Set(
        repeatOrders.filter(o => o.status === 'selesai').map(o => o.customer_id).filter(Boolean)
      );
      const toSkip = existPending.filter(e => sampaiCustIds.has(e.customer_id) && sblmRuleIds.has(e.rule_id));
      if (toSkip.length) {
        for (let i = 0; i < toSkip.length; i += 50) {
          const ids = toSkip.slice(i, i + 50).map(e => e.id);
          await sb('followup_schedule_pelanggan',
            `or=(${ids.map(id => `id.eq.${id}`).join(',')})`,
            { method: 'PATCH', body: { status: 'skipped' } }
          );
        }
        skipReasons.auto_skip_sampai = toSkip.length;
      }
    }

    // 5. Generate jadwal per rule × per repeat order
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

      for (const order of repeatOrders) {
        const cust = custMap[order.customer_id];
        if (!cust) { skipReasons.no_cust++; continue; }

        const pid = order.product_id || null;
        const dk  = makeDedup(cust.id, rule.nama, pid);

        if (existKeys.has(dk)) { skipReasons.duplicate++; continue; }

        if (rule.product_id && order.product_id && rule.product_id !== order.product_id) {
          skipReasons.prod_mismatch++; continue;
        }

        let scheduledDate = null;

        if (isSblm) {
          const base = order.created_at ? order.created_at.slice(0, 10) : null;
          if (!base) { skipReasons.no_base++; continue; }
          scheduledDate = addDays(base, hari);
        } else if (isReorder) {
          if (order.status !== 'selesai') { skipReasons.not_dikirim++; continue; }
          const prod = productMap[order.product_id];
          if (!prod?.konsumsi_hari) { skipReasons.no_base++; continue; }
          const qty = parseInt(order.qty) || 1;
          const buffer = rule.buffer_reorder_hari ?? prod.buffer_reorder_hari ?? 5;
          const base = order.created_at;
          if (!base) { skipReasons.no_base++; continue; }
          const totalDays = (qty * prod.konsumsi_hari) - buffer;
          if (totalDays <= 0) { skipReasons.no_base++; continue; }
          scheduledDate = addDays(base.slice(0, 10), totalDays);
        } else if (isEventOtw) {
          if (order.status !== 'dikirim') { skipReasons.not_dikirim++; continue; }
          scheduledDate = today;
        } else if (isEventSampai) {
          if (order.status !== 'selesai') { skipReasons.not_dikirim++; continue; }
          scheduledDate = order.updated_at ? order.updated_at.slice(0, 10) : today;
        } else {
          if (order.status !== 'selesai') { skipReasons.not_dikirim++; continue; }
          const base = order.updated_at || order.created_at;
          if (!base) { skipReasons.no_base++; continue; }
          scheduledDate = addDays(base.slice(0, 10), hari);
        }

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
        existKeys.add(dk);
      }
    }

    // 6. Assign send_after untuk jadwal hari ini
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

    // 7. Insert batch — dedup_key UNIQUE constraint prevents doubles
    let created = 0;
    for (let i = 0; i < toInsert.length; i += 200) {
      await sb('followup_schedule_pelanggan', '', {
        method: 'POST', prefer: 'return=minimal,resolution=ignore-duplicates',
        body: toInsert.slice(i, i + 200)
      });
      created += Math.min(200, toInsert.length - i);
    }

    const skipped = Object.values(skipReasons).reduce((a, b) => a + b, 0);
    return res.json({
      created, skipped,
      repeat_orders_total: repeatOrders.length,
      rules_count: rules.length,
      skip_reasons: skipReasons
    });
  } catch (e) {
    console.error('[generate-schedules-pelanggan]', e);
    return res.status(500).json({ error: e.message });
  }
}
