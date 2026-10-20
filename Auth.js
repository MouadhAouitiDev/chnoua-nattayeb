// POST /api/auth  { action, ... }  -> accounts + favourite recipes (stored in Redis)
// actions: signup, login, logout, me, fav_list, fav_add, fav_del
// Needs the Redis from the Vercel Marketplace (Upstash): UPSTASH_REDIS_REST_URL/TOKEN or KV_REST_API_URL/TOKEN.

import { randomBytes, scrypt as _scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
const scrypt = promisify(_scrypt);

const rUrl = () => process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const rTok = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;
const SESSION_SECONDS = 60 * 60 * 24 * 30;
const MAX_FAVS = 30;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const tries = new Map();

async function redis(cmd) {
  const r = await fetch(rUrl(), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + rTok(), 'content-type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).result;
}

const limited = ip => {
  const now = Date.now();
  const l = (tries.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  l.push(now); tries.set(ip, l);
  return l.length > 20;
};
const cookie = (req, name) => {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|; )' + name + '=([^;]+)'));
  return m ? m[1] : null;
};
const setCookie = (res, value, maxAge) =>
  res.setHeader('Set-Cookie', `sid=${value}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`);
const hashPw = async (pw, salt) => (await scrypt(pw, salt, 64)).toString('hex');

async function sessionEmail(req) {
  const sid = cookie(req, 'sid');
  if (!sid || !/^[a-f0-9]{64}$/.test(sid)) return null;
  return await redis(['GET', 'sess:' + sid]);
}
async function startSession(res, email) {
  const sid = randomBytes(32).toString('hex');
  await redis(['SET', 'sess:' + sid, email, 'EX', SESSION_SECONDS]);
  setCookie(res, sid, SESSION_SECONDS);
}

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v.trim() : null);
function cleanRecipe(r) {
  if (!r || typeof r !== 'object') return null;
  const nom = str(r.nom, 100);
  if (!nom) return null;
  const list = (a, n, max) => Array.isArray(a) && a.length <= n && a.every(x => typeof x === 'string' && x.length <= max) ? a.map(x => x.trim()) : null;
  const en_plus = list(r.en_plus || [], 20, 120);
  const etapes = list(r.etapes || [], 20, 400);
  if (!en_plus || !etapes) return null;
  return { nom, temps: str(r.temps || '', 60) || '', portions: str(r.portions || '', 60) || '', en_plus, etapes };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'server' });
  if (!(rUrl() && rTok())) {
    const a = (req.body || {}).action;
    return a === 'me' ? res.status(200).json({ email: null }) : res.status(500).json({ error: 'storage' });
  }
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  const body = req.body || {};

  try {
    if (body.action === 'me') return res.status(200).json({ email: await sessionEmail(req) });

    if (body.action === 'signup' || body.action === 'login') {
      if (limited(ip)) return res.status(429).json({ error: 'limit' });
      const email = str(body.email, 120)?.toLowerCase();
      const password = typeof body.password === 'string' ? body.password : '';
      if (!email || !EMAIL_RE.test(email)) return res.status(400).json({ error: 'invalid_email' });
      if (password.length < 8 || password.length > 100) {
        return res.status(400).json({ error: body.action === 'signup' ? 'weak' : 'credentials' });
      }
      if (body.action === 'signup') {
        const salt = randomBytes(16).toString('hex');
        const ok = await redis(['SET', 'user:' + email, JSON.stringify({ salt, hash: await hashPw(password, salt) }), 'NX']);
        if (!ok) return res.status(409).json({ error: 'exists' });
        await startSession(res, email);
        return res.status(200).json({ email });
      }
      const raw = await redis(['GET', 'user:' + email]);
      if (!raw) return res.status(401).json({ error: 'credentials' });
      const u = JSON.parse(raw);
      const a = Buffer.from(await hashPw(password, u.salt), 'hex');
      const b = Buffer.from(u.hash, 'hex');
      if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ error: 'credentials' });
      await startSession(res, email);
      return res.status(200).json({ email });
    }

    if (body.action === 'logout') {
      const sid = cookie(req, 'sid');
      if (sid && /^[a-f0-9]{64}$/.test(sid)) await redis(['DEL', 'sess:' + sid]);
      setCookie(res, '', 0);
      return res.status(200).json({ ok: true });
    }

    const email = await sessionEmail(req);
    if (!email) return res.status(401).json({ error: 'auth' });
    const key = 'fav:' + email;
    const favs = JSON.parse((await redis(['GET', key])) || '[]');

    if (body.action === 'fav_list') return res.status(200).json({ favs });
    if (body.action === 'fav_add') {
      const recipe = cleanRecipe(body.recipe);
      if (!recipe) return res.status(400).json({ error: 'invalid' });
      if (favs.length >= MAX_FAVS) return res.status(400).json({ error: 'full' });
      const fav = { id: randomBytes(6).toString('hex'), ...recipe };
      favs.unshift(fav);
      await redis(['SET', key, JSON.stringify(favs)]);
      return res.status(200).json({ fav });
    }
    if (body.action === 'fav_del') {
      const next = favs.filter(f => f.id !== body.id);
      await redis(['SET', key, JSON.stringify(next)]);
      return res.status(200).json({ ok: true });
    }
    return res.status(400).json({ error: 'invalid' });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: 'server' });
  }
}
