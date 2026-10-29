// File location: api/auth.js (Vercel only serves functions from /api, lowercase name)
// POST /api/auth { action, ... }   GET /api/auth -> current user
// Actions: register, login, logout, me, fav_list, fav_add, fav_remove
// Needs the Redis (Upstash) connected in Vercel. Passwords are hashed with scrypt, never stored in clear.
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { hasStorage, redis, pipeline, cookie, getUser, clientIp, today } from './_lib.js';

const SESSION = 30 * 86400;
// 'Secure' only over https, otherwise the cookie is dropped on http://localhost and login "succeeds" without a session
const cookieFlags = req => 'HttpOnly; SameSite=Lax; Path=/' + (((req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https' || req.socket?.encrypted) ? '; Secure' : '');
const WINDOW = 15 * 60 * 1000, MAX_STRIKES = 10;
const tries = new Map();

// Only failures / signups count (typos in the form must not lock people out; mobile carriers share IPs)
const strikes = ip => { const now = Date.now(), l = (tries.get(ip) || []).filter(t => now - t < WINDOW); tries.set(ip, l); return l; };
const locked = ip => strikes(ip).length >= MAX_STRIKES;
const strike = ip => strikes(ip).push(Date.now());
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
  const b = req.method === 'POST' && req.body && typeof req.body === 'object' ? req.body : {};
  const action = req.method === 'POST' ? b.action : 'me';
  const fail = (code, error) => res.status(code).json({ error });
  // Do not pretend signup/login succeeded when persistent storage is missing.
  // GET still answers 200 so the page can tell "not configured" apart from "server down".
  if (!hasStorage()) return action === 'me' ? res.status(200).json({ storage: false, user: null }) : fail(503, 'storage_config');

  try {
    if (action === 'me') {
      const email = await getUser(req);
      return res.status(200).json({ storage: true, user: email ? { email } : null });
    }
    if (req.method !== 'POST') return fail(405, 'method');

    // Public site feedback: no account required; the latest 200 reviews are kept, plus all-time totals for the admin page.
    if (action === 'review') {
      const rating = Number(b.rating);
      const comment = str(b.comment, 500).replace(/[\u0000-\u0008\u000b-\u001f]/g, '');
      if (!Number.isInteger(rating) || rating < 1 || rating > 5) return fail(400, 'invalid');
      // max 5 reviews per IP per day, so one person cannot push every real review out of the list
      const rk = `revlimit:${clientIp(req)}:${today()}`;
      const [n] = await pipeline([['INCR', rk], ['EXPIRE', rk, 90000]]);
      if (n > 5) return fail(429, 'rate');
      const page = str(b.page, 60);
      const review = JSON.stringify({ id: randomBytes(6).toString('hex'), rating, comment, page, lang: str(b.lang, 5), createdAt: new Date().toISOString() });
      await pipeline([
        ['LPUSH', 'site:reviews', review], ['LTRIM', 'site:reviews', '0', '199'],
        ['INCR', 'reviews:count'], ['INCRBY', 'reviews:sum', rating], ['HINCRBY', 'reviews:dist', String(rating), 1]
      ]);
      return res.status(200).json({ ok: true });
    }

    if (action === 'register' || action === 'login') {
      const ip = clientIp(req);
      if (locked(ip)) return fail(429, 'locked');
      const email = str(b.email, 100).toLowerCase();
      const pw = typeof b.password === 'string' ? b.password : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(400, 'email');
      if (pw.length < 8 || pw.length > 100) return fail(400, 'password');
      const key = 'user:' + email;

      if (action === 'register') {
        const salt = randomBytes(16);
        const rec = JSON.stringify({ salt: salt.toString('hex'), hash: hash(pw, salt).toString('hex') });
        if ((await redis(['SET', key, rec, 'NX'])) !== 'OK') { strike(ip); return fail(409, 'exists'); }
        strike(ip);
        const day = 'stats:signups:' + today();
        try {
          await pipeline([['INCR', 'stats:users'], ['INCR', day], ['EXPIRE', day, 120 * 86400],
            ['LPUSH', 'site:signups', JSON.stringify({ email, at: new Date().toISOString() })], ['LTRIM', 'site:signups', '0', '49']]);
        } catch (e) { console.error(e); }
      } else {
        const raw = await redis(['GET', key]);
        const u = raw ? JSON.parse(raw) : null;
        const h = hash(pw, u ? Buffer.from(u.salt, 'hex') : randomBytes(16));
        if (!u || !timingSafeEqual(h, Buffer.from(u.hash, 'hex'))) { strike(ip); return fail(401, 'credentials'); }
      }
      const token = randomBytes(32).toString('hex');
      await redis(['SET', 'sess:' + token, email, 'EX', SESSION]);
      res.setHeader('Set-Cookie', `sid=${token}; ${cookieFlags(req)}; Max-Age=${SESSION}`);
      // Return the favorites with the login so the client has one request less that can fail
      let favs = [];
      if (action === 'login') { try { const raw = await redis(['GET', 'favs:' + email]); favs = raw ? JSON.parse(raw) : []; } catch (e) { console.error(e); } }
      return res.status(200).json({ user: { email }, favs });
    }

    if (action === 'logout') {
      const t = cookie(req, 'sid');
      if (/^[a-f0-9]{64}$/.test(t)) await redis(['DEL', 'sess:' + t]);
      res.setHeader('Set-Cookie', `sid=; ${cookieFlags(req)}; Max-Age=0`);
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
