// GET  /api/chips  -> { shelf: [ {ar,fr,en,items:[{ar,fr,en}]} ] | null }   (public)
// POST /api/chips  -> admin only (header x-admin-password)
//        { action: "login" }  |  { shelf: [...] }
// Env: ADMIN_PASSWORD + Redis (Upstash) from the Vercel Marketplace.
import { hasStorage, redis, checkAdmin } from './_lib.js';

const KEY = 'chnoua:shelf';
const name = v => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && s.length <= 40 && !/[<>,،]/.test(s) ? s : null;
};

function cleanShelf(input) {
  if (!Array.isArray(input) || input.length > 12) return null;
  const out = [];
  for (const c of input) {
    if (!c || typeof c !== 'object' || !Array.isArray(c.items) || c.items.length > 40) return null;
    const cat = {};
    for (const l of ['ar', 'fr', 'en']) { const v = name(c[l]); if (!v) return null; cat[l] = v; }
    cat.items = [];
    for (const it of c.items) {
      if (!it || typeof it !== 'object') return null;
      const o = {};
      for (const l of ['ar', 'fr', 'en']) { const v = name(it[l]); if (!v) return null; o[l] = v; }
      cat.items.push(o);
    }
    out.push(cat);
  }
  return out;
}

export default async function handler(req, res) {
  const storage = hasStorage();

  if (req.method === 'GET') {
    res.setHeader('Cache-Control', req.query && req.query.fresh ? 'no-store' : 'public, s-maxage=30, stale-while-revalidate=60');
    if (!storage) return res.status(200).json({ shelf: null });
    try {
      const raw = await redis(['GET', KEY]);
      return res.status(200).json({ shelf: raw ? cleanShelf(JSON.parse(raw)) : null });
    } catch (e) { console.error(e); return res.status(200).json({ shelf: null }); }
  }
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const denied = await checkAdmin(req);
  if (denied) return res.status(denied.code).json({ error: denied.error });
  const body = req.body || {};
  if (body.action === 'login') return res.status(200).json({ ok: true, storage });
  if (!storage) return res.status(500).json({ error: 'storage' });
  const shelf = cleanShelf(body.shelf);
  if (!shelf) return res.status(400).json({ error: 'invalid' });
  try {
    await redis(['SET', KEY, JSON.stringify(shelf)]);
    return res.status(200).json({ ok: true, count: shelf.reduce((n, c) => n + c.items.length, 0) });
  } catch (e) { console.error(e); return res.status(500).json({ error: 'server' }); }
}
