// api/analyze-conversations.js
// Belajar dari percakapan selesai: ekstrak pola closing, objeksi, cara mengatasinya
// POST /api/analyze-conversations
// Header: x-cron-secret   (dari cron) atau x-user-id + auth cookie (dari UI button)
// Body:   { user_id, limit: 20, force: false }
//
// Output → tabel closing_insights: pola objeksi + respons efektif + closing signal

const SB_URL      = process.env.SUPABASE_URL;
const SB_KEY      = process.env.SUPABASE_SERVICE_KEY;
const CRON_SECRET = process.env.CRON_SECRET || 'adsysukses2026';
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;

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

// Tentukan outcome: apakah percakapan berakhir dengan pembelian?
// Cek apakah ada order yang dibuat setelah conversation dimulai untuk customer ini
async function determineOutcome(conv, userId) {
  try {
    // Cek repeat_order di state conversation
    const state = conv.state || {};
    if (state.repeat_order === true) return 'closed';

    // Cek tabel repeat_orders
    const repeatOrders = await sb('repeat_orders',
      `conversation_id=eq.${conv.id}&limit=1`);
    if (repeatOrders.length) return 'closed';

    // Cek tabel orders: ada order setelah conversation dibuat?
    const custId = conv.customer_id;
    const convCreated = conv.created_at;
    const orders = await sb('orders',
      `user_id=eq.${userId}&created_at=gte.${convCreated}&limit=1&select=id`);

    // Tidak bisa direct query by customer — gunakan conv messages sebagai signal
    // Jika ada msg dari AI berisi konfirmasi order / "terima kasih sudah order" dll → closed
    const msgs = conv._messages || [];
    const fullText = msgs.map(m => m.isi || '').join(' ').toLowerCase();

    const closingPhrases = [
      'terima kasih sudah order', 'pesanan sudah kami catat', 'sudah kami proses',
      'repeat_order_confirmed', 'orderan sudah masuk', 'nanti kami kirimkan',
      'oke kita proses', 'siap kita proses', 'noted ya kak'
    ];
    if (closingPhrases.some(p => fullText.includes(p))) return 'closed';

    // Cek pesan customer terakhir — apakah terindikasi tidak jadi
    const lastCustomerMsgs = msgs.filter(m => m.role === 'user').slice(-3);
    const lastText = lastCustomerMsgs.map(m => m.isi || '').join(' ').toLowerCase();
    const noClosePhrases = [
      'gak jadi', 'ga jadi', 'cancel', 'nanti aja', 'belum butuh',
      'kemahalan', 'terlalu mahal', 'skip dulu', 'tidak jadi'
    ];
    if (noClosePhrases.some(p => lastText.includes(p))) return 'not_closed';

    return 'unknown';
  } catch {
    return 'unknown';
  }
}

async function analyzeWithClaude(conversations, apiKey) {
  const key = apiKey || ANTHROPIC_KEY;
  if (!key) throw new Error('ANTHROPIC_KEY belum diset');

  // Format conversations untuk dikirim ke Claude
  const convTexts = conversations.map((conv, i) => {
    const msgs = (conv._messages || []).slice(0, 30); // max 30 pesan per conv
    const lines = msgs.map(m => {
      const role = m.role === 'user' ? 'CUSTOMER' : 'CS/BOT';
      return `${role}: ${(m.isi || '').slice(0, 300)}`;
    }).join('\n');
    return `--- PERCAKAPAN ${i + 1} (outcome: ${conv._outcome}) ---\n${lines}`;
  }).join('\n\n');

  const { default: Anthropic } = await import('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: key });

  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    system: `Kamu adalah analis penjualan yang ahli membaca percakapan WhatsApp antara customer dan CS/bot.
Tugasmu: analisis percakapan yang diberikan dan ekstrak:
1. Pola objeksi customer (keberatan sebelum beli / alasan tidak jadi beli)
2. Sinyal closing (tanda-tanda customer mau beli)
3. Respons yang terbukti berhasil mengatasi keberatan

Balas dalam format JSON yang valid. HANYA JSON, tidak ada teks lain.`,
    messages: [{
      role: 'user',
      content: `Analisis percakapan berikut:\n\n${convTexts}\n\n
Balas dengan JSON format:
{
  "objections": [
    {
      "type": "harga|kualitas|kepercayaan|waktu|pesaing|stok|pengiriman|lainnya",
      "label": "label singkat (maks 5 kata)",
      "keywords": ["kata1", "kata2"],
      "example_trigger": "contoh kalimat customer",
      "successful_response": "contoh respons CS yang berhasil atasi objeksi ini (jika ada di percakapan)",
      "why_it_works": "penjelasan singkat mengapa respons ini efektif",
      "from_closed": true|false
    }
  ],
  "closing_signals": [
    {
      "label": "label sinyal closing",
      "keywords": ["kata1", "kata2"],
      "example": "contoh kalimat customer yang menunjukkan sinyal ini",
      "recommended_action": "apa yang harus dilakukan CS saat sinyal ini muncul"
    }
  ],
  "success_patterns": [
    {
      "label": "pola yang selalu berhasil",
      "pattern": "deskripsi pola komunikasi yang efektif",
      "example": "contoh dari percakapan"
    }
  ]
}`
    }]
  });

  const raw = msg.content[0].text.trim();
  // Extract JSON dari response
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude tidak return valid JSON');
  return JSON.parse(jsonMatch[0]);
}

