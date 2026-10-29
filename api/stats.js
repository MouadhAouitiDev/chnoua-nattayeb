// Audience statistics + admin dashboard.
// POST /api/stats { action: "hit", page, ref }          public, sent once per page view (no cookie, no personal data stored)
// POST /api/stats { action: "dashboard", days }         admin (header x-admin-password) -> views, visitors, reviews, accounts, usage
// POST /api/stats { action: "delete_review", id }       admin
// POST /api/stats { action: "diag" }                    admin -> is Redis configured / reachable / writable (signup troubleshooting)
//
// Visitors are counted with a HyperLogLog of a daily-salted hash of IP + browser: the IP itself is never stored,
// and the hash changes every day, so visitors cannot be followed from one day to the next.
import { createHash, randomBytes } from 'node:crypto';
import { hasStorage, redis, pipeline, redisConfig, checkAdmin, clientIp, today } from './_lib.js';

const KEEP = 120 * 86400; // daily keys live 120 days
const BOT = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|telegram|headless|lighthouse|pingdom|uptime|monitor|curl|wget|python|go-http|node-fetch|axios/i;
const PAGES = new Set(['/', '/plan', '/breakfast', '/privacy']);
const pageOf = p => {
  const s = (typeof p === 'string' ? p : '/').split(/[?#]/)[0].replace(/\.html$/, '').replace(/\/index$/, '/').toLowerCase() || '/';
  return PAGES.has(s) ? s : 'other';
};
const refOf = (r, host) => {
  try {
    const h = new URL(r).hostname.replace(/^www\./, '').replace(/^(l|m|lm)\.facebook\.com$/, 'facebook.com');
    return !h || h === host ? '' : h.slice(0, 60);
  } catch { return ''; }
};
const days = n => Array.from({ length: n }, (_, i) => today(new Date(Date.now() - (n - 1 - i) * 86400000)));
const hgetall = a => { const o = {}; for (let i = 0; a && i < a.length; i += 2) o[a[i]] = Number(a[i + 1]); return o; };
const rid = raw => createHash('sha1').update(raw).digest('hex').slice(0, 12);

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') return res.status(405).json({ error: 'method' });
  const b = req.body && typeof req.body === 'object' ? req.body : {};
  const fail = (c, e) => res.status(c).json({ error: e });

  // ---------- public: count a page view ----------
  if (b.action === 'hit') {
    if (!hasStorage()) return res.status(204).end();
    const ua = String(req.headers['user-agent'] || '');
    if (!ua || BOT.test(ua)) return res.status(204).end();
    const d = today(), page = pageOf(b.page);
    const host = String(req.headers['x-forwarded-host'] || req.headers.host || '').split(':')[0].replace(/^www\./, '');
    const ref = refOf(b.ref, host);
    const salt = process.env.STATS_SALT || process.env.ADMIN_PASSWORD || 'chnoua';
    const visitor = createHash('sha256').update(`${salt}|${d}|${clientIp(req)}|${ua}`).digest('hex').slice(0, 20);
    const mobile = /mobile|android|iphone|ipad/i.test(ua) ? 'mobile' : 'desktop';
    const cmds = [
      ['INCR', 'views:total'], ['INCR', 'views:d:' + d], ['EXPIRE', 'views:d:' + d, KEEP],
      ['HINCRBY', 'views:pages', page, 1], ['HINCRBY', 'views:pd:' + d, page, 1], ['EXPIRE', 'views:pd:' + d, KEEP],
      ['PFADD', 'uv:d:' + d, visitor], ['EXPIRE', 'uv:d:' + d, KEEP],
      ['HINCRBY', 'views:device', mobile, 1]
    ];
    if (ref) cmds.push(['HINCRBY', 'views:refs', ref, 1]);
    try { await pipeline(cmds); } catch (e) { console.error('hit', e.message); }
    return res.status(204).end();
  }

  // ---------- everything below is admin only ----------
  const denied = await checkAdmin(req);
  if (denied) return fail(denied.code, denied.error);

  if (b.action === 'diag' || b.action === 'login') {
    const cfg = redisConfig();
    const out = { ok: true, storage: hasStorage(), source: cfg.source || null, unsupported: cfg.unsupported || null, reachable: false, writable: false, error: null };
    if (out.storage) {
      try {
        out.reachable = (await redis(['PING'])) === 'PONG';
        const k = 'diag:' + randomBytes(4).toString('hex');
        out.writable = (await redis(['SET', k, '1', 'EX', 30])) === 'OK';
      } catch (e) { out.error = String(e.message).slice(0, 160); }
    }
    return res.status(200).json(out);
  }

  if (!hasStorage()) return fail(503, 'storage');

  try {
    if (b.action === 'delete_review') {
      const id = typeof b.id === 'string' ? b.id : '';
      const list = (await redis(['LRANGE', 'site:reviews', 0, -1])) || [];
      const raw = list.find(x => { try { return (JSON.parse(x).id || rid(x)) === id; } catch { return rid(x) === id; } });
      if (!raw) return fail(404, 'not_found');
      const r = JSON.parse(raw);
      await pipeline([['LREM', 'site:reviews', 1, raw], ['INCRBY', 'reviews:count', -1], ['INCRBY', 'reviews:sum', -r.rating], ['HINCRBY', 'reviews:dist', String(r.rating), -1]]);
      return res.status(200).json({ ok: true });
    }

    if (b.action !== 'dashboard') return fail(400, 'invalid');

    const n = Math.min(90, Math.max(7, Math.floor(Number(b.days) || 30)));
    const ds = days(n);
    const [views, recipes, plans, signups] = await pipeline([
      ['MGET', ...ds.map(d => 'views:d:' + d)],
      ['MGET', ...ds.map(d => 'stats:recipes:' + d)],
      ['MGET', ...ds.map(d => 'stats:plans:' + d)],
      ['MGET', ...ds.map(d => 'stats:signups:' + d)]
    ]);
    const uvDaily = await pipeline(ds.map(d => ['PFCOUNT', 'uv:d:' + d]));
    const [total, uvPeriod, uv7, pages, pagesToday, refs, device, reviewsRaw, rCount, rSum, rDist, users, signupList, recipesTotal, plansTotal, backfilled] = await pipeline([
      ['GET', 'views:total'],
      ['PFCOUNT', ...ds.map(d => 'uv:d:' + d)],
      ['PFCOUNT', ...ds.slice(-7).map(d => 'uv:d:' + d)],
      ['HGETALL', 'views:pages'],
      ['HGETALL', 'views:pd:' + ds[ds.length - 1]],
      ['HGETALL', 'views:refs'],
      ['HGETALL', 'views:device'],
      ['LRANGE', 'site:reviews', 0, 199],
      ['GET', 'reviews:count'], ['GET', 'reviews:sum'], ['HGETALL', 'reviews:dist'],
      ['GET', 'stats:users'],
      ['LRANGE', 'site:signups', 0, 49],
      ['GET', 'stats:recipes:total'], ['GET', 'stats:plans:total'], ['GET', 'stats:backfilled']
    ]);

    const reviews = (reviewsRaw || []).map(raw => { try { const r = JSON.parse(raw); return { id: r.id || rid(raw), ...r }; } catch { return null; } }).filter(Boolean);
    let count = Number(rCount) || 0, sum = Number(rSum) || 0, dist = hgetall(rDist), accounts = Number(users) || 0;
    // First dashboard after this update: data created before the counters existed is counted once
    // (reviews from the stored list, accounts by scanning user:* keys).
    if (!backfilled) {
      count = reviews.length; sum = reviews.reduce((s, r) => s + r.rating, 0); dist = {};
      reviews.forEach(r => { dist[r.rating] = (dist[r.rating] || 0) + 1; });
      let cursor = '0', c = 0, guard = 0;
      do { const [next, keys] = await redis(['SCAN', cursor, 'MATCH', 'user:*', 'COUNT', 1000]); cursor = String(next); c += keys.length; } while (cursor !== '0' && ++guard < 200);
      accounts = c;
      await pipeline([['SET', 'reviews:count', count], ['SET', 'reviews:sum', sum], ['DEL', 'reviews:dist'],
        ...Object.entries(dist).map(([k, v]) => ['HSET', 'reviews:dist', k, v]), ['SET', 'stats:users', c], ['SET', 'stats:backfilled', new Date().toISOString()]]);
    }

    const num = a => (a || []).map(x => Number(x) || 0);
    return res.status(200).json({
      days: ds,
      views: num(views), visitors: num(uvDaily), recipes: num(recipes), plans: num(plans), signups: num(signups),
      totals: {
        views: Number(total) || 0, visitorsPeriod: Number(uvPeriod) || 0, visitors7: Number(uv7) || 0,
        recipes: Number(recipesTotal) || 0, plans: Number(plansTotal) || 0, accounts
      },
      pages: hgetall(pages), pagesToday: hgetall(pagesToday), refs: hgetall(refs), device: hgetall(device),
      reviews, reviewStats: { count, avg: count ? Math.round(sum / count * 100) / 100 : 0, dist },
      latestSignups: (signupList || []).map(x => { try { return JSON.parse(x); } catch { return null; } }).filter(Boolean)
    });
  } catch (e) {
    console.error(e);
    return fail(500, 'server');
  }
}
