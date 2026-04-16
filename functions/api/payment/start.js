/**
 * DEBUG VERSION — start.js
 * Farklar: Her hatada gerçek error detail'i response'a ekliyor ve console.log'a detay basıyor.
 * Sorun çözüldükten sonra orijinal start.js'e geri dön.
 */

const ALLOWED_ORIGINS = ['https://www.hydrozidtr.com', 'https://hydrozidtr.com'];
const PLATFORMODE_BASE = 'https://app.halkode.com.tr/ccpayment';
const TOKEN_KV_KEY = 'token:platformode';
const RATE_LIMIT_WINDOW = 60;
const RATE_LIMIT_MAX = 10;

const PACKAGE_PRICES_EUR = {
  'Temel Paket':    149,
  'Klinik Paketi':  695,
  'Kurumsal Paket': 1290,
};

export async function onRequestPost(ctx) {
  const { request, env } = ctx;
  const debugLog = [];
  const log = (msg, data) => {
    const entry = { ts: new Date().toISOString(), msg, data };
    debugLog.push(entry);
    console.log('[DEBUG]', msg, data || '');
  };

  try {
    // ─── CORS ────────────────────────────────────────────────────────
    const origin = request.headers.get('Origin') || '';
    const corsHeaders = {
      'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Content-Type': 'application/json',
    };

    // ─── ENV CHECK (EN ÖNEMLİ!) ──────────────────────────────────────
    const envStatus = {
      APP_ID: env.APP_ID ? `SET (${String(env.APP_ID).length} chars)` : 'MISSING',
      APP_SECRET: env.APP_SECRET ? `SET (${String(env.APP_SECRET).length} chars)` : 'MISSING',
      MERCHANT_KEY: env.MERCHANT_KEY ? `SET (${String(env.MERCHANT_KEY).length} chars)` : 'MISSING',
      WEBHOOK_SECRET: env.WEBHOOK_SECRET ? 'SET' : 'MISSING',
      BASE_URL: env.BASE_URL || 'not set (will default)',
      PAYMENT_KV: env.PAYMENT_KV ? 'BOUND' : 'NOT BOUND',
    };
    log('Environment check', envStatus);

    if (!env.APP_ID || !env.APP_SECRET || !env.MERCHANT_KEY) {
      return new Response(JSON.stringify({
        error: 'Environment variables eksik',
        debug: envStatus,
        log: debugLog,
      }), { status: 500, headers: corsHeaders });
    }

    if (!env.PAYMENT_KV) {
      return new Response(JSON.stringify({
        error: 'KV binding yok (PAYMENT_KV)',
        debug: envStatus,
        log: debugLog,
      }), { status: 500, headers: corsHeaders });
    }

    // ─── RATE LIMIT ──────────────────────────────────────────────────
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const rateLimitKey = `rl:${ip}:${Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW)}`;
    const currentCount = parseInt((await env.PAYMENT_KV.get(rateLimitKey)) || '0', 10);
    if (currentCount >= RATE_LIMIT_MAX) {
      return new Response(
        JSON.stringify({ error: 'Çok fazla istek.' }),
        { status: 429, headers: corsHeaders }
      );
    }
    await env.PAYMENT_KV.put(rateLimitKey, String(currentCount + 1), { expirationTtl: RATE_LIMIT_WINDOW + 10 });
    log('Rate limit OK', { count: currentCount });

    // ─── PARSE & VALIDATE ─────────────────────────────────────────────
    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'Geçersiz JSON' }), { status: 400, headers: corsHeaders });
    }

    const { name, email, phone, city, address, diploma, package: packageName, currency: reqCurrency } = body;
    log('Request body', { name, email, phone, city, packageName, currency: reqCurrency });

    if (!name || name.trim().length < 3) return errDebug('Ad Soyad kısa', corsHeaders, debugLog);
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return errDebug('Email geçersiz', corsHeaders, debugLog);
    if (!phone || !/^0[5][0-9]{9}$/.test(phone)) return errDebug('Telefon geçersiz', corsHeaders, debugLog);
    if (!city || city.trim().length < 2) return errDebug('Şehir geçersiz', corsHeaders, debugLog);
    if (!address || address.trim().length < 10) return errDebug('Adres kısa', corsHeaders, debugLog);
    if (!diploma || diploma.trim().length < 5) return errDebug('Diploma kısa', corsHeaders, debugLog);

    // ─── FİYAT ───────────────────────────────────────────────────────
    const eurBase = PACKAGE_PRICES_EUR[packageName];
    if (!eurBase) return errDebug('Geçersiz paket: ' + packageName, corsHeaders, debugLog);

    const currency = reqCurrency === 'EUR' ? 'EUR' : 'TRY';
    let finalPrice;
    if (currency === 'EUR') {
      finalPrice = eurBase.toString();
    } else {
      const rate = await fetchEurTryRate();
      if (!rate) {
        log('EUR/TRY rate alınamadı');
        return errDebug('Kur alınamadı', corsHeaders, debugLog, 502);
      }
      finalPrice = Math.round(eurBase * rate).toString();
      log('Rate fetched', { rate, finalPrice });
    }

    // ─── TOKEN ───────────────────────────────────────────────────────
    let token;
    try {
      token = await getTokenDebug(env, log);
      log('Token alındı', { length: token.length, preview: token.substring(0, 20) + '...' });
    } catch (e) {
      log('Token ERROR', { message: e.message, stack: e.stack });
      return new Response(JSON.stringify({
        error: 'Token alınamadı',
        debug_message: e.message,
        log: debugLog,
      }), { status: 502, headers: corsHeaders });
    }

    // ─── BUILD INVOICE ───────────────────────────────────────────────
    const invoiceId = crypto.randomUUID();
    const baseUrl = env.BASE_URL || 'https://www.hydrozidtr.com';

    const nameParts = name.trim().split(' ');
    const firstName = nameParts.slice(0, -1).join(' ') || name.trim();
    const lastName = nameParts.slice(-1)[0] || '-';

    const invoice = {
      invoice_id: invoiceId,
      total: finalPrice,
      currency: currency,
      sale_web_hook_key: env.WEBHOOK_SECRET,
      return_url: `${baseUrl}/odeme-basarili.html`,
      cancel_url: `${baseUrl}/odeme-hatasi.html`,
      items: [{
        id: 'hydrozid-001',
        name: 'Hydrozid Kriyocerrahi Cihazi',
        price: finalPrice,
        quantity: 1,
      }],
      // DÜZELTME: bill_* prefix'i (doküman section 2.0)
      bill_address1: address.trim().substring(0, 100),
      bill_city: city.trim(),
      bill_state: city.trim(),
      bill_country: 'TR',
      bill_email: email.trim(),
      bill_phone: phone.trim(),
    };

    log('Invoice prepared', { invoice_id: invoiceId, total: finalPrice, currency });

    // ─── PURCHASE LINK ───────────────────────────────────────────────
    let paymentLink;
    try {
      const formData = new URLSearchParams();
      formData.append('merchant_key', env.MERCHANT_KEY);
      formData.append('invoice', JSON.stringify(invoice));
      formData.append('currency_code', currency);
      formData.append('name', firstName);
      formData.append('surname', lastName);

      log('Calling Platformode purchase/link', {
        url: `${PLATFORMODE_BASE}/purchase/link`,
        bodyLength: formData.toString().length,
      });

      const resp = await fetch(`${PLATFORMODE_BASE}/purchase/link`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `Bearer ${token}`,
        },
        body: formData.toString(),
      });

      const rawText = await resp.text();
      log('Platformode raw response', { status: resp.status, body: rawText.substring(0, 500) });

      let data;
      try {
        data = JSON.parse(rawText);
      } catch (e) {
        return new Response(JSON.stringify({
          error: 'Platformode JSON parse hatası',
          raw: rawText.substring(0, 500),
          http_status: resp.status,
          log: debugLog,
        }), { status: 502, headers: corsHeaders });
      }

      if (data.status !== 'True' || !data.link) {
        return new Response(JSON.stringify({
          error: 'Platformode link dönmedi',
          platformode_response: data,
          log: debugLog,
        }), { status: 502, headers: corsHeaders });
      }
      paymentLink = data.link;
      log('Link alındı', { link: paymentLink });
    } catch (e) {
      log('Purchase link exception', { message: e.message });
      return new Response(JSON.stringify({
        error: 'Purchase link exception',
        debug_message: e.message,
        log: debugLog,
      }), { status: 502, headers: corsHeaders });
    }

    // ─── SAVE PENDING ORDER ──────────────────────────────────────────
    const orderData = { invoiceId, name, email, phone, city, diploma: diploma.trim(), package: packageName, price_final: finalPrice, currency, createdAt: Date.now() };
    await env.PAYMENT_KV.put(`order:${invoiceId}`, JSON.stringify(orderData), { expirationTtl: 3600 });

    return new Response(JSON.stringify({ link: paymentLink }), { status: 200, headers: corsHeaders });

  } catch (e) {
    return new Response(JSON.stringify({
      error: 'Üst seviye exception',
      message: e.message,
      stack: e.stack,
      log: debugLog,
    }), { status: 500, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}

function errDebug(message, headers, log, status = 400) {
  return new Response(JSON.stringify({ error: message, log }), { status, headers });
}

async function fetchEurTryRate() {
  try {
    const res = await fetch('https://hydrozidtr.com/api/currency');
    const data = await res.json();
    return data.eur_try || null;
  } catch {
    return null;
  }
}

async function getTokenDebug(env, log) {
  const cached = await env.PAYMENT_KV.get(TOKEN_KV_KEY, { type: 'text' });
  if (cached) {
    log('Token from KV cache', { length: cached.length });
    return cached;
  }

  log('Fetching new token from Platformode', { url: `${PLATFORMODE_BASE}/api/token`, app_id_preview: String(env.APP_ID).substring(0, 8) + '...' });

  const resp = await fetch(`${PLATFORMODE_BASE}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: env.APP_ID,
      app_secret: env.APP_SECRET,
    }),
  });

  const rawText = await resp.text();
  log('Token response raw', { status: resp.status, body: rawText.substring(0, 300) });

  if (!resp.ok) {
    throw new Error(`Token HTTP ${resp.status}: ${rawText.substring(0, 200)}`);
  }

  const data = JSON.parse(rawText);
  const token = data.token || data.access_token || data.data?.token;

  if (!token) {
    throw new Error(`Token yok — status_code: ${data.status_code}, desc: ${data.status_description}, raw: ${rawText.substring(0, 200)}`);
  }

  await env.PAYMENT_KV.put(TOKEN_KV_KEY, token, { expirationTtl: 110 * 60 });
  return token;
}
