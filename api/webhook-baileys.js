// api/webhook-baileys.js — inbound WA handler (AI auto-reply untuk CRM)
// Sama strukturnya dengan BotWA tapi konteks = post-purchase follow-up

import Anthropic from '@anthropic-ai/sdk';

const SB_URL    = process.env.SUPABASE_URL;
const SB_KEY    = process.env.SUPABASE_SERVICE_KEY;
const BAILEYS   = process.env.BAILEYS_URL || 'http://13.140.178.4:3000';
const SECRET    = process.env.WEBHOOK_SECRET || 'adsysukses2026';

const debounceMap = new Map();
const DEBOUNCE_MS = 2500;

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
  await fetch(`${BAILEYS}/send?secret=${SECRET}&session_id=${sessionId}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, text }),
    signal: AbortSignal.timeout(30000)
  });
}

// ---- Cari user berdasarkan session_id (dari Baileys webhook) ----
async function findUserBySession(sessionId) {
  // Cek products dulu (wa_session_id per produk)
  let prods = await sb('products', `wa_session_id=eq.${sessionId}&select=id,user_id,nama,product_knowledge,persona_cs_nama,testimoni_urls`);
  if (prods.length) {
    const users = await sb('users', `id=eq.${prods[0].user_id}&select=*`);
    return { user: users[0], product: prods[0] };
  }
  // Fallback: session_id = user_id
  const users = await sb('users', `id=eq.${sessionId}&select=*`);
  if (!users.length) return null;
  const prodFallback = await sb('products', `user_id=eq.${sessionId}&aktif=eq.true&order=created_at.asc&limit=1&select=*`);
  return { user: users[0], product: prodFallback[0] || null };
}

// ---- Cari / buat customer ----
async function findOrCreateCustomer(userId, productId, waFrom) {
  const phone = waFrom.replace('@s.whatsapp.net', '').replace(/^0/, '62');
  let custs = await sb('customers', `user_id=eq.${userId}&wa_number=eq.${phone}&limit=1`);
  if (custs.length) return custs[0];
  // Buat baru (customer belum dikenal — bisa saja mereka chat duluan)
  const created = await sb('customers', '', {
    method: 'POST',
    body: { user_id: userId, product_id: productId || null, wa_number: phone, nama: phone, status: 'baru', source: 'inbound' }
  });
  return created[0];
}

// ---- Cari / buat conversation ----
async function findOrCreateConversation(userId, customerId, productId) {
  let convs = await sb('conversations',
    `user_id=eq.${userId}&customer_id=eq.${customerId}&product_id=eq.${productId || null}&status=neq.selesai&limit=1`);
  if (!convs.length) {
    convs = await sb('conversations',
      `user_id=eq.${userId}&customer_id=eq.${customerId}&product_id=is.null&status=neq.selesai&limit=1`);
  }
  if (convs.length) return convs[0];
  const created = await sb('conversations', '', {
    method: 'POST',
    body: { user_id: userId, customer_id: customerId, product_id: productId || null, status: 'aktif', sumber: 'inbound', state: {} }
  });
  return created[0];
}

// ---- Build system prompt CRM ----
function buildSystemPrompt(user, product, customer, convState) {
  const persona = product?.persona_cs_nama || user?.nama_toko || 'Kak';
  const pk = product?.product_knowledge || '';
  const nama = customer?.nama;
  const produk = customer?.produk;
  const tglDelivered = customer?.tgl_delivered;
  const resi = customer?.no_resi;
  const ekspedisi = customer?.ekspedisi;
  const rekening = user?.rekening || '';
  const totalRepeat = customer?.total_repeat || 0;

  return `Kamu adalah ${persona}, customer service post-purchase dari brand "${user?.nama_toko || 'kami'}".

Kamu sedang follow-up customer yang sudah pernah beli produk kami. Tugasmu:
1. Tanyakan kabar / perkembangan setelah pakai produk
2. Bantu jika ada pertanyaan atau keluhan
3. Jika sudah nyaman, tawarkan repeat order dengan sopan
4. Jangan terlalu agresif jualan, utamakan kepuasan customer

DATA CUSTOMER:
- Nama: ${nama || 'belum diketahui'}
- Produk yang dibeli: ${produk || '-'}
- Tanggal delivered: ${tglDelivered || '-'}
- No. Resi: ${resi || '-'} (${ekspedisi || '-'})
- Riwayat repeat order: ${totalRepeat}x
- Catatan: ${customer?.catatan || '-'}

${pk ? `PRODUCT KNOWLEDGE:\n${pk}` : ''}

${rekening ? `INFO PEMBAYARAN:\n${rekening}` : ''}

ATURAN PENTING:
- Bahasa Indonesia yang ramah dan natural, panggil "kak ${nama?.split(' ')[0] || ''}"
- Jangan langsung jualan di pesan pertama
- Kalau customer minta order lagi → konfirmasi produk, qty, alamat, metode bayar
- Kalau ada keluhan → empati dulu, bantu selesaikan
- Marker khusus (gunakan hanya jika sesuai):
  [REPEAT_ORDER: produk="..." qty=1 metode="COD/Transfer"] — saat customer confirm repeat order
  [ESCALATE] — jika butuh penanganan manusia

STATE PERCAKAPAN: ${JSON.stringify(convState || {})}`;
}

// ---- Process incoming message ----
async function processMessage(sessionId, from, messageText) {
  // Find user + product
  const ctx = await findUserBySession(sessionId);
  if (!ctx) return;
  const { user, product } = ctx;

  // Find / create customer
  const customer = await findOrCreateCustomer(user.id, product?.id, from);

  // Find / create conversation
  const conv = await findOrCreateConversation(user.id, customer.id, product?.id);
  let convState = (typeof conv.state === 'string' ? JSON.parse(conv.state) : conv.state) || {};

  // Skip AI jika eskalasi
  if (conv.eskalasi || convState.escalated) {
    await sb('conv_messages', '', { method: 'POST', prefer: 'return=minimal',
      body: { conversation_id: conv.id, isi: messageText, role: 'customer' } });
    return;
  }

  // Simpan pesan customer
  await sb('conv_messages', '', { method: 'POST', prefer: 'return=minimal',
    body: { conversation_id: conv.id, isi: messageText, role: 'customer' } });

  // Ambil 30 pesan terakhir
  const recentMsgs = await sb('conv_messages',
    `conversation_id=eq.${conv.id}&order=created_at.desc&limit=30`);
  const messages = recentMsgs.reverse().map(m => ({
    role: m.role === 'customer' ? 'user' : 'assistant',
    content: m.isi || ''
  }));

  // Trim trailing assistant (Claude SDK requirement)
  while (messages.length && messages[messages.length - 1].role === 'assistant') messages.pop();
  if (!messages.length) return;

  // Get API key
  const apiKey = user.anthropic_key || process.env.ANTHROPIC_KEY;
  if (!apiKey) return;

  const client = new Anthropic({ apiKey });
  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 512,
    system: buildSystemPrompt(user, product, customer, convState),
    messages
  });

  const rawReply = response.content[0]?.text?.trim() || '';
  if (!rawReply) return;

  // ---- Detect markers ----
  const repeatMatch = rawReply.match(/\[REPEAT_ORDER:([^\]]+)\]/);
  const escalateMatch = rawReply.match(/\[ESCALATE\]/);

  // Clean reply (hapus marker sebelum kirim ke customer)
  let cleanReply = rawReply
    .replace(/\[REPEAT_ORDER:[^\]]+\]/g, '')
    .replace(/\[ESCALATE\]/g, '')
    .trim();

  // Handle REPEAT_ORDER
  if (repeatMatch) {
    const params = repeatMatch[1];
    const produkMatch = params.match(/produk="([^"]+)"/);
    const qtyMatch    = params.match(/qty=(\d+)/);
    const metodeMatch = params.match(/metode="([^"]+)"/);

    convState.repeat_pending = {
      produk:  produkMatch?.[1]  || customer.produk,
      qty:     parseInt(qtyMatch?.[1]) || 1,
      metode:  metodeMatch?.[1]  || 'COD'
    };

    // Increment repeat order count
    await sb('customers', `id=eq.${customer.id}`, {
      method: 'PATCH',
      body: { total_repeat: (customer.total_repeat || 0) + 1, status: 'repeat' }
    });
  }

  // Handle ESCALATE
  if (escalateMatch) {
    convState.escalated = true;
    await sb('conversations', `id=eq.${conv.id}`, { method: 'PATCH', body: { eskalasi: true } });
  }

  // Simpan reply AI
  await sb('conv_messages', '', { method: 'POST', prefer: 'return=minimal',
    body: { conversation_id: conv.id, isi: cleanReply, role: 'ai' } });

  // Update conversation state + timestamp
  await sb('conversations', `id=eq.${conv.id}`, {
    method: 'PATCH',
    body: { state: convState, updated_at: new Date().toISOString() }
  });

  // Kirim WA
  await sendWA(sessionId, from, cleanReply);
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // Vercel responds 200 immediately, process async
  res.status(200).json({ ok: true });

  const { sessionId, from, body: msgBody } = req.body || {};
  if (!from || !msgBody || !sessionId) return;

  // Only process text messages from individuals (not groups)
  if (from.includes('@g.us')) return;
  if (typeof msgBody !== 'string' || !msgBody.trim()) return;

  // Debounce: tunggu 2.5s kumpulkan pesan sebelum proses
  const key = `${sessionId}:${from}`;
  clearTimeout(debounceMap.get(key));
  debounceMap.set(key, setTimeout(async () => {
    debounceMap.delete(key);
    try {
      await processMessage(sessionId, from, msgBody.trim());
    } catch(e) {
      console.error('webhook error', e.message);
    }
  }, DEBOUNCE_MS));
}
