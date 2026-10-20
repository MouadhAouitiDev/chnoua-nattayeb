// POST /api/auth { action, ... }   GET /api/auth -> current user
// Actions: register, login, logout, me, fav_list, fav_add, fav_remove
// Needs the Redis (Upstash) connected in Vercel. Passwords are hashed with scrypt, never stored in clear.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { hasStorage, redis, cookie, getUser, clientIp } from './_lib.js';

const SESSION = 30 * 86400;
const COOKIE = 'HttpOnly; Secure; SameSite=Lax; Path=/';
const tries = new Map();

function limited(ip) {
  const now = Date.now();
  const l = (tries.get(ip) || []).filter(t => now - t < 15 * 60 * 1000);
  l.push(now); tries.set(ip, l);
  return l.length > 12;
}
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const hash = (pw, salt) => scryptSync(pw, salt, 64);

function cleanRecipe(r) {
  if (!r || typeof r !== 'object') return null;
  const nom = str(r.nom, 120);
  if (!nom) return null;
  const arr = a => (Array.isArray(a) ? a.slice(0, 30).map(x => str(String(x), 400)).filter(Boolean) : []);
  return { nom, temps: str(r.temps, 60), portions: str(r.portions, 60), en_plus: arr(r.en_plus), etapes: arr(r.etapes) };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (!hasStorage()) return res.status(200).json({ storage: false });

  const b = req.method === 'POST' ? (req.body || {}) : {};
  const action = req.method === 'POST' ? b.action : 'me';
  const fail = (code, error) => res.status(code).json({ error });

  try {
    if (action === 'me') {
      const email = await getUser(req);
      return res.status(200).json({ storage: true, user: email ? { email } : null });
    }
    if (req.method !== 'POST') return fail(405, 'method');

    if (action === 'register' || action === 'login') {
      if (limited(clientIp(req))) return fail(429, 'locked');
      const email = str(b.email, 100).toLowerCase();
      const pw = typeof b.password === 'string' ? b.password : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(400, 'email');
      if (pw.length < 8 || pw.length > 100) return fail(400, 'password');
      const key = 'user:' + email;

      if (action === 'register') {
        const salt = randomBytes(16);
        const rec = JSON.stringify({ salt: salt.toString('hex'), hash: hash(pw, salt).toString('hex') });
        if ((await redis(['SET', key, rec, 'NX'])) !== 'OK') return fail(409, 'exists');
      } else {
        const raw = await redis(['GET', key]);
        const u = raw ? JSON.parse(raw) : null;
        const h = hash(pw, u ? Buffer.from(u.salt, 'hex') : randomBytes(16));
        if (!u || !timingSafeEqual(h, Buffer.from(u.hash, 'hex'))) return fail(401, 'credentials');
      }
      const token = randomBytes(32).toString('hex');
      await redis(['SET', 'sess:' + token, email, 'EX', SESSION]);
      res.setHeader('Set-Cookie', `sid=${token}; ${COOKIE}; Max-Age=${SESSION}`);
      return res.status(200).json({ user: { email } });
    }

    if (action === 'logout') {
      const t = cookie(req, 'sid');
      if (/^[a-f0-9]{64}$/.test(t)) await redis(['DEL', 'sess:' + t]);
      res.setHeader('Set-Cookie', `sid=; ${COOKIE}; Max-Age=0`);
      return res.status(200).json({ ok: true });
    }

    const email = await getUser(req);
    if (!email) return fail(401, 'login');
    const fk = 'favs:' + email;
    const load = async () => { const raw = await redis(['GET', fk]); return raw ? JSON.parse(raw) : []; };

    if (action === 'fav_list') return res.status(200).json({ favs: await load() });
    if (action === 'fav_add') {
      const r = cleanRecipe(b.recipe);
      if (!r) return fail(400, 'invalid');
      const favs = await load();
      if (!favs.some(f => f.nom === r.nom)) {
        if (favs.length >= 50) return fail(400, 'full');
        favs.unshift({ id: randomBytes(6).toString('hex'), ...r });
        await redis(['SET', fk, JSON.stringify(favs)]);
      }
      return res.status(200).json({ favs });
    }
    if (action === 'fav_remove') {
      const favs = (await load()).filter(f => f.id !== b.id);
      await redis(['SET', fk, JSON.stringify(favs)]);
      return res.status(200).json({ favs });
    }
    return fail(400, 'invalid');
  } catch (e) {
    console.error(e);
    return fail(500, 'server');
  }
}
