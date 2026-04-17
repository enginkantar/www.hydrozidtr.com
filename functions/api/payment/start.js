// POST /api/payment/start
// HalkÖde (Platformode) purchase/link — 10 TL gerçek ödeme testi ile doğrulanmış format.
//
// KRITIK FARKLAR (denemeyle bulundu, resmi dokümanda yanıltıcı):
//   - invoice_description (description DEĞİL)
//   - total: NUMBER (string değil)
//   - bill_* prefix (billing_* değil)
//   - bill_country: "TURKEY" (TR değil)
//   - items'da id yok, description zorunlu
//
// Environment variables (Cloudflare dashboard → Settings → Variables and Secrets):
//   HALKODE_APP_ID         (secret) — HalkÖde Uygulama Anahtarı
//   HALKODE_APP_SECRET     (secret) — HalkÖde Uygulama Parolası
//   HALKODE_MERCHANT_KEY   (secret) — HalkÖde Üyeişyeri Anahtarı ($2y$10$... başlıyor)
//   WEBHOOK_SECRET         (secret) — HalkÖde panelinde tanımladığın sale_web_hook_key adı (opsiyonel)
//   BASE_URL               (plain)  — https://www.hydrozidtr.com

const PLATFORMODE_BASE = 'https://app.halkode.com.tr/ccpayment';
const TOKEN_KV_KEY = 'token:halkode';

// EUR fiyatları — SERVER-SIDE (client manipüle edemesin)
const PACKAGE_PRICES_EUR = {
  'Temel Paket':    149,
  'Klinik Paketi':  695,   // 139 × 5
  'Kurumsal Paket': 1290,  // 129 × 10
};

const PACKAGE_QTY = {
  'Temel Paket':    1,
  'Klinik Paketi':  5,
  'Kurumsal Paket': 10,
};

// ─── CORS ─────────────────────────────────────────────────────────────────────
function isAllowedOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true; // in-app browser vs direct = izin ver
  return origin.includes('hydrozidtr.com') || origin.includes('localhost') || origin.includes('192.168.');
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin') || 'https://www.hydrozidtr.com';
  return {
    'Access-Control-Allow-Origin':  origin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function jsonResp(request, data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(request),
    },
  });
}

// ─── Rate limit: 10 req/min per IP ─────────────────────────────────────────────
async function checkRateLimit(kv, ip) {
  const key = `rl:hydrozid:start:${ip}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= 10) return false;
  await kv.put(key, String(count + 1), { expirationTtl: 60 });
  return true;
}

// ─── HalkÖde token (110 dk KV cache) ──────────────────────────────────────────
async function getToken(env) {
  const cached = await env.PAYMENT_KV.get(TOKEN_KV_KEY, { type: 'text' });
  if (cached) return cached;

  const resp = await fetch(`${PLATFORMODE_BASE}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({ app_id: env.HALKODE_APP_ID, app_secret: env.HALKODE_APP_SECRET }),
  });

  if (!resp.ok) throw new Error(`Token HTTP ${resp.status}`);

  const data = await resp.json();
  const token = data?.data?.token;
  if (!token) throw new Error(`Token yok: ${data?.status_description || 'bilinmiyor'}`);

  await env.PAYMENT_KV.put(TOKEN_KV_KEY, token, { expirationTtl: 110 * 60 });
  return token;
}

// ─── EUR/TRY kuru (TCMB, 1 saat KV cache) ──────────────────────────────────────
async function getEurTryRate(env) {
  const cached = await env.PAYMENT_KV.get('hydrozid:eur_try_rate', { type: 'text' });
  if (cached) {
    try {
      const data = JSON.parse(cached);
      if (data.rate) return data.rate;
    } catch {}
  }

  const res = await fetch('https://www.tcmb.gov.tr/kurlar/today.xml', {
    headers: { 'User-Agent': 'Mozilla/5.0 (compatible; HydrozidBot/1.0)' },
  });
  const xml = await res.text();
  const match = xml.match(/CurrencyCode="EUR"[\s\S]*?<BanknoteSelling>([\d,]+)<\/BanknoteSelling>/);
  if (!match) throw new Error('EUR kuru bulunamadı');

  const rate = parseFloat(match[1].replace(',', '.'));
  await env.PAYMENT_KV.put('hydrozid:eur_try_rate', JSON.stringify({ rate, ts: Date.now() }), { expirationTtl: 3600 });
  return rate;
}

// ─── OPTIONS preflight ────────────────────────────────────────────────────────
export async function onRequestOptions(context) {
  return new Response(null, { status: 204, headers: corsHeaders(context.request) });
}

