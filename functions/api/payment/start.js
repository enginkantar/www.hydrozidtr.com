/**
 * POST /api/payment/start
 * Body: { name, email, phone, city, address, diploma }
 * Returns: { link } → redirect to Platformode hosted payment page
 */

const ALLOWED_ORIGINS = ['https://www.hydrozidtr.com', 'https://hydrozidtr.com'];
const PLATFORMODE_BASE = 'https://app.halkode.com.tr/ccpayment';
const TOKEN_KV_KEY = 'token:platformode';
const RATE_LIMIT_WINDOW = 60; // seconds
const RATE_LIMIT_MAX = 10;

// Server-side fiyat tablosu (EUR) — client'tan gelen price görmezden gelinir
const PACKAGE_PRICES_EUR = {
  'Temel Paket':    149,
  'Klinik Paketi':  695,   // 139 × 5
  'Kurumsal Paket': 1290,  // 129 × 10
};

export async function onRequestPost(ctx) {
  const { request, env } = ctx;

  // ─── CORS ────────────────────────────────────────────────────────
  const origin = request.headers.get('Origin') || '';
  const corsHeaders = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json',
  };

  // ─── RATE LIMIT ──────────────────────────────────────────────────
  const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
  const rateLimitKey = `rl:${ip}:${Math.floor(Date.now() / 1000 / RATE_LIMIT_WINDOW)}`;
  const currentCount = parseInt((await env.PAYMENT_KV.get(rateLimitKey)) || '0', 10);
  if (currentCount >= RATE_LIMIT_MAX) {
    return new Response(
      JSON.stringify({ error: 'Çok fazla istek. Lütfen bir dakika bekleyip tekrar deneyin.' }),
      { status: 429, headers: corsHeaders }
    );
  }
  await env.PAYMENT_KV.put(rateLimitKey, String(currentCount + 1), { expirationTtl: RATE_LIMIT_WINDOW + 10 });

  // ─── PARSE & VALIDATE ─────────────────────────────────────────────
  let body;
  try {
    body = await request.json();
  } catch {
    return new Response(JSON.stringify({ error: 'Geçersiz istek formatı.' }), { status: 400, headers: corsHeaders });
  }

  const { name, email, phone, city, address, diploma, package: packageName, currency: reqCurrency } = body;

  if (!name || name.trim().length < 3) return err('Ad Soyad en az 3 karakter olmalıdır.', corsHeaders);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return err('Geçerli bir e-posta giriniz.', corsHeaders);
  if (!phone || !/^0[5][0-9]{9}$/.test(phone)) return err('Telefon 05XXXXXXXXX formatında olmalıdır.', corsHeaders);
  if (!city || city.trim().length < 2) return err('Şehir seçiniz.', corsHeaders);
  if (!address || address.trim().length < 10) return err('Adres en az 10 karakter olmalıdır.', corsHeaders);
  if (!diploma || diploma.trim().length < 5) return err('Doktor diploma no giriniz.', corsHeaders);

  // ─── SERVER-SIDE FİYAT HESAPLAMA ─────────────────────────────────
  const eurBase = PACKAGE_PRICES_EUR[packageName];
  if (!eurBase) return err('Geçersiz paket seçimi.', corsHeaders);

  const currency = reqCurrency === 'EUR' ? 'EUR' : 'TRY';
  let finalPrice;
  if (currency === 'EUR') {
    finalPrice = eurBase.toString();
  } else {
    const rate = await fetchEurTryRate();
    if (!rate) return err('Döviz kuru alınamadı. Lütfen tekrar deneyin.', corsHeaders, 502);
    finalPrice = Math.round(eurBase * rate).toString();
  }

  // ─── TOKEN ────────────────────────────────────────────────────────
  let token;
  try {
    token = await getToken(env);
  } catch (e) {
    console.error('Token error:', e);
    return err('Ödeme sistemi bağlantısı kurulamadı. Lütfen tekrar deneyin.', corsHeaders, 502);
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
    return_url: `${baseUrl}/odeme-basarili.html`,
    cancel_url: `${baseUrl}/odeme-hatasi.html`,
    items: [
      {
        id: 'hydrozid-001',
        name: 'Hydrozid® Kriyocerrahi Cihazı',
        price: finalPrice,
        quantity: 1,
      }
    ],
    billing_first_name: firstName,
    billing_last_name: lastName,
    billing_email: email.trim(),
    billing_phone: phone.trim(),
    billing_city: city.trim(),
    billing_address: address.trim(),
    billing_country: 'TR',
    billing_note: `Diploma No: ${diploma.trim()} | Paket: ${packageName} | ${finalPrice} ${currency}`,
  };

  // ─── PURCHASE LINK ───────────────────────────────────────────────
  let paymentLink;
  try {
    const formData = new URLSearchParams();
    formData.append('merchant_key', env.MERCHANT_KEY);
    formData.append('invoice', JSON.stringify(invoice));
    formData.append('currency_code', currency);
    formData.append('name', firstName);
    formData.append('surname', lastName);

    const resp = await fetch(`${PLATFORMODE_BASE}/purchase/link`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${token}`,
      },
      body: formData.toString(),
    });

    const data = await resp.json();
    if (data.status !== 'True' || !data.link) {
      console.error('Platformode error:', JSON.stringify(data));
      return err('Ödeme linki alınamadı. Lütfen tekrar deneyin.', corsHeaders, 502);
    }
    paymentLink = data.link;
  } catch (e) {
    console.error('Purchase link error:', e);
    return err('Ödeme sistemi bağlantı hatası.', corsHeaders, 502);
  }

  // ─── SAVE PENDING ORDER ──────────────────────────────────────────
  const orderData = { invoiceId, name, email, phone, city, diploma: diploma.trim(), createdAt: Date.now() };
  await env.PAYMENT_KV.put(`order:${invoiceId}`, JSON.stringify(orderData), { expirationTtl: 3600 });

  return new Response(JSON.stringify({ link: paymentLink }), { status: 200, headers: corsHeaders });
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

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function err(message, headers, status = 400) {
  return new Response(JSON.stringify({ error: message }), { status, headers });
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

async function getToken(env) {
  // Try KV cache first
  const cached = await env.PAYMENT_KV.get(TOKEN_KV_KEY, { type: 'text' });
  if (cached) return cached;

  // Fetch new token
  const resp = await fetch(`${PLATFORMODE_BASE}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      app_id: env.APP_ID,
      app_secret: env.APP_SECRET,
    }),
  });

  if (!resp.ok) throw new Error(`Token fetch failed: ${resp.status}`);

  const data = await resp.json();
  const token = data.token || data.access_token || data.data?.token;
  if (!token) throw new Error('No token in response: ' + JSON.stringify(data));

  // Cache for 110 minutes (token valid 2h, leave 10min buffer)
  await env.PAYMENT_KV.put(TOKEN_KV_KEY, token, { expirationTtl: 110 * 60 });

  return token;
}
