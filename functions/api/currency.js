/**
 * GET /api/currency
 * EUR/TRY kuru — TCMB'den çeker, KV'de 1 saat cache'ler
 */

const CACHE_KEY = 'eur_try_rate';
const CACHE_TTL = 3600; // 1 saat

export async function onRequestGet(ctx) {
  const { env } = ctx;

  // ─── KV CACHE ────────────────────────────────────────────────────
  if (env.PAYMENT_KV) {
    try {
      const cached = await env.PAYMENT_KV.get(CACHE_KEY, { type: 'text' });
      if (cached) {
        return jsonResp(JSON.parse(cached));
      }
    } catch {}
  }

  // ─── TCMB'DEN ÇEK ────────────────────────────────────────────────
  try {
    const res = await fetch('https://www.tcmb.gov.tr/kurlar/today.xml', {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HydrozidBot/1.0)' },
    });
    const xml = await res.text();

    const eurMatch = xml.match(/CurrencyCode="EUR"[\s\S]*?<BanknoteSelling>([\d,]+)<\/BanknoteSelling>/);
    const eur_try = eurMatch ? parseFloat(eurMatch[1].replace(',', '.')) : null;

    if (!eur_try) {
      return jsonResp({ error: 'Kur alınamadı' }, 502);
    }

    const data = { eur_try, timestamp: new Date().toISOString() };

    // KV'ye kaydet
    if (env.PAYMENT_KV) {
      await env.PAYMENT_KV.put(CACHE_KEY, JSON.stringify(data), { expirationTtl: CACHE_TTL }).catch(() => {});
    }

    return jsonResp(data);
  } catch (e) {
    return jsonResp({ error: e.message }, 500);
  }
}

function jsonResp(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'public, max-age=3600',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