async function upsertInsights(userId, insights) {
  const now = new Date().toISOString();
  const toUpsert = [];

  // Process objections
  for (const obj of (insights.objections || [])) {
    if (!obj.label) continue;
    toUpsert.push({
      user_id: userId,
      type: 'objection',
      objection_type: obj.type || 'lainnya',
      label: obj.label,
      keywords: obj.keywords || [],
      example_trigger: obj.example_trigger || null,
      successful_response: obj.successful_response || null,
      why_it_works: obj.why_it_works || null,
      from_closed: obj.from_closed || false,
      updated_at: now
    });
  }

  // Process closing signals
  for (const sig of (insights.closing_signals || [])) {
    if (!sig.label) continue;
    toUpsert.push({
      user_id: userId,
      type: 'closing_signal',
      objection_type: null,
      label: sig.label,
      keywords: sig.keywords || [],
      example_trigger: sig.example || null,
      successful_response: sig.recommended_action || null,
      why_it_works: null,
      from_closed: true,
      updated_at: now
    });
  }

  // Process success patterns
  for (const pat of (insights.success_patterns || [])) {
    if (!pat.label) continue;
    toUpsert.push({
      user_id: userId,
      type: 'success_pattern',
      objection_type: null,
      label: pat.label,
      keywords: [],
      example_trigger: pat.example || null,
      successful_response: pat.pattern || null,
      why_it_works: null,
      from_closed: true,
      updated_at: now
    });
  }

  if (!toUpsert.length) return 0;

  // Upsert — match by user_id + type + label (ON CONFLICT update frequency + data)
  // Supabase tidak support ON CONFLICT UPDATE via REST langsung
  // Workaround: GET existing by label, PATCH jika ada, POST jika belum
  let upserted = 0;
  for (const item of toUpsert) {
    const labelEnc = encodeURIComponent(item.label);
    const existing = await sb('closing_insights',
      `user_id=eq.${userId}&type=eq.${item.type}&label=eq.${labelEnc}&select=id,frequency`
    ).catch(() => []);

    if (existing.length) {
      // Update: increment frequency + refresh data
      await sb('closing_insights', `id=eq.${existing[0].id}`, {
        method: 'PATCH',
        body: {
          ...item,
          frequency: (existing[0].frequency || 1) + 1
        }
      });
    } else {
      await sb('closing_insights', '', {
        method: 'POST',
        body: { ...item, frequency: 1, created_at: now }
      });
    }
    upserted++;
  }
  return upserted;
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  // Auth: cron secret atau user via session
  const cronSecret = req.headers['x-cron-secret'];
  const { user_id, limit = 30, force = false } = req.body || {};

  if (cronSecret !== CRON_SECRET && !user_id) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const userId = user_id;
  if (!userId) return res.status(400).json({ error: 'user_id required' });

  try {
    // Fetch conversations selesai yang belum dianalisis (atau force re-analisis)
    const convQ = force
      ? `user_id=eq.${userId}&status=eq.selesai&order=updated_at.desc&limit=${limit}&select=id,customer_id,state,created_at,sumber`
      : `user_id=eq.${userId}&status=eq.selesai&analyzed_for_closing=is.null&order=updated_at.desc&limit=${limit}&select=id,customer_id,state,created_at,sumber`;

    const convs = await sb('conversations', convQ);
    if (!convs.length) {
      return res.json({ analyzed: 0, insights_saved: 0, message: 'Tidak ada percakapan baru untuk dianalisis' });
    }

    // Fetch messages untuk setiap conversation
    for (const conv of convs) {
      conv._messages = await sb('conv_messages',
        `conversation_id=eq.${conv.id}&order=created_at.asc&limit=40&select=role,isi,created_at`
      ).catch(() => []);
      conv._outcome = await determineOutcome(conv, userId);
    }

    // Filter: hanya yang punya minimal 4 pesan (percakapan berarti)
    const meaningful = convs.filter(c => c._messages.length >= 4);
    if (!meaningful.length) {
      return res.json({ analyzed: 0, insights_saved: 0, message: 'Tidak ada percakapan dengan minimal 4 pesan' });
    }

    // Ambil API key user
    const userRow = await sb('users', `id=eq.${userId}&select=anthropic_key`);
    const apiKey = userRow[0]?.anthropic_key || ANTHROPIC_KEY;

    // Analisis dalam batch (maks 10 conv per Claude call)
    const batchSize = 10;
    let totalInsights = 0;
    let analyzedCount = 0;

    for (let i = 0; i < meaningful.length; i += batchSize) {
      const batch = meaningful.slice(i, i + batchSize);
      try {
        const insights = await analyzeWithClaude(batch, apiKey);
        const saved = await upsertInsights(userId, insights);
        totalInsights += saved;
        analyzedCount += batch.length;

        // Mark conversations as analyzed
        const ids = batch.map(c => c.id);
        for (const id of ids) {
          await sb('conversations', `id=eq.${id}`, {
            method: 'PATCH',
            body: { analyzed_for_closing: true }
          }).catch(() => {});
        }
      } catch(e) {
        console.error('[analyze-conversations] batch error:', e.message);
      }
    }

    return res.json({
      analyzed: analyzedCount,
      insights_saved: totalInsights,
      total_convs: convs.length,
      meaningful_convs: meaningful.length
    });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
}
