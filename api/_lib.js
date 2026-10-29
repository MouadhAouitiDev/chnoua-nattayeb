// Shared helpers (the underscore keeps Vercel from exposing this file as a route)
import { createHash, timingSafeEqual } from 'node:crypto';

// ---- Redis (Upstash REST) configuration ----
// Accepted, in this order:
//   UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN   (Upstash integration)
//   KV_REST_API_URL + KV_REST_API_TOKEN                 (Vercel "Upstash for Redis" / old Vercel KV)
//   <PREFIX>_KV_REST_API_URL + <PREFIX>_KV_REST_API_TOKEN, <PREFIX>_UPSTASH_REDIS_REST_URL + ..._TOKEN (custom prefix chosen in Vercel)
//   REDIS_URL / KV_URL = rediss://default:<token>@<host>.upstash.io:6379  (the REST URL/token are derived from it)
// A plain Redis Cloud / self-hosted REDIS_URL cannot be used: this code talks HTTP (REST), not the Redis TCP protocol.
const clean = v => (v || '').trim().replace(/^["']|["']$/g, '').replace(/\/+$/, '');
let cached = null;
export function redisConfig() {
  if (cached) return cached;
  const env = process.env;
  const pairs = [['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'], ['KV_REST_API_URL', 'KV_REST_API_TOKEN']];
  for (const k of Object.keys(env)) {
    const m = k.match(/^(.+)_(KV_REST_API|UPSTASH_REDIS_REST)_URL$/);
    if (m) pairs.push([k, `${m[1]}_${m[2]}_TOKEN`]);
  }
  for (const [u, t] of pairs) {
    if (clean(env[u]) && clean(env[t])) return (cached = { url: clean(env[u]), token: clean(env[t]), source: u });
  }
  for (const k of ['REDIS_URL', 'KV_URL', ...Object.keys(env).filter(k => /_(REDIS|KV)_URL$/.test(k))]) {
    const raw = clean(env[k]);
    if (!raw) continue;
    try {
      const p = new URL(raw);
      if (/upstash\.io$/.test(p.hostname) && p.password) return (cached = { url: 'https://' + p.hostname, token: decodeURIComponent(p.password), source: k });
      cached = { url: '', token: '', source: '', unsupported: k }; // remember why, for the admin diagnostics
    } catch {}
  }
  return cached || { url: '', token: '', source: '' };
}

export const hasStorage = () => Boolean(redisConfig().url && redisConfig().token);

async function upstash(path, body) {
  const { url, token } = redisConfig();
  const r = await fetch(url + path, {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  const d = await r.json().catch(() => null);
  if (!r.ok || !d || (!Array.isArray(d) && d.error)) throw new Error('redis ' + r.status + ' ' + ((d && d.error) || ''));
  return d;
}

export async function redis(cmd) { return (await upstash('', cmd)).result; }

// Several commands in ONE http request (cheaper and faster). Returns the results in order; failed commands give null.
export async function pipeline(cmds) {
  if (!cmds.length) return [];
  const d = await upstash('/pipeline', cmds);
  return d.map(x => (x && 'result' in x ? x.result : null));
}

export function cookie(req, name) {
  const m = (req.headers.cookie || '').split(/;\s*/).find(c => c.startsWith(name + '='));
  return m ? m.slice(name.length + 1) : '';
}

export async function getUser(req) {
  if (!hasStorage()) return null;
  const t = cookie(req, 'sid');
  if (!/^[a-f0-9]{64}$/.test(t)) return null;
  try { return await redis(['GET', 'sess:' + t]); } catch { return null; }
}

export const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.headers['x-real-ip'] || 'unknown';
export const today = (d = new Date()) => d.toISOString().slice(0, 10);

// ---- Admin password check, shared by every admin action ----
// Wrong attempts are counted in Redis (shared by all serverless instances, unlike an in-memory Map),
// with an in-memory fallback when Redis is not connected. 5 wrong attempts per IP -> locked 15 minutes.
const sha = s => createHash('sha256').update(String(s)).digest();
const memFails = new Map();
export async function checkAdmin(req) {
  const ip = clientIp(req), key = 'adminfail:' + sha(ip).toString('hex').slice(0, 16);
  let n = 0;
  if (hasStorage()) { try { n = Number(await redis(['GET', key])) || 0; } catch {} }
  else n = (memFails.get(ip) || []).filter(t => Date.now() - t < 900000).length;
  if (n >= 5) return { code: 429, error: 'locked' };
  if (!process.env.ADMIN_PASSWORD) return { code: 500, error: 'config' };
  if (timingSafeEqual(sha(req.headers['x-admin-password'] || ''), sha(process.env.ADMIN_PASSWORD))) return null;
  if (hasStorage()) { try { await pipeline([['INCR', key], ['EXPIRE', key, 900]]); } catch {} }
  else memFails.set(ip, [...(memFails.get(ip) || []), Date.now()]);
  return { code: 401, error: 'password' };
}

// ---- Usage counters for the admin dashboard (never breaks the request that calls it) ----
export async function track(metric) {
  if (!hasStorage()) return;
  const k = `stats:${metric}:${today()}`;
  try { await pipeline([['INCR', k], ['EXPIRE', k, 120 * 86400], ['INCR', `stats:${metric}:total`]]); } catch (e) { console.error('track', e.message); }
}
