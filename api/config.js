// api/config.js — expose env vars ke frontend (non-secret)
export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.json({
    supabase_url: process.env.SUPABASE_URL || '',
    supabase_anon_key: process.env.SUPABASE_ANON_KEY || '',
    baileys_url: process.env.BAILEYS_URL || '',
  });
}
