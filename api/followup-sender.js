// api/followup-sender.js — cron job: kirim FU otomatis setiap pagi
// Setup cron: POST /api/followup-sender tiap hari jam 09:00 WIB (02:00 UTC)
// Header: x-cron-secret: adsysukses2026

const SB_URL    = process.env.SUPABASE_URL;
const SB_KEY    = process.env.SUPABASE_SERVICE_KEY;
const BAILEYS   = process.env.BAILEYS_URL || 'http://13.140.178.4:3000';
const SECRET    = process.env.WEBHOOK_SECRET || 'adsysukses2026';
const CRON_SECRET = process.env.CRON_SECRET || 'adsysukses2026';

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

async function sendWA(sessionId, to, text) {
  const r = await fetch(`${BAILEYS}/send?secret=${SECRET}&session_id=${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: to + '@s.whatsapp.net', text }),
    signal: AbortSignal.timeout(30000)
  });
  const d = await r.json();
  if (!d.success && !d.ok) throw new Error(d.error || 'WA send failed');
  return d;
}

async function getAnthropicKey(userId) {
  const rows = await sb('users', `id=eq.${userId}&select=anthropic_key`);
  return rows[0]?.anthropic_key || process.env.ANTHROPIC_KEY;
}

async function generatePesan(rule, customer, apiKey) {
  // Random pilih dari templates
  const templates = rule.templates || [];
  if (templates.length) {
    const tmpl = templates[Math.floor(Math.random() * templates.length)];
    return tmpl
      .replace(/{nama}/g, customer.nama || 'Kak')
      .replace(/{produk}/g, customer.produk || 'produk')
      .replace(/{hari}/g, rule.hari_setelah_delivered || '');
  }

  // Fallback: AI generate
  if (!apiKey) return null;
  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey });
  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 150,
    messages: [{
      role: 'user',
      content: `Buat 1 pesan follow-up WA singkat (max 2 kalimat) untuk customer ${customer.nama || 'Kak'} yang beli ${customer.produk || 'produk'}, ini hari ke-${rule.hari_setelah_delivered} setelah barang diterima. Balas hanya teks pesannya.`
    }]
  });
  return msg.content[0].text.trim();
}

export default async function handler(req, res) {
  // Auth check
  const secret = req.headers['x-cron-secret'];
  if (secret !== CRON_SECRET) return res.status(401).json({ error: 'Unauthorized' });
  if (req.method !== 'POST') return res.status(405).end();

  const today = new Date().toISOString().slice(0, 10);
  const results = { sent: 0, failed: 0, skipped: 0, details: [] };

  try {
    // Ambil semua jadwal hari ini yang pending
    const schedules = await sb('followup_schedule',
      `scheduled_date=lte.${today}&status=eq.pending&select=*,customers(nama,wa_number,produk,product_id),followup_rules(templates,hari_setelah_delivered)`);

    if (!schedules.length) {
      return res.json({ ...results, message: 'Tidak ada jadwal hari ini' });
    }

    for (const s of schedules) {
      const customer = s.customers;
      const rule     = s.followup_rules || {};

      if (!customer?.wa_number) {
        await sb('followup_schedule', `id=eq.${s.id}`, { method: 'PATCH', body: { status: 'skipped' } });
        results.skipped++;
        continue;
      }

      try {
        // Get API key user
        const apiKey = await getAnthropicKey(s.user_id);

        // Generate pesan
        const pesan = await generatePesan(rule, customer, apiKey);
        if (!pesan) {
          await sb('followup_schedule', `id=eq.${s.id}`, { method: 'PATCH', body: { status: 'skipped' } });
          results.skipped++;
          continue;
        }

        // Get WA session (dari produk atau fallback ke user_id)
        let sessionId = s.user_id;
        if (customer.product_id) {
          const prod = await sb('products', `id=eq.${customer.product_id}&select=wa_session_id`);
          sessionId = prod[0]?.wa_session_id || s.user_id;
        }

        // Kirim WA
        await sendWA(sessionId, customer.wa_number, pesan);

        // Buat / update conversation
        let convs = await sb('conversations', `user_id=eq.${s.user_id}&customer_id=eq.${s.customer_id}&status=neq.selesai&limit=1`);
        let convId;
        if (convs.length) {
          convId = convs[0].id;
          await sb('conversations', `id=eq.${convId}`, { method: 'PATCH', body: { updated_at: new Date().toISOString() } });
        } else {
          const newConv = await sb('conversations', '', {
            method: 'POST',
            body: {
              user_id: s.user_id, customer_id: s.customer_id,
              product_id: customer.product_id || null,
              status: 'aktif', sumber: 'fu', state: {}
            }
          });
          convId = newConv[0].id;
        }

        // Simpan pesan ke conv_messages
        await sb('conv_messages', '', {
          method: 'POST', prefer: 'return=minimal',
          body: { conversation_id: convId, isi: pesan, role: 'ai' }
        });

        // Update schedule + customer
        await Promise.all([
          sb('followup_schedule', `id=eq.${s.id}`, {
            method: 'PATCH', body: { status: 'sent', sent_at: new Date().toISOString(), pesan_terkirim: pesan }
          }),
          sb('customers', `id=eq.${s.customer_id}`, {
            method: 'PATCH', body: { last_fu_at: new Date().toISOString(), status: 'fu_aktif' }
          })
        ]);

        results.sent++;
        results.details.push({ customer: customer.nama, status: 'sent' });
      } catch(e) {
        await sb('followup_schedule', `id=eq.${s.id}`, { method: 'PATCH', body: { status: 'failed' } });
        results.failed++;
        results.details.push({ customer: customer?.nama, status: 'failed', error: e.message });
      }

      // Delay antar kirim (hindari spam)
      await new Promise(r => setTimeout(r, 1500));
    }

    return res.json(results);
  } catch(e) {
    return res.status(500).json({ error: e.message, ...results });
  }
}