// ─── POST handler ─────────────────────────────────────────────────────────────
export async function onRequestPost(context) {
  const { request, env } = context;

  if (!isAllowedOrigin(request)) {
    return new Response('Forbidden', { status: 403 });
  }

  // Config guard
  if (!env.HALKODE_APP_ID || !env.HALKODE_APP_SECRET || !env.HALKODE_MERCHANT_KEY || !env.PAYMENT_KV) {
    console.error('[payment/start] missing configuration');
    return jsonResp(request, { error: 'Ödeme sistemi yapılandırılmamış.' }, 503);
  }

  // Rate limit
  const clientIP = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  if (!(await checkRateLimit(env.PAYMENT_KV, clientIP))) {
    return jsonResp(request, { error: 'Çok fazla istek. Lütfen bir dakika bekleyin.' }, 429);
  }

  // Parse body
  let input;
  try { input = await request.json(); }
  catch { return jsonResp(request, { error: 'Geçersiz istek formatı.' }, 400); }

  const { name, email, phone, city, address, diploma, package: packageName, currency: reqCurrency } = input;

  // Validation
  if (!name?.trim() || name.trim().length < 3) return jsonResp(request, { error: 'Ad Soyad en az 3 karakter olmalıdır.' }, 400);
  if (!email?.trim() || !/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email.trim())) {
    return jsonResp(request, { error: 'Geçerli bir e-posta girin (Türkçe karakter olmamalı).' }, 400);
  }
  if (!phone?.trim() || !/^0[5][0-9]{9}$/.test(phone.trim())) {
    return jsonResp(request, { error: 'Telefon 05XXXXXXXXX formatında olmalıdır.' }, 400);
  }
  if (!city?.trim() || city.trim().length < 2) return jsonResp(request, { error: 'Şehir seçiniz.' }, 400);
  if (!address?.trim() || address.trim().length < 10) return jsonResp(request, { error: 'Adres en az 10 karakter olmalıdır.' }, 400);
  if (!diploma?.trim() || diploma.trim().length < 5) return jsonResp(request, { error: 'Doktor diploma no giriniz.' }, 400);

  // ─── SERVER-SIDE FİYAT HESAPLAMA ─────────────────────────────────────────
  const eurBase = PACKAGE_PRICES_EUR[packageName];
  const qty = PACKAGE_QTY[packageName];
  if (!eurBase || !qty) return jsonResp(request, { error: 'Geçersiz paket seçimi.' }, 400);

  const currency = reqCurrency === 'EUR' ? 'EUR' : 'TRY';
  let finalPriceNumber;
  let unitPriceNumber;

  if (currency === 'EUR') {
    finalPriceNumber = eurBase;
    unitPriceNumber = Math.round((eurBase / qty) * 100) / 100;
  } else {
    let rate;
    try { rate = await getEurTryRate(env); }
    catch (e) {
      console.error('[payment/start] EUR/TRY rate error:', e.message);
      return jsonResp(request, { error: 'Döviz kuru alınamadı. Lütfen tekrar deneyin.' }, 502);
    }
    finalPriceNumber = Math.round(eurBase * rate);
    unitPriceNumber = Math.round((eurBase / qty) * rate);
  }

  // Ad/Soyad ayır
  const nameParts = name.trim().split(/\s+/);
  const firstName = nameParts.slice(0, -1).join(' ') || name.trim();
  const lastName = nameParts.slice(-1)[0] || '-';

  // HalkÖde token
  let token;
  try { token = await getToken(env); }
  catch (e) {
    console.error('[payment/start] token error:', e.message);
    return jsonResp(request, { error: 'Ödeme sistemi bağlantısı kurulamadı.' }, 502);
  }

  // ─── INVOICE PAYLOAD (TEST EDİLMİŞ FORMAT) ──────────────────────────────
  const invoiceId = crypto.randomUUID();
  const baseUrl = env.BASE_URL || 'https://www.hydrozidtr.com';

  const invoice = {
    invoice_id: invoiceId,
    invoice_description: `Hydrozid ${packageName} - ${qty} adet`,
    total: finalPriceNumber, // NUMBER, string değil!
    return_url: `${baseUrl}/odeme-basarili.html`,
    cancel_url: `${baseUrl}/odeme-hatasi.html`,
    items: [{
      name: `Hydrozid Kriyocerrahi Cihazi (${packageName})`,
      price: unitPriceNumber,
      quantity: qty,
      description: `${packageName} - ${qty} adet paket`,
    }],
    bill_address1: address.trim().substring(0, 100),
    bill_city: city.trim(),
    bill_state: city.trim(),
    bill_country: 'TURKEY', // 'TR' değil!
    bill_phone: phone.trim(),
    bill_email: email.trim().toLowerCase(),
  };

  if (env.WEBHOOK_SECRET) {
    invoice.sale_web_hook_key = env.WEBHOOK_SECRET;
  }

  // ─── PURCHASE LINK ──────────────────────────────────────────────────────
  const formData = new URLSearchParams();
  formData.append('merchant_key', env.HALKODE_MERCHANT_KEY);
  formData.append('invoice', JSON.stringify(invoice));
  formData.append('currency_code', currency);
  formData.append('name', firstName);
  formData.append('surname', lastName);

  let halkResp;
  try {
    const resp = await fetch(`${PLATFORMODE_BASE}/purchase/link`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Accept': 'application/json',
      },
      body: formData.toString(),
    });
    halkResp = await resp.json();
  } catch (e) {
    console.error('[payment/start] fetch error:', e.message);
    return jsonResp(request, { error: 'Ödeme sistemine bağlanılamadı.' }, 502);
  }

  if (halkResp.status !== true || !halkResp.link) {
    console.error('[payment/start] HalkOde error:', JSON.stringify(halkResp));
    return jsonResp(request, { error: 'Ödeme oturumu başlatılamadı.' }, 400);
  }

  // ─── Pending order'ı KV'ye kaydet (webhook'ta eşleşecek) ────────────────
  await env.PAYMENT_KV.put(
    `order:${invoiceId}`,
    JSON.stringify({
      invoiceId,
      orderId: halkResp.order_id,
      customerName: name.trim(),
      customerEmail: email.trim().toLowerCase(),
      customerPhone: phone.trim(),
      customerCity: city.trim(),
      customerAddress: address.trim(),
      diploma: diploma.trim(),
      package: packageName,
      amount: finalPriceNumber,
      currency,
      status: 'PENDING',
      createdAt: new Date().toISOString(),
    }),
    { expirationTtl: 1800 } // 30 dk
  );

  return jsonResp(request, { link: halkResp.link, order_id: halkResp.order_id });
}
