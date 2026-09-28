// No-op webhook — untuk session duplikat (2 session 1 nomor WA)
// Cukup return 200 tanpa proses apapun
export default function handler(req, res) {
  return res.status(200).json({ ok: true, skipped: 'noop' });
}
