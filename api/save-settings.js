// api/save-settings.js — Settings CRUD + AI helpers for AI CRM Adsy
import Anthropic from '@anthropic-ai/sdk';

const SB_URL = process.env.SUPABASE_URL;
const SB_KEY = process.env.SUPABASE_SERVICE_KEY;

async function sb(table, params = '', opts = {}) {
  const url = `${SB_URL}/rest/v1/${table}${params ? '?' + params : ''}`;
  const r = await fetch(url, {
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

async function getAnthropicKey(userId) {
  const rows = await sb('users', `id=eq.${userId}&select=anthropic_key`);
  return rows[0]?.anthropic_key || process.env.ANTHROPIC_KEY;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const body = req.body || {};
  const { action } = body || req.query || {};

  try {

    // ---- SAVE AI KEY ----
    if (action === 'save-ai-key') {
      const { user_id, anthropic_key } = body;
      if (!user_id) return res.status(400).json({ error: 'user_id wajib' });
      await sb('users', `id=eq.${user_id}`, { method: 'PATCH', body: { anthropic_key } });
      return res.json({ ok: true });
    }

    // ---- SAVE SETTINGS (rekening, group_jid, dll) ----
    // Supports: rekening, group_jid
    if (action === 'save-settings') {
      const { user_id } = body;
      if (!user_id) return res.status(400).json({ error: 'user_id wajib' });
      const patch = {};
      if ('rekening' in body)  patch.rekening  = body.rekening;
      if ('group_jid' in body) patch.group_jid = body.group_jid;
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'Tidak ada field yang diupdate' });
      await sb('users', `id=eq.${user_id}`, { method: 'PATCH', body: patch });
      return res.json({ ok: true });
    }

    // ---- SAVE USERS TEMPLATE ----
    if (action === 'save-template' || (body.table === 'users_template' && body.userId && body.payload)) {
      const userId = body.user_id || body.userId;
      if (!userId) return res.status(400).json({ error: 'user_id wajib' });
      const allowed = [
        'template_fu_h1', 'template_fu_h3', 'template_fu_h7',
        'template_repeat_order', 'template_tidak_respon'
      ];
      const patch = {};
      for (const key of allowed) {
        if (key in body.payload) patch[key] = body.payload[key];
      }
      if (!Object.keys(patch).length) return res.status(400).json({ error: 'Tidak ada template yang diupdate' });
      await sb('users', `id=eq.${userId}`, { method: 'PATCH', body: patch });
      return res.json({ ok: true });
    }

    // ---- GENERATE FU TEMPLATES ----
    if (action === 'generate-templates') {
      const { rule_nama, hari, user_id } = body;
      const apiKey = await getAnthropicKey(user_id);
      const client = new Anthropic({ apiKey });

      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1024,
        messages: [{
          role: 'user',
          content: `Buatkan 5 variasi pesan WhatsApp untuk follow-up customer yang baru menerima produk.
Rule: "${rule_nama}" (D+${hari} setelah delivered)
Variabel yang tersedia: {nama} = nama customer, {produk} = nama produk, {hari} = hari ke berapa

Ketentuan:
- Bahasa Indonesia yang natural dan ramah
- Tidak terlalu panjang (max 2-3 kalimat)
- Setiap variasi harus berbeda tone tapi tujuan sama
- Bisa pakai emoji yang wajar
- Jangan terlalu formal, juga jangan terlalu santai
- Jangan langsung tawarin beli lagi (kecuali D+7 ke atas)

Balas HANYA JSON array: ["pesan1", "pesan2", "pesan3", "pesan4", "pesan5"]`
        }]
      });

      let templates = [];
      try {
        const text = msg.content[0].text.trim();
        const start = text.indexOf('[');
        const end = text.lastIndexOf(']');
        templates = JSON.parse(text.slice(start, end + 1));
      } catch {}

      return res.json({ templates });
    }

    // ---- GENERATE FU PESAN (per customer) ----
    if (action === 'generate-fu-pesan') {
      const { customer_id, rule_nama, user_id } = body;
      const apiKey = await getAnthropicKey(user_id);

      const [cust, rules] = await Promise.all([
        sb('customers', `id=eq.${customer_id}&select=nama,produk,tgl_delivered,catatan`),
        sb('followup_rules', `user_id=eq.${user_id}&nama=eq.${encodeURIComponent(rule_nama)}&limit=1`)
      ]);

      const c = cust[0] || {};
      const r = rules[0] || {};
      const templates = r.templates || [];

      if (templates.length) {
        const tmpl = templates[Math.floor(Math.random() * templates.length)];
        const pesan = tmpl
          .replace(/{nama}/g, c.nama || 'Kak')
          .replace(/{produk}/g, c.produk || 'produk')
          .replace(/{hari}/g, r.hari_setelah_delivered || '');
        return res.json({ pesan });
      }

      // Fallback: generate via AI
      const client = new Anthropic({ apiKey });
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: `Buat pesan follow-up WhatsApp untuk:
Nama customer: ${c.nama || 'Kak'}
Produk: ${c.produk || '-'}
Rule: ${rule_nama} (D+${r.hari_setelah_delivered || '?'})
Catatan: ${c.catatan || '-'}

Balas HANYA teks pesan WA-nya saja (tidak perlu penjelasan).`
        }]
      });

      return res.json({ pesan: msg.content[0].text.trim() });
    }

    // ---- AI SUGGEST (in-chat) ----
    if (action === 'ai-suggest') {
      const { conv_id, user_id } = body;
      const apiKey = await getAnthropicKey(user_id);

      const [msgs, convData] = await Promise.all([
        sb('conv_messages', `conversation_id=eq.${conv_id}&order=created_at.desc&limit=10`),
        sb('conversations', `id=eq.${conv_id}&select=*,customers(nama,produk)`)
      ]);

      const customer = convData[0]?.customers || {};
      const history = msgs.reverse().map(m => `${m.role === 'customer' ? 'Customer' : 'CS/AI'}: ${m.isi}`).join('\n');

      const client = new Anthropic({ apiKey });
      const msg = await client.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: `Kamu adalah CS yang sedang follow-up customer post-purchase.
Customer: ${customer.nama || 'Kak'}, Produk: ${customer.produk || '-'}

History pesan terakhir:
${history}

Buat balasan yang tepat dan natural untuk mendorong repeat order. Balas HANYA teks pesan saja.`
        }]
      });

      return res.json({ pesan: msg.content[0].text.trim() });
    }

    return res.status(400).json({ error: 'Unknown action' });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
