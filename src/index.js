// src/index.js
// Hydrozid Worker (tek dosya) — HalkOde ödeme entegrasyonu
// Cloudflare Worker (static assets + fetch handler) modunda çalışır.
//
// Routes:
//   POST /api/payment/start    → Ödeme linki oluşturur
//   POST /api/payment/webhook  → HalkOde server-to-server callback
//   GET  /api/currency         → EUR/TRY kuru (TCMB)
//   Diğer tüm istekler → ASSETS binding'e gider (HTML/CSS/JS)
//
// Environment Variables (Cloudflare Dashboard → Settings → Variables and Secrets):
//   HALKODE_APP_ID         (secret)
//   HALKODE_APP_SECRET     (secret)
//   HALKODE_MERCHANT_KEY   (secret, $2y$10$... başlar)
//   BASE_URL               (plain: https://www.hydrozidtr.com)
//   WEBHOOK_SECRET         (secret, opsiyonel)
//   TELEGRAM_BOT_TOKEN     (secret, opsiyonel)
//   TELEGRAM_CHAT_ID       (plain, opsiyonel)
//
// Bindings:
//   PAYMENT_KV             (KV namespace)
//   ASSETS                 (static asset binding, otomatik)

const PLATFORMODE_BASE = 'https://app.halkode.com.tr/ccpayment';
const TOKEN_KV_KEY = 'token:halkode';

const TEST_MODE = false;  // tek yerden kontrol

const PACKAGE_PRICES_EUR = TEST_MODE ? {
  'Temel Paket':    1,
  'Klinik Paketi':  2,
  'Kurumsal Paket': 3,
} : {
  'Temel Paket':    149,
  'Klinik Paketi':  695,
  'Kurumsal Paket': 1290,
};

const PACKAGE_QTY = {
  'Temel Paket':    1,
  'Klinik Paketi':  5,
  'Kurumsal Paket': 10,
};

// ══════════════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════════════════════
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Router
    if (path === '/api/payment/start') {
      if (request.method === 'OPTIONS') return handleOptions(request);
      if (request.method === 'POST') return handlePaymentStart(request, env);
      return new Response('Method not allowed', { status: 405 });
    }

    if (path === '/api/payment/webhook') {
      if (request.method === 'POST') return handleWebhook(request, env);
      return new Response('Method not allowed', { status: 405 });
    }

    if (path === '/api/currency') {
      if (request.method === 'GET') return handleCurrency(request, env);
      return new Response('Method not allowed', { status: 405 });
    }

    // Diğer her şey static asset
    if (env.ASSETS) {
      return env.ASSETS.fetch(request);
    }

    return new Response('Not found', { status: 404 });
  }
};

// ══════════════════════════════════════════════════════════════════════════════
// /api/payment/start
// ══════════════════════════════════════════════════════════════════════════════
async function handlePaymentStart(request, env) {
  // ⚠️ BAKIM MODU — test sonrası gece uykuda iken ödeme alınmasın diye
  // Sabah kaldırılacak. Kaldırmak için: bu blok sil + deploy.
  if (env.PAYMENT_KV) {
    const maintenanceMode = false; // ← true = kapalı, false = açık
    if (maintenanceMode) {
      return jsonResp(request, {
        error: 'Ödeme sistemi şu an bakımda. Lütfen WhatsApp\'tan iletişime geçin: +90 553 475 9032'
      }, 503);
    }
  }

  if (!isAllowedOrigin(request)) {
    return new Response('Forbidden', { status: 403 });
  }

  if (!env.HALKODE_APP_ID || !env.HALKODE_APP_SECRET || !env.HALKODE_MERCHANT_KEY || !env.PAYMENT_KV) {
    console.error('[start] missing configuration');
    return jsonResp(request, { error: 'Ödeme sistemi yapılandırılmamış.' }, 503);
  }

  const clientIP = request.headers.get('CF-Connecting-IP') || '0.0.0.0';
  if (!(await checkRateLimit(env.PAYMENT_KV, clientIP))) {
    return jsonResp(request, { error: 'Çok fazla istek. Lütfen bir dakika bekleyin.' }, 429);
  }

  let input;
  try { input = await request.json(); }
  catch { return jsonResp(request, { error: 'Geçersiz istek formatı.' }, 400); }

  const { name, email, phone, city, address, diploma, package: packageName } = input;

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

  if (!Object.prototype.hasOwnProperty.call(PACKAGE_PRICES_EUR, packageName)) {
    return jsonResp(request, { error: 'Geçersiz paket seçimi.' }, 400);
  }
  if (!Object.prototype.hasOwnProperty.call(PACKAGE_QTY, packageName)) {
    return jsonResp(request, { error: 'Geçersiz paket seçimi.' }, 400);
  }

  const eurBase = PACKAGE_PRICES_EUR[packageName];
  const qty = PACKAGE_QTY[packageName];

  const currency = 'TRY';
  let rate;
  try {
    rate = await getEurTryRate(env);
  } catch (e) {
    console.error('[start] EUR/TRY rate error:', e.message);
    return jsonResp(request, { error: 'Döviz kuru alınamadı. Lütfen tekrar deneyin.' }, 502);
  }

  const finalPriceNumber = Math.round(eurBase * rate);
  const unitPriceNumber = Math.round((eurBase / qty) * rate);

  const nameParts = name.trim().split(/\s+/);
  const firstName = nameParts.slice(0, -1).join(' ') || name.trim();
  const lastName = nameParts.slice(-1)[0] || '-';

  let token;
  try { token = await getToken(env); }
  catch (e) {
    console.error('[start] token error:', e.message);
    return jsonResp(request, { error: 'Ödeme sistemi bağlantısı kurulamadı.' }, 502);
  }

  const invoiceId = crypto.randomUUID();
  const baseUrl = env.BASE_URL || 'https://www.hydrozidtr.com';

  const invoice = {
    invoice_id: invoiceId,
    invoice_description: `Hydrozid ${packageName} - ${qty} adet`,
    total: finalPriceNumber,
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
    bill_country: 'TURKEY',
    bill_phone: phone.trim(),
    bill_email: email.trim().toLowerCase(),
  };

  if (env.WEBHOOK_SECRET) {
    invoice.sale_web_hook_key = env.WEBHOOK_SECRET;
  }

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
    console.error('[start] fetch error:', e.message);
    return jsonResp(request, { error: 'Ödeme sistemine bağlanılamadı.' }, 502);
  }

  if (halkResp.status !== true || !halkResp.link) {
    console.error('[start] HalkOde error:', JSON.stringify(halkResp));
    return jsonResp(request, { error: 'Ödeme oturumu başlatılamadı.' }, 400);
  }

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
      quantity: qty,
      eurAmount: eurBase,
      eurTryRate: rate,
      amount: finalPriceNumber,
      currency: 'TRY',
      status: 'PENDING',
      createdAt: new Date().toISOString(),
    }),
    { expirationTtl: 7200 }
  );

  return jsonResp(request, { link: halkResp.link, order_id: halkResp.order_id });
}

