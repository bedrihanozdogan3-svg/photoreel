/**
 * Fenix AI — Rate Limiter Middleware
 *
 * Her customerId için dakikada max istek sayısı sınırlar.
 * In-memory (Cloud Run restart'ta sıfırlanır — yeterli).
 *
 * Plan bazlı limitler:
 *   free    : 3/dk
 *   reels   : 5/dk
 *   pro     : 10/dk
 *   360     : 10/dk
 *   ses     : 5/dk
 *   otonom  : 20/dk  (API erişimi var, yüksek limit)
 *   full    : 20/dk
 */

const PLAN_LIMITS = {
  free:   3,
  reels:  5,
  pro:    10,
  '360':  10,
  ses:    5,
  otonom: 20,
  full:   20
};

// { customerId: { count, windowStart, plan } }
const store = new Map();

// Her 5 dakikada temizlik yap (bellek sızıntısı önle)
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of store) {
    if (now - val.windowStart > 60_000) store.delete(key);
  }
}, 5 * 60_000);

/**
 * Middleware: customerId + plan bazlı rate limit.
 * customerId: req.body.customerId || req.query.cid
 * plan: req.body.plan || req.customerPlan (önceki middleware'den)
 */
function rateLimiter(req, res, next) {
  const customerId = req.body?.customerId || req.query?.cid || 'anonymous';
  // GÜVENLİK: plan bilgisi ASLA client'tan alınmaz — sunucu tarafında çözülür
  const plan = req.customerPlan || 'free'; // req.body.plan KULLANILMAZ
  const maxPerMin = PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
  const now = Date.now();

  let rec = store.get(customerId);
  if (!rec || now - rec.windowStart > 60_000) {
    rec = { count: 0, windowStart: now, plan };
    store.set(customerId, rec);
  }

  rec.count++;

  if (rec.count > maxPerMin) {
    const retryAfter = Math.ceil((60_000 - (now - rec.windowStart)) / 1000);
    res.setHeader('Retry-After', retryAfter);
    return res.status(429).json({
      ok: false,
      error: `Çok fazla istek. ${retryAfter} saniye bekle.`,
      retryAfter
    });
  }

  next();
}

/**
 * Belirli bir customerId'nin kalan rate limit bilgisini döner.
 * Admin panel için.
 */
function getRateInfo(customerId) {
  const rec = store.get(customerId);
  if (!rec) return { count: 0, remaining: null };
  const maxPerMin = PLAN_LIMITS[rec.plan] ?? PLAN_LIMITS.free;
  return {
    count: rec.count,
    remaining: Math.max(0, maxPerMin - rec.count),
    plan: rec.plan,
    windowStart: rec.windowStart
  };
}

module.exports = { rateLimiter, getRateInfo, PLAN_LIMITS };
