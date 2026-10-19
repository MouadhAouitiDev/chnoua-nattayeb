// GET  /api/chips           -> { chips: [...] | null }   (public)
// POST /api/chips           -> admin only, header x-admin-password
//        { action: "login" }            checks the password
//        { chips: [{ar,fr,en}, ...] }   saves the list
// Env vars: ADMIN_PASSWORD, and a Redis from the Vercel Marketplace (Upstash):
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN  (or KV_REST_API_URL + KV_REST_API_TOKEN)

import { createHash, timingSafeEqual } from 'node:crypto';

const KEY = 'chnoua:chips';
const MAX_CHIPS = 60;
const MAX_LEN = 40;
const fails = new Map(); // ip -> [timestamps]

const redisUrl = () => process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const redisToken = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

async function redis(cmd) {
  const r = await fetch(redisUrl(), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + redisToken(), 'content-type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).result;
}

const sha = s => createHash('sha256').update(String(s)).digest();
const samePassword = (a, b) => timingSafeEqual(sha(a), sha(b));

function blocked(ip) {
  const now = Date.now();
  const list = (fails.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  fails.set(ip, list);
  return list.length >= 5;
}
const noteFail = ip => fails.set(ip, [...(fails.get(ip) || []), Date.now()]);

function clean(input) {
  if (!Array.isArray(input) || input.length > MAX_CHIPS) return null;
  const out = [];
  for (const c of input) {
    if (!c || typeof c !== 'object') return null;
    const item = {};
    for (const l of ['ar', 'fr', 'en']) {
      const v = typeof c[l] === 'string' ? c[l].trim() : '';
      if (!v || v.length > MAX_LEN || /[<>]/.test(v) || /[,،]/.test(v)) return null;
      item[l] = v;
    }
    out.push(item);
  }
  return out;
}

export default async function handler(req, res) {
  const hasStorage = Boolean(redisUrl() && redisToken());

  if (req.method === 'GET') {
    res.setHeader('Cache-Control', req.query && req.query.fresh ? 'no-store' : 'public, s-maxage=30, stale-while-revalidate=60');
    if (!hasStorage) return res.status(200).json({ chips: null });
    try {
      const raw = await redis(['GET', KEY]);
      const chips = raw ? clean(JSON.parse(raw)) : null;
      return res.status(200).json({ chips });
    } catch (e) {
      console.error(e);
      return res.status(200).json({ chips: null });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });

  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (blocked(ip)) return res.status(429).json({ error: 'locked' });
  if (!process.env.ADMIN_PASSWORD) return res.status(500).json({ error: 'config' });

  const pass = req.headers['x-admin-password'] || '';
  if (!samePassword(pass, process.env.ADMIN_PASSWORD)) {
    noteFail(ip);
    return res.status(401).json({ error: 'password' });
  }

  const body = req.body || {};
  if (body.action === 'login') return res.status(200).json({ ok: true, storage: hasStorage });

  if (!hasStorage) return res.status(500).json({ error: 'storage' });
  const chips = clean(body.chips);
  if (!chips) return res.status(400).json({ error: 'invalid' });

  try {
    await redis(['SET', KEY, JSON.stringify(chips)]);
    return res.status(200).json({ ok: true, count: chips.length });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server' });
  }
}
