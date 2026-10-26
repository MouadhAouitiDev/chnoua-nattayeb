// File location: api/auth.js (Vercel only serves functions from /api, lowercase name)
import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { hasStorage, redis, cookie, getUser, clientIp } from './_lib.js';

const SESSION = 30 * 86400;
const cookieFlags = req => 'HttpOnly; SameSite=Lax; Path=/' + (((req.headers['x-forwarded-proto'] || '').split(',')[0] === 'https' || req.socket?.encrypted) ? '; Secure' : '');
const WINDOW = 15 * 60 * 1000, MAX_STRIKES = 10;
const tries = new Map();

const strikes = ip => { const now = Date.now(), l = (tries.get(ip) || []).filter(t => now - t < WINDOW); tries.set(ip, l); return l; };
const locked = ip => strikes(ip).length >= MAX_STRIKES;
const strike = ip => strikes(ip).push(Date.now());
const str = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const hash = (pw, salt) => scryptSync(pw, salt, 64);

// Fallback memory storage ken Redis mouch mconfiguré
const memoryStore = new Map();
const memorySessions = new Map();
const memoryFavs = new Map();

function cleanRecipe(r) {
  if (!r || typeof r !== 'object') return null;
  const nom = str(r.nom, 120);
  if (!nom) return null;
  const arr = a => (Array.isArray(a) ? a.slice(0, 30).map(x => str(String(x), 400)).filter(Boolean) : []);
  return { nom, temps: str(r.temps, 60), portions: str(r.portions, 60), en_plus: arr(r.en_plus), etapes: arr(r.etapes) };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  
  const useRedis = hasStorage();

  const b = req.method === 'POST' ? (req.body || {}) : {};
  const action = req.method === 'POST' ? b.action : 'me';
  const fail = (code, error) => res.status(code).json({ error });

  try {
    if (action === 'me') {
      let email = null;
      if (useRedis) {
        email = await getUser(req);
      } else {
        const t = cookie(req, 'sid');
        email = memorySessions.get(t) || null;
      }
      return res.status(200).json({ storage: useRedis, user: email ? { email } : null });
    }
    if (req.method !== 'POST') return fail(405, 'method');

    if (action === 'register' || action === 'login') {
      const ip = clientIp(req);
      if (locked(ip)) return fail(429, 'locked');
      const email = str(b.email, 100).toLowerCase();
      const pw = typeof b.password === 'string' ? b.password : '';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) return fail(400, 'email');
      if (pw.length < 8 || pw.length > 100) return fail(400, 'password');
      const key = 'user:' + email;

      if (useRedis) {
        if (action === 'register') {
          const salt = randomBytes(16);
          const rec = JSON.stringify({ salt: salt.toString('hex'), hash: hash(pw, salt).toString('hex') });
          if ((await redis(['SET', key, rec, 'NX'])) !== 'OK') { strike(ip); return fail(409, 'exists'); }
          strike(ip);
        } else {
          const raw = await redis(['GET', key]);
          const u = raw ? JSON.parse(raw) : null;
          const h = hash(pw, u ? Buffer.from(u.salt, 'hex') : randomBytes(16));
          if (!u || !timingSafeEqual(h, Buffer.from(u.hash, 'hex'))) { strike(ip); return fail(401, 'credentials'); }
        }
      } else {
        // Mode Local / Mémoire Fallback
        if (action === 'register') {
          if (memoryStore.has(email)) { strike(ip); return fail(409, 'exists'); }
          const salt = randomBytes(16);
          memoryStore.set(email, { salt: salt.toString('hex'), hash: hash(pw, salt).toString('hex') });
          strike(ip);
        } else {
          const u = memoryStore.get(email);
          const h = hash(pw, u ? Buffer.from(u.salt, 'hex') : randomBytes(16));
          if (!u || !timingSafeEqual(h, Buffer.from(u.hash, 'hex'))) { strike(ip); return fail(401, 'credentials'); }
        }
      }

      const token = randomBytes(32).toString('hex');
      if (useRedis) {
        await redis(['SET', 'sess:' + token, email, 'EX', SESSION]);
      } else {
        memorySessions.set(token, email);
      }

      res.setHeader('Set-Cookie', `sid=${token}; ${cookieFlags(req)}; Max-Age=${SESSION}`);
      
      let favs = [];
      if (action === 'login') { 
        try { 
          if (useRedis) {
            const raw = await redis(['GET', 'favs:' + email]); 
            favs = raw ? JSON.parse(raw) : []; 
          } else {
            favs = memoryFavs.get(email) || [];
          }
        } catch (e) { console.error(e); } 
      }
      return res.status(200).json({ user: { email }, favs });
    }

    if (action === 'logout') {
      const t = cookie(req, 'sid');
      if (/^[a-f0-9]{64}$/.test(t)) {
        if (useRedis) {
          await redis(['DEL', 'sess:' + t]);
        } else {
          memorySessions.delete(t);
        }
      }
      res.setHeader('Set-Cookie', `sid=; ${cookieFlags(req)}; Max-Age=0`);
      return res.status(200).json({ ok: true });
    }

    let email = null;
    if (useRedis) {
      email = await getUser(req);
    } else {
      const t = cookie(req, 'sid');
      email = memorySessions.get(t) || null;
    }

    if (!email) return fail(401, 'login');
    const fk = 'favs:' + email;
    
    const load = async () => { 
      if (useRedis) {
        const raw = await redis(['GET', fk]); 
        return raw ? JSON.parse(raw) : []; 
      } else {
        return memoryFavs.get(email) || [];
      }
    };

    const save = async (favs) => {
      if (useRedis) {
        await redis(['SET', fk, JSON.stringify(favs)]);
      } else {
        memoryFavs.set(email, favs);
      }
    };

    if (action === 'fav_list') return res.status(200).json({ favs: await load() });
    if (action === 'fav_add') {
      const r = cleanRecipe(b.recipe);
      if (!r) return fail(400, 'invalid');
      const favs = await load();
      if (!favs.some(f => f.nom === r.nom)) {
        if (favs.length >= 50) return fail(400, 'full');
        favs.unshift({ id: randomBytes(6).toString('hex'), ...r });
        await save(favs);
      }
      return res.status(200).json({ favs });
    }
    if (action === 'fav_remove') {
      let favs = (await load()).filter(f => f.id !== b.id);
      await save(favs);
      return res.status(200).json({ favs });
    }
    return fail(400, 'invalid');
  } catch (e) {
    console.error(e);
    return fail(500, 'server');
  }
}