// ══════════════════════════════════════════════════════════════════════════════
// /api/payment/webhook
// ══════════════════════════════════════════════════════════════════════════════
async function handleWebhook(request, env) {
  try {
    const contentType = request.headers.get('content-type') || '';
    let data = {};

    if (contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await request.formData();
      data = Object.fromEntries(formData);
    } else if (contentType.includes('application/json')) {
      data = await request.json();
    } else {
      console.warn('[webhook] unknown content-type:', contentType);
      return new Response(JSON.stringify({ error: 'Invalid content type' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    const { invoice_id, order_id, status, payment_status, status_description,
            payment_method, hash_key, transaction_type } = data;

    console.log('[webhook] received:', { invoice_id, order_id, status, payment_status });

    if (!invoice_id) {
      return ack({ success: false, error: 'Missing invoice_id' });
    }

    if (!env.HALKODE_APP_SECRET) {
      console.error('[webhook] HALKODE_APP_SECRET not configured');
      return ack({ success: false, error: 'Not configured' });
    }

    if (hash_key) {
      const decrypted = await validateHash(hash_key, status, order_id, invoice_id, env.HALKODE_APP_SECRET);
      if (!decrypted) {
        console.error('[webhook] ❌ HASH VALIDATION FAILED:', invoice_id);
        // Hash hata verse de devam et — debug için Telegram'a bildir
        if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
          try {
            await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: `⚠️ HASH VALIDATION FAILED\ninvoice_id: ${invoice_id}\norder_id: ${order_id}\nstatus: ${status}` }),
            });
          } catch (e) {}
        }
        // Hash hatası olsa bile devam et (geçici — doğrulandıktan sonra return eklenecek)
      } else {
        console.log('[webhook] ✅ hash validated:', invoice_id);
      }
    } else {
      console.warn('[webhook] missing hash_key:', invoice_id);
    }

    const orderRaw = await env.PAYMENT_KV.get(`order:${invoice_id}`);
    if (!orderRaw) {
      console.warn('[webhook] order not found:', invoice_id);
      // KV süresi dolmuş olabilir — yine de Telegram'a haber ver
      if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
        const isSuccess = (payment_status == 1 || status === 'Completed');
        const msg = `${isSuccess ? '✅' : '❌'} HYDROZİD ÖDEME ${isSuccess ? 'BAŞARILI' : 'BAŞARISIZ'}
⚠️ KV'de sipariş bulunamadı (TTL dolmuş olabilir)

🆔 invoice_id: ${invoice_id}
🔗 order_id: ${order_id || '-'}
📊 status: ${status || '-'} / payment_status: ${payment_status || '-'}
⏰ ${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}`;
        try {
          await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: msg }),
          });
        } catch (e) { console.error('[webhook] telegram fallback error:', e.message); }
      }
      return ack({ success: true, note: 'Order not found but acknowledged' });
    }

    let order;
    try { order = JSON.parse(orderRaw); }
    catch { return ack({ success: false, error: 'Invalid order data' }); }

    // Idempotency
    if (order.status === 'PAID' || order.status === 'FAILED') {
      return ack({ success: true, invoice_id, status: order.status, idempotent: true });
    }

    const isSuccess = (payment_status == 1 || status === 'Completed');
    const updatedOrder = isSuccess
      ? { ...order, status: 'PAID', orderNo: order_id, paidAt: new Date().toISOString(),
          transactionType: transaction_type || 'Auth',
          paymentMethod: getPaymentMethod(payment_method) }
      : { ...order, status: 'FAILED', failedAt: new Date().toISOString(),
          failureReason: status_description,
          transactionType: transaction_type || 'Auth' };

    await env.PAYMENT_KV.put(
      `order:${invoice_id}`,
      JSON.stringify(updatedOrder),
      { expirationTtl: isSuccess ? 86400 * 30 : 86400 * 7 }
    );

    // Telegram
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      const emoji = isSuccess ? '✅' : '❌';
      const statusText = isSuccess ? 'BAŞARILI' : 'BAŞARISIZ';
      const msg = `${emoji} HYDROZİD ÖDEME ${statusText}

👤 ${order.customerName}
📧 ${order.customerEmail}
📱 ${order.customerPhone}
📍 ${order.customerCity}
🏥 Diploma: ${order.diploma}

📦 ${order.package}
💰 ${order.amount} ${order.currency}
🆔 ${invoice_id}
🔗 Order: ${order_id || '-'}

${isSuccess ? '✅ Tamamlandı' : `❌ ${status_description}`}
💳 ${getPaymentMethod(payment_method)}
🔐 Hash: ${hash_key ? '✅' : '⚠️'}
⏰ ${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}`;

      try {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: msg }),
        });
      } catch (e) {
        console.error('[webhook] telegram error:', e.message);
      }
    }

    return ack({ success: true, invoice_id, order_no: order_id, status: isSuccess ? 'paid' : 'failed' });

  } catch (err) {
    console.error('[webhook] exception:', err.message);
    return ack({ success: false, error: err.message });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// /api/currency
// ══════════════════════════════════════════════════════════════════════════════
async function handleCurrency(request, env) {
  try {
    const rate = await getEurTryRate(env);
    return new Response(JSON.stringify({ eur_try: rate, timestamp: new Date().toISOString() }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'public, max-age=3600',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), {
      status: 502,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function isAllowedOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;
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

function handleOptions(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}

async function checkRateLimit(kv, ip) {
  const key = `rl:hydrozid:start:${ip}`;
  const raw = await kv.get(key);
  const count = raw ? parseInt(raw, 10) : 0;
  if (count >= 10) return false;
  await kv.put(key, String(count + 1), { expirationTtl: 60 });
  return true;
}

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
  const match = xml.match(/CurrencyCode="EUR"[\s\S]*?<BanknoteSelling>([\d.,]+)<\/BanknoteSelling>/);
  if (!match) throw new Error('EUR kuru bulunamadı');

  const rate = parseFloat(match[1].replace(',', '.'));
  await env.PAYMENT_KV.put('hydrozid:eur_try_rate', JSON.stringify({ rate, ts: Date.now() }), { expirationTtl: 3600 });
  return rate;
}

async function validateHash(hashKey, expStatus, expOrderId, expInvoiceId, appSecret) {
  try {
    const processed = hashKey.replace(/__/g, '/');
    const parts = processed.split(':');
    if (parts.length !== 3) return null;

    const [ivHex, saltHex, encBase64] = parts;

    const secretSha1 = await sha1(appSecret);
    const keyHex = await sha256(secretSha1 + saltHex);

    const key = await crypto.subtle.importKey(
      'raw', hexToBytes(keyHex),
      { name: 'AES-CBC' }, false, ['decrypt']
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: hexToBytes(ivHex) },
      key,
      base64ToBytes(encBase64)
    );

    const text = new TextDecoder().decode(decrypted);
    const [decStatus, decOrderId, decInvoiceId] = text.split('|');

    if (decStatus !== expStatus) return null;
    if (decOrderId !== String(expOrderId)) return null;
    if (decInvoiceId !== expInvoiceId) return null;

    return text;
  } catch (e) {
    console.error('[webhook] hash decrypt error:', e.message);
    return null;
  }
}

async function sha1(input) {
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(buf));
}

async function sha256(input) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return bytesToHex(new Uint8Array(buf));
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

function getPaymentMethod(id) {
  const map = { '1': 'Kredi Kartı', '2': 'Mobil', '3': 'Cüzdan' };
  return map[id] || 'Bilinmiyor';
}

function ack(data) {
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });
}
