// Shared helpers (the underscore keeps Vercel from exposing this file as a route)
const url = () => process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const tok = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

export const hasStorage = () => Boolean(url() && tok());

export async function redis(cmd) {
  const r = await fetch(url(), {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + tok(), 'content-type': 'application/json' },
    body: JSON.stringify(cmd)
  });
  if (!r.ok) throw new Error('redis ' + r.status);
  return (await r.json()).result;
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

export const clientIp = req => (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
