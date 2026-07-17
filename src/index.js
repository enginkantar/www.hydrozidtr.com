// src/index.js
// Hydrozid Worker — HalkOde ödeme + (mock ödeme) + Basit Kargo + QNB fatura
// Cloudflare Worker (static assets + fetch handler) modunda çalışır.
import { kargoGonderiOlustur } from './kargo.js';
import { qnbIrsaliyeliFaturaKes } from './fatura.js';
import { buildBarcodeSvg, buildInvoicePdf, buildShippingCostPdf } from './documents.js';
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
//   ZOHO_FROM_EMAIL        (plain, opsiyonel; Zoho gönderici adresi)
//   RESEND_FROM_EMAIL      (plain, opsiyonel; verified sender)
//   ORDER_ALERT_EMAILS     (plain, opsiyonel; virgül/boşluk ayrılmış alıcılar)
//
// Bindings:
//   PAYMENT_KV             (KV namespace)
//   ASSETS                 (static asset binding, otomatik)

const PLATFORMODE_DEFAULT_BASE = 'https://app.halkode.com.tr/ccpayment';
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

function getPlatformodeBase(env) {
  return (env.PLATFORMODE_ACCESS_URL || env.PLATFORMODE_BASE_URL || env.HALKODE_BASE_URL || PLATFORMODE_DEFAULT_BASE)
    .replace(/\/+$/, '');
}

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

    if (path === '/api/payment/whitelabel-init') {
      if (request.method === 'GET') return handleWhiteLabelInit(request, env);
      return new Response('Method not allowed', { status: 405 });
    }

    if (path === '/api/payment/notify-success') {
      if (request.method === 'OPTIONS') return handleOptions(request);
      if (request.method === 'POST') return handleNotifySuccess(request, env);
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

    if (path === '/api/barcode.svg') {
      if (request.method === 'GET') return handleBarcodeSvg(request, env);
      return new Response('Method not allowed', { status: 405 });
    }

    if (path === '/api/invoice/pdf') {
      if (request.method === 'GET') return handleInvoicePdf(request, env);
      return new Response('Method not allowed', { status: 405 });
    }

    if (path === '/api/shipping-cost/pdf') {
      if (request.method === 'GET') return handleShippingCostPdf(request, env);
      return new Response('Method not allowed', { status: 405 });
    }

    if (path === '/api/address-suggest') {
      if (request.method === 'GET') return handleAddressSuggest(request, env);
      return new Response('Method not allowed', { status: 405 });
    }

    if (path === '/api/telegram/webhook' && request.method === 'POST') {
      return handleTelegramWebhook(request, env);
    }

    if (path === '/odeme-test.html') {
      const target = new URL('/3dSecureGuvenliOdeme.html' + url.search, url);
      return Response.redirect(target, 302);
    }

    // Diğer her şey static asset
    if (env.ASSETS) {
      const response = await env.ASSETS.fetch(request);
      return addSecurityHeaders(response);
    }

    return new Response('Not found', { status: 404 });
  },
  // Not: günlük kampanya artık Oracle crond ile tetikleniyor (docker exec).
  // Cloudflare scheduled handler kaldırıldı — Render backend silindi.
};

// ══════════════════════════════════════════════════════════════════════════════
// /api/payment/start
// ══════════════════════════════════════════════════════════════════════════════
async function handlePaymentStart(request, env) {
  if (!isAllowedOrigin(request)) {
    return new Response('Forbidden', { status: 403 });
  }

  const MOCK = env.MOCK_PAYMENT === '1';
  if (MOCK) {
    if (!env.PAYMENT_KV) return jsonResp(request, { error: 'KV yapılandırılmamış (mock).' }, 503);
  } else if (!env.HALKODE_APP_ID || !env.HALKODE_APP_SECRET || !env.HALKODE_MERCHANT_KEY || !env.PAYMENT_KV) {
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

  const { name, email, phone, city, district, address, diploma, package: packageName, acceptedTerms, acceptedAt } = input;

  if (!acceptedTerms?.onBilgi || !acceptedTerms?.mesafeli || !acceptedTerms?.gizlilik) {
    return jsonResp(request, { error: 'Sözleşmeleri kabul etmeniz gerekir.' }, 400);
  }
  if (!acceptedAt) {
    return jsonResp(request, { error: 'Sözleşme kabul zamanı geçersiz.' }, 400);
  }

  if (!name?.trim() || name.trim().length < 3) return jsonResp(request, { error: 'Ad Soyad en az 3 karakter olmalıdır.' }, 400);
  if (!email?.trim() || !/^[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}$/.test(email.trim())) {
    return jsonResp(request, { error: 'Geçerli bir e-posta girin (Türkçe karakter olmamalı).' }, 400);
  }
  if (!phone?.trim() || !/^0[5][0-9]{9}$/.test(phone.trim())) {
    return jsonResp(request, { error: 'Telefon 05XXXXXXXXX formatında olmalıdır.' }, 400);
  }
  if (!city?.trim() || city.trim().length < 2) return jsonResp(request, { error: 'Şehir seçiniz.' }, 400);
  if (!district?.trim() || district.trim().length < 2) return jsonResp(request, { error: 'İlçe giriniz.' }, 400);
  if (!address?.trim() || address.trim().length < 10) return jsonResp(request, { error: 'Adres en az 10 karakter olmalıdır.' }, 400);
  if (!diploma?.trim() || diploma.trim().length < 4 || diploma.trim().length > 16) return jsonResp(request, { error: 'Doktor diploma tescil numarası 4-16 hane olmalıdır.' }, 400);

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

  // ── MOCK ÖDEME (white-paper): HalkOde'a gitmeden test akışı ──
  if (MOCK) {
    const invoiceId = crypto.randomUUID();
    const orderId = 'MOCK-' + invoiceId.slice(0, 8).toUpperCase();
    await env.PAYMENT_KV.put(`order:${invoiceId}`, JSON.stringify({
      invoiceId, orderId,
      customerName: name.trim(), customerEmail: email.trim().toLowerCase(),
      customerPhone: phone.trim(), customerCity: city.trim(),
      customerTown: district.trim(),
      customerAddress: address.trim(), diploma: diploma.trim(),
      package: packageName, quantity: qty,
      eurAmount: eurBase, eurTryRate: rate, amount: finalPriceNumber, currency: 'TRY',
      status: 'PENDING', createdAt: new Date().toISOString(),
      acceptedAt, termsVersion: '1.0', mock: true,
    }), { expirationTtl: 604800 });
    await env.PAYMENT_KV.put(`halkode:${orderId}`, invoiceId, { expirationTtl: 604800 });
    const link = `/3dSecureGuvenliOdeme.html?oid=${encodeURIComponent(orderId)}` +
      `&amt=${finalPriceNumber}&pkg=${encodeURIComponent(packageName)}`;
    console.log(`[start] MOCK ödeme → ${orderId} (${finalPriceNumber} TRY, ${packageName})`);
    return jsonResp(request, { link, order_id: orderId, mock: true });
  }

  const invoiceId = crypto.randomUUID();
  const platformodeBase = getPlatformodeBase(env);
  const baseUrl = env.BASE_URL || 'https://www.hydrozidtr.com';

  const invoice = {
    invoice_id: invoiceId,
    invoice_description: `Hydrozid ${packageName} - ${qty} adet`,
    total: Number(finalPriceNumber).toFixed(2),
    return_url: `${baseUrl}/odeme-basarili.html`,
    cancel_url: `${baseUrl}/odeme-hatasi.html`,
    response_method: 'GET',
    items: [{
      name: `Hydrozid Kriyocerrahi Cihazi (${packageName})`,
      price: Number(unitPriceNumber).toFixed(2),
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

  await env.PAYMENT_KV.put(
    `order:${invoiceId}`,
    JSON.stringify({
      invoiceId,
      orderId: '',
      customerName: name.trim(),
      customerEmail: email.trim().toLowerCase(),
      customerPhone: phone.trim(),
      customerCity: city.trim(),
      customerTown: district.trim(),
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
      acceptedAt,
      termsVersion: '1.0',
    }),
    { expirationTtl: 604800 }
  );

  const link = `/3dSecureGuvenliOdeme.html?invoice_id=${encodeURIComponent(invoiceId)}&wl=1` +
    `&amt=${finalPriceNumber}&pkg=${encodeURIComponent(packageName)}`;
  await env.PAYMENT_KV.put(`checkout:${invoiceId}`, JSON.stringify({
    invoiceId,
    orderId: '',
    paymentLink: '',
    platformodeBase,
    currency,
    total: Number(finalPriceNumber).toFixed(2),
    installment: 1,
    name: firstName,
    surname: lastName,
    customerCity: city.trim(),
    customerAddress: address.trim(),
  }), { expirationTtl: 604800 });

  return jsonResp(request, { link, order_id: invoiceId, invoice_id: invoiceId, white_label: true });
}

// ══════════════════════════════════════════════════════════════════════════════
// /api/payment/whitelabel-init
// Client-side white-label 3D form için hazır alanlar
// ══════════════════════════════════════════════════════════════════════════════
async function handleWhiteLabelInit(request, env) {
  try {
    const url = new URL(request.url);
    const invoiceId = (url.searchParams.get('invoice_id') || '').trim();
    if (!invoiceId) return jsonResp(request, { error: 'invoice_id required' }, 400);
    if (!env.PAYMENT_KV) return jsonResp(request, { error: 'KV not configured' }, 503);
    if (!env.HALKODE_APP_ID || !env.HALKODE_APP_SECRET || !env.HALKODE_MERCHANT_KEY) {
      return jsonResp(request, { error: 'Ödeme sistemi yapılandırılmamış.' }, 503);
    }

    const raw = await env.PAYMENT_KV.get(`order:${invoiceId}`, { type: 'text' });
    if (!raw) return jsonResp(request, { error: 'Order not found' }, 404);

    const order = JSON.parse(raw);
    const total = Number(order.amount || 0).toFixed(2);
    const qty = Number(order.quantity || 1);
    const unitPrice = qty > 0 ? (Number(order.amount || 0) / qty).toFixed(2) : total;
    const nameParts = String(order.customerName || '').trim().split(/\s+/);
    const firstName = nameParts.slice(0, -1).join(' ') || String(order.customerName || '').trim();
    const lastName = nameParts.slice(-1)[0] || '-';
    const baseUrl = env.BASE_URL || 'https://www.hydrozidtr.com';
    const platformodeBase = getPlatformodeBase(env);
    const actionUrl = `${platformodeBase}/api/paySmart3D`;
    const items = [{
      name: `Hydrozid Kriyocerrahi Cihazi (${order.package || '-'})`,
      price: total,
      quantity: 1,
      description: `${order.package || '-'} - ${qty} adet paket`,
    }];

    const hashKey = await generatePaySmart3dHashKey(
      total,
      1,
      'TRY',
      env.HALKODE_MERCHANT_KEY,
      invoiceId,
      env.HALKODE_APP_SECRET
    );

    return jsonResp(request, {
      action_url: actionUrl,
      invoice_id: invoiceId,
      invoice_description: `Hydrozid ${order.package || '-'} - ${qty} adet`,
      total,
      merchant_key: env.HALKODE_MERCHANT_KEY,
      currency_id: 1,
      currency_code: 'TRY',
      items,
      return_url: `${baseUrl}/odeme-basarili.html`,
      cancel_url: `${baseUrl}/odeme-hatasi.html`,
      response_method: 'GET',
      name: firstName,
      surname: lastName,
      bill_address1: String(order.customerAddress || '').trim().substring(0, 100),
      bill_city: String(order.customerCity || '').trim(),
      bill_state: String(order.customerCity || '').trim(),
      bill_country: 'TURKEY',
      bill_postcode: '',
      bill_email: String(order.customerEmail || '').trim().toLowerCase(),
      bill_phone: String(order.customerPhone || '').trim(),
      sale_web_hook_key: env.WEBHOOK_SECRET || '',
      ip: request.headers.get('CF-Connecting-IP') || '',
      saved_card: 0,
      maturity_period: 0,
      payment_frequency: 0,
      installments_number: 1,
      transaction_type: 'Auth',
      hash_key: hashKey,
      order_id: order.orderId || '',
      platformode_base: platformodeBase,
      unit_price: unitPrice,
    });
  } catch (e) {
    console.error('[whitelabel-init] error:', e.message);
    return jsonResp(request, { error: e.message }, 500);
  }
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

    // Hash doğrulama: geçersiz/eksik hash ile gelen "başarılı" webhook'lar
    // sahte olabilir (müşteri kendi invoice_id'sini bilir). Hash geçmezse
    // ödeme durumu sağlayıcıdan sunucu-sunucu (checkstatus) teyit edilir.
    let hashValid = false;
    if (hash_key) {
      const decrypted = await validateHash(hash_key, status, order_id, invoice_id, env.HALKODE_APP_SECRET);
      hashValid = !!decrypted;
      if (!hashValid) {
        console.error('[webhook] ❌ HASH VALIDATION FAILED:', invoice_id);
        await sendTelegram(env, `⚠️ HASH VALIDATION FAILED\ninvoice_id: ${invoice_id}\norder_id: ${order_id}\nstatus: ${status}`);
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

    let isSuccess = (payment_status == 1 || status === 'Completed');

    // Sahte "ödendi" webhook koruması: hash doğrulanamadıysa sağlayıcıdan teyit al
    if (isSuccess && !hashValid) {
      const statusCheck = await checkPlatformodeOrderStatus(env, invoice_id);
      if (!statusCheck.ok) {
        console.error('[webhook] ❌ ödeme sağlayıcıdan teyit edilemedi:', invoice_id, statusCheck.error);
        await sendTelegram(env, `🚨 SAHTE WEBHOOK ŞÜPHESİ\ninvoice_id: ${invoice_id}\nHash geçersiz + sağlayıcı teyidi başarısız: ${statusCheck.error || '-'}\nSipariş PAID yapılmadı.`);
        return ack({ success: false, error: 'Payment not confirmed by provider' });
      }
      console.log('[webhook] ✅ sağlayıcı checkstatus teyidi alındı:', invoice_id);
    }

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

    if (isSuccess) {
      await fulfillPaidOrder(env, updatedOrder, invoice_id, order_id, 'webhook');
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
// /api/address-suggest
// ══════════════════════════════════════════════════════════════════════════════
async function handleAddressSuggest(request, env) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  if (q.length < 3) {
    return new Response(JSON.stringify({ suggestions: [] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }

  try {
    const apiKey = getGoogleMapsApiKey(env);

    const suggestions = apiKey
      ? await googleAddressSuggestions(q, apiKey)
      : await osmAddressSuggestions(q);

    return new Response(JSON.stringify({ suggestions }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  } catch (e) {
    console.error('[address-suggest] error:', e.message);
    return new Response(JSON.stringify({ suggestions: [], error: e.message }), {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
    });
  }
}

function getGoogleMapsApiKey(env) {
  return env.GOOGLE_MAPS_API_KEY || env.MAPS_PLATFORM_API_KEY || env.MAPS_API_KEY || '';
}

async function googleAddressSuggestions(q, apiKey) {
  const autocomplete = new URL('https://maps.googleapis.com/maps/api/place/autocomplete/json');
  autocomplete.searchParams.set('input', q);
  autocomplete.searchParams.set('key', apiKey);
  autocomplete.searchParams.set('language', 'tr');
  autocomplete.searchParams.set('components', 'country:tr');
  autocomplete.searchParams.set('types', 'address');

  const autoRes = await fetch(autocomplete, { headers: { 'Accept': 'application/json' } });
  const autoData = await autoRes.json();
  const predictions = Array.isArray(autoData?.predictions) ? autoData.predictions.slice(0, 5) : [];
  if (!predictions.length) return [];

  const details = await Promise.all(predictions.map(async p => {
    const detailUrl = new URL('https://maps.googleapis.com/maps/api/place/details/json');
    detailUrl.searchParams.set('place_id', p.place_id);
    detailUrl.searchParams.set('fields', 'formatted_address,address_component');
    detailUrl.searchParams.set('language', 'tr');
    detailUrl.searchParams.set('key', apiKey);

    try {
      const detailRes = await fetch(detailUrl, { headers: { 'Accept': 'application/json' } });
      const detailData = await detailRes.json();
      const result = detailData?.result || {};
      const components = Array.isArray(result.address_components) ? result.address_components : [];
      const pick = (...types) => {
        const found = components.find(c => Array.isArray(c.types) && types.some(t => c.types.includes(t)));
        return found?.long_name || '';
      };
      const city = pick('administrative_area_level_1', 'locality', 'postal_town');
      const district = pick('administrative_area_level_2', 'sublocality_level_1', 'sublocality', 'neighborhood');
      return {
        label: result.formatted_address || p.description || q,
        city,
        district,
        address: result.formatted_address || p.description || q,
      };
    } catch {
      return {
        label: p.description || q,
        city: '',
        district: '',
        address: p.description || q,
      };
    }
  }));

  return details.filter(s => s.label);
}

async function osmAddressSuggestions(q) {
  const upstream = new URL('https://nominatim.openstreetmap.org/search');
  upstream.searchParams.set('format', 'jsonv2');
  upstream.searchParams.set('addressdetails', '1');
  upstream.searchParams.set('countrycodes', 'tr');
  upstream.searchParams.set('dedupe', '1');
  upstream.searchParams.set('limit', '6');
  upstream.searchParams.set('q', q);

  const res = await fetch(upstream, {
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'HydrozidTR/1.0 (address autocomplete)',
    },
  });
  const data = await res.json();
  return (Array.isArray(data) ? data : []).map(item => {
    const a = item.address || {};
    const city = a.city || a.town || a.village || a.county || a.state || '';
    const district = a.city_district || a.suburb || a.borough || a.county || '';
    const parts = [
      a.neighbourhood,
      a.road,
      a.house_number,
    ].filter(Boolean);
    const street = parts.join(' ').trim();
    const address = [street, district, city].filter(Boolean).join(', ');
    return {
      label: item.display_name || address || q,
      city,
      district,
      address,
    };
  }).filter(s => s.label);
}

// ══════════════════════════════════════════════════════════════════════════════
// /api/payment/notify-success
// ══════════════════════════════════════════════════════════════════════════════
async function handleNotifySuccess(request, env) {
  try {
    let body;
    try { body = await request.json(); }
    catch { return jsonResp(request, { error: 'Invalid JSON' }, 400); }

    const { order_id, order_no, invoice_id, payment_status, status, hash_key } = body;
    const incomingInvoiceId = (invoice_id || '').trim();
    const incomingOrderId = (order_id || order_no || '').trim();
    const incomingStatus = status ?? (String(payment_status) === '1' ? 'Completed' : '');
    const incomingPaymentStatus = String(payment_status ?? '');

    if (!env.PAYMENT_KV) return jsonResp(request, { error: 'KV not configured' }, 503);

    let invoiceId = incomingInvoiceId;
    if (!invoiceId && incomingOrderId) {
      invoiceId = await env.PAYMENT_KV.get(`halkode:${incomingOrderId}`, { type: 'text' }) || '';
    }
    if (!invoiceId) {
      console.warn('[notify] invoiceId not found:', { incomingInvoiceId, incomingOrderId });
      return jsonResp(request, { ok: false, note: 'invoice not found' });
    }

    const orderRaw = await env.PAYMENT_KV.get(`order:${invoiceId}`, { type: 'text' });
    if (!orderRaw) {
      console.warn('[notify] order not found:', invoiceId);
      return jsonResp(request, { ok: false, note: 'order not found' });
    }

    let order;
    try { order = JSON.parse(orderRaw); }
    catch { return jsonResp(request, { error: 'Invalid order data' }, 500); }

    const isSuccessHint = incomingPaymentStatus === '1' || incomingStatus === 'Completed';

    if (order.status === 'PENDING') {
      if (order.mock && env.MOCK_PAYMENT === '1') {
        order.status = 'PAID';
        order.paidAt = new Date().toISOString();
        order.paidVia = 'mock_browser_return';
      } else if (isSuccessHint) {
        // Hash provider formatına göre değişebiliyor; geçersizse reddetme,
        // asıl teyidi sağlayıcıdan sunucu-sunucu (checkstatus) al.
        if (hash_key && env.HALKODE_APP_SECRET) {
          const validated = await validateHash(hash_key, incomingStatus || 'Completed', incomingOrderId || order.orderId || '', invoiceId, env.HALKODE_APP_SECRET);
          if (!validated) {
            console.warn('[notify] hash geçersiz — sağlayıcı checkstatus ile teyit edilecek:', invoiceId);
          }
        }

        const statusCheck = await checkPlatformodeOrderStatus(env, invoiceId);
        if (!statusCheck.ok) {
          return jsonResp(request, { ok: false, note: statusCheck.error || 'payment confirmation pending' }, 409);
        }

        order.status = 'PAID';
        order.paidAt = new Date().toISOString();
        order.paidVia = 'whitelabel_return';
        order.orderId = incomingOrderId || statusCheck.orderId || order.orderId || '';
        order.orderNo = order.orderId;
      } else {
        return jsonResp(request, { ok: false, note: 'payment confirmation pending' }, 409);
      }
    }

    // Order başka bir state'deyse (FAILED vs) bildirme
    if (order.status !== 'PAID') {
      return jsonResp(request, { ok: false, note: `order status is ${order.status}` });
    }

    // Idempotency — zaten bildirilmişse tekrar gönderme
    if (order.notifiedAt) {
      return jsonResp(request, { ok: true, idempotent: true, notifiedAt: order.notifiedAt, siparis: siparisOzeti(order, invoiceId) });
    }

    const fulfillment = await fulfillPaidOrder(env, order, invoiceId, order.orderId || incomingOrderId || invoiceId, 'browser');
    return jsonResp(request, { ok: true, notifiedAt: fulfillment.notifiedAt, amount: order.amount, currency: order.currency, orderNo: order.orderNo || order.orderId || incomingOrderId || invoiceId, siparis: fulfillment.siparis });

  } catch (err) {
    console.error('[notify] exception:', err.message);
    return jsonResp(request, { error: err.message }, 500);
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// FULFILLMENT: ödeme başarı sonrası tek kapı
// ══════════════════════════════════════════════════════════════════════════════
async function fulfillPaidOrder(env, order, invoiceId, orderId, source) {
  if (order.notifiedAt) {
    return { ok: true, idempotent: true, notifiedAt: order.notifiedAt, siparis: siparisOzeti(order, orderId) };
  }
  if (order.status !== 'PAID') {
    return { ok: false, note: `order status is ${order.status}`, siparis: siparisOzeti(order, orderId) };
  }

  if (!order.kargoBarcode) {
    const kargo = await kargoGonderiOlustur(env, order);
    if (kargo.ok) {
      order.kargoBarcode = kargo.barcode;
      order.kargoHandler = kargo.handler;
      order.kargoFirma = kargo.handler || order.kargoFirma || 'KARGO';
      if (Number(kargo.cost) > 0) order.kargoMasraf = Number(kargo.cost);
      console.log(`[notify:${source}] ✅ kargo barkod:`, kargo.barcode, `(${kargo.handler})`);
    } else {
      order.kargoError = `${kargo.error || ''} ${kargo.detay || ''}`.trim();
      order.kargoFirma = order.kargoHandler || order.kargoFirma || 'KARGO';
      console.warn(`[notify:${source}] ⚠️ kargo başarısız:`, order.kargoError);
    }
  }

  if (!order.faturaNo) {
    const fatura = await qnbIrsaliyeliFaturaKes(env, order);
    if (fatura.ok) {
      order.faturaNo = fatura.faturaNo;
      order.faturaUuid = fatura.uuid;
      order.faturaMock = !!fatura.mock;
      console.log(`[notify:${source}] ✅ fatura:`, fatura.faturaNo, fatura.mock ? '(MOCK)' : '(gerçek)');
    } else {
      order.faturaError = fatura.error;
      order.faturaNo = fatura.faturaNo;
      console.warn(`[notify:${source}] ⚠️ fatura başarısız:`, fatura.error);
    }
  }

  const notifiedAt = new Date().toISOString();
  const trDate = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

  const telegramText = `✅ HYDROZİD SİPARİŞ BİLGİSİ

👤 ${order.customerName}
📧 ${order.customerEmail}
📱 ${order.customerPhone}
📍 ${order.customerCity}
🏥 Diploma: ${order.diploma}

📦 ${order.package}
💰 ${order.amount} ${order.currency}
🆔 ${invoiceId}
🔗 Order: ${orderId || '-'}
🚚 Kargo: ${order.kargoBarcode || ('HATA: ' + (order.kargoError || '-'))}
🚚 Kargo Firması: ${order.kargoFirma || order.kargoHandler || '-'}
💸 Kargo Masrafı: ${Number(order.kargoMasraf || 0).toLocaleString('tr-TR')} TRY
🧾 Fatura: ${order.faturaNo || '-'}${order.faturaMock ? ' (mock)' : ''}${order.faturaError ? ' HATA: ' + order.faturaError : ''}
⏰ ${trDate}`;

  await sendTelegram(env, telegramText);

  if (env.RESEND_API_KEY || (env.ZOHO_REFRESH_TOKEN && env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET)) {
    const adminHtml = `
<div style="text-align: center; padding: 0 0 16px;">
  <img src="https://www.hydrozidtr.com/assets/favicon-96x96.png" alt="Hydrozid®" style="height: 48px; width: 48px; display: inline-block; margin-bottom: 8px;"><br>
  <img src="https://www.hydrozidtr.com/assets/hydrozid-product-nobg.png" alt="Hydrozid" style="height: 60px; width: auto;">
</div>
<h2>Yeni Sipariş — Hydrozid</h2>
<table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
  <tr><td style="padding:6px 12px;color:#666">Müşteri</td><td style="padding:6px 12px"><strong>${order.customerName}</strong></td></tr>
  <tr><td style="padding:6px 12px;color:#666">E-posta</td><td style="padding:6px 12px">${order.customerEmail}</td></tr>
  <tr><td style="padding:6px 12px;color:#666">Telefon</td><td style="padding:6px 12px">${order.customerPhone}</td></tr>
  <tr><td style="padding:6px 12px;color:#666">Şehir</td><td style="padding:6px 12px">${order.customerCity}</td></tr>
  <tr><td style="padding:6px 12px;color:#666">Adres</td><td style="padding:6px 12px">${order.customerAddress}</td></tr>
  <tr><td style="padding:6px 12px;color:#666">Diploma No</td><td style="padding:6px 12px">${order.diploma}</td></tr>
  <tr><td style="padding:6px 12px;color:#666">Paket</td><td style="padding:6px 12px">${order.package} (${order.quantity} adet)</td></tr>
  <tr><td style="padding:6px 12px;color:#666">Tutar</td><td style="padding:6px 12px"><strong>${order.amount} ${order.currency}</strong> (${order.eurAmount} EUR × ${order.eurTryRate?.toFixed(2)})</td></tr>
  <tr><td style="padding:6px 12px;color:#666">Sipariş No</td><td style="padding:6px 12px">${order.orderNo || orderId}</td></tr>
  <tr><td style="padding:6px 12px;color:#666">Kargo Firması</td><td style="padding:6px 12px">${order.kargoFirma || order.kargoHandler || '—'}</td></tr>
  <tr><td style="padding:6px 12px;color:#666">Kargo Masrafı</td><td style="padding:6px 12px"><strong>${Number(order.kargoMasraf || 0).toLocaleString('tr-TR')} TRY</strong></td></tr>
  <tr><td style="padding:6px 12px;color:#666">Kargo Barkod</td><td style="padding:6px 12px"><strong>${order.kargoBarcode || ('— ' + (order.kargoError || ''))}</strong> ${order.kargoHandler || ''}</td></tr>
  <tr><td style="padding:6px 12px;color:#666">Fatura No</td><td style="padding:6px 12px"><strong>${order.faturaNo || '—'}</strong>${order.faturaMock ? ' (mock)' : ''}${order.faturaError ? ' — ' + order.faturaError : ''}</td></tr>
  <tr><td style="padding:6px 12px;color:#666">Fatura PDF</td><td style="padding:6px 12px"><a href="https://www.hydrozidtr.com/api/invoice/pdf?order_id=${encodeURIComponent(orderId)}" target="_blank" rel="noopener">PDF'yi aç</a></td></tr>
  <tr><td style="padding:6px 12px;color:#666">Kargo Masraf PDF</td><td style="padding:6px 12px"><a href="https://www.hydrozidtr.com/api/shipping-cost/pdf?order_id=${encodeURIComponent(orderId)}" target="_blank" rel="noopener">Masraf özeti</a></td></tr>
  <tr><td style="padding:6px 12px;color:#666">Tarih</td><td style="padding:6px 12px">${trDate}</td></tr>
</table>`;

    const recipientSet = new Set(getOrderAlertEmails(env));
    if (env.FATURA_KOPYA_EMAIL) recipientSet.add(env.FATURA_KOPYA_EMAIL);
    recipientSet.add('enginkantar@gmail.com');

    const emailJobs = Array.from(recipientSet).map(to => sendEmail(env, {
      to,
      subject: `[Hydrozid] Yeni Sipariş — ${order.customerName} / ${order.package}`,
      html: adminHtml,
    }));

    const customerHtml = `
<div style="font-family:'Nunito Sans',sans-serif;background:#070B14;color:#CBD5E1;padding:40px 24px;max-width:560px;margin:0 auto;border-radius:16px">
  <div style="text-align: center; padding: 32px 0 24px; border-bottom: 1px solid #1e293b; margin-bottom: 24px;">
    <img src="https://www.hydrozidtr.com/assets/favicon-96x96.png" alt="Hydrozid®" style="height: 48px; width: 48px; display: inline-block; margin-bottom: 12px;"><br>
    <img src="https://www.hydrozidtr.com/assets/hydrozid-product-nobg.png" alt="Hydrozid® Sprey" style="height: 100px; width: auto; display: inline-block;">
  </div>
  <h1 style="font-family:Rubik,sans-serif;color:#00D4FF;font-size:1.4rem;margin-bottom:8px">Siparişiniz Alındı!</h1>
  <p style="color:#94A3B8;margin-bottom:24px">Sayın <strong style="color:#fff">${order.customerName}</strong>, ödemeniz başarıyla tamamlandı.</p>
  <table style="font-size:14px;border-collapse:collapse;width:100%">
    <tr><td style="padding:8px 0;color:#64748B;width:140px">Sipariş No</td><td style="padding:8px 0;color:#fff;font-weight:700">${order.orderNo || orderId}</td></tr>
    <tr><td style="padding:8px 0;color:#64748B">Ürün</td><td style="padding:8px 0;color:#fff">Hydrozid® ${order.package} — ${order.quantity} adet</td></tr>
    <tr><td style="padding:8px 0;color:#64748B">Tutar</td><td style="padding:8px 0;color:#22C55E;font-weight:700">${order.amount} ${order.currency}</td></tr>
    <tr><td style="padding:8px 0;color:#64748B">Teslimat Adresi</td><td style="padding:8px 0;color:#CBD5E1">${order.customerCity} — ${order.customerAddress}</td></tr>
    <tr><td style="padding:8px 0;color:#64748B">Kargo Firması</td><td style="padding:8px 0;color:#CBD5E1">${order.kargoFirma || order.kargoHandler || '—'}</td></tr>
    <tr><td style="padding:8px 0;color:#64748B">Kargo Barkod</td><td style="padding:8px 0;color:#CBD5E1">${order.kargoBarcode || '—'}</td></tr>
  </table>
  ${order.kargoBarcode ? `<div style="margin-top:18px;padding:14px;background:#fff;border-radius:12px;text-align:center"><img src="https://www.hydrozidtr.com/api/barcode.svg?code=${encodeURIComponent(order.kargoBarcode)}" alt="Kargo barkodu" style="width:100%;max-width:640px;display:block;margin:0 auto"></div>` : ''}
  <p style="margin-top:24px;color:#94A3B8;font-size:0.9rem">Siparişiniz en kısa sürede kargoya verilecek ve kargo takip bilgileri ayrıca iletilecektir.</p>
  <p style="margin-top:8px;color:#94A3B8;font-size:0.9rem">Sorularınız için: <a href="mailto:bilgi@hydrozidtr.com" style="color:#00D4FF">bilgi@hydrozidtr.com</a> veya WhatsApp <a href="https://wa.me/905534759032" style="color:#00D4FF">+90 553 475 9032</a></p>
  <p style="margin-top:8px;color:#94A3B8;font-size:0.9rem">Fatura PDF: <a href="https://www.hydrozidtr.com/api/invoice/pdf?order_id=${encodeURIComponent(orderId)}" style="color:#00D4FF">indir</a></p>

  <!-- DOKTOR ÖNER BÖLÜMÜ -->
  <div style="margin: 32px 0 24px; padding: 24px; background: #f0f9ff; border: 1px solid #bae6fd; border-radius: 12px; text-align: center;">
    <p style="color: #0c4a6e; font-size: 16px; font-weight: 700; margin: 0 0 8px;">
      🎯 Hydrozid'den memnun kaldıysanız
    </p>
    <p style="color: #0369a1; font-size: 14px; margin: 0 0 20px;">
      Doktor meslektaşlarınıza önerin, onlar da güvenilir kriyoterapi spreyine ulaşsın.
    </p>
    <a href="https://wa.me/?text=Hydrozid%20kriyoterapi%20cihaz%C4%B1n%C4%B1%20kullan%C4%B1yorum%2C%20doktor%20arkada%C5%9Flar%C4%B1ma%20da%20%C3%B6neriyorum%3A%20https%3A%2F%2Fhydrozidtr.com"
       style="display: inline-block; background: #25D366; color: #fff; padding: 12px 20px; text-decoration: none; border-radius: 8px; margin: 4px; font-weight: 700; font-size: 13px;">
      📱 WhatsApp ile Paylaş
    </a>
    <a href="mailto:?subject=Hydrozid%20%C3%96nerisi&body=Sevgili%20meslekta%C5%9F%C4%B1m%2C%0A%0AHydrozid%20kriyoterapi%20cihaz%C4%B1n%C4%B1%20kullanmaya%20ba%C5%9Flad%C4%B1m%20ve%20performans%C4%B1ndan%20%C3%A7ok%20memnunum.%20FDA%20510(k)%20onayl%C4%B1%2C%20CE%20belgeli.%20Size%20de%20%C3%B6neririm.%0A%0A%C3%9Cr%C3%BCn%20bilgisi%3A%20https%3A%2F%2Fhydrozidtr.com"
       style="display: inline-block; background: #6366F1; color: #fff; padding: 12px 20px; text-decoration: none; border-radius: 8px; margin: 4px; font-weight: 700; font-size: 13px;">
      ✉️ E-posta ile Paylaş
    </a>
  </div>

  <!-- SOSYAL MEDYA BANDI -->
  <div style="text-align: center; padding: 24px 0; border-top: 1px solid #e5e7eb; margin-top: 24px;">
    <p style="color: #6b7280; font-size: 13px; margin: 0 0 16px; font-weight: 600;">
      Bizi takip edin
    </p>
    <a href="https://wa.me/905534759032" style="display: inline-block; margin: 0 8px; text-decoration: none;">
      <img src="https://img.icons8.com/color/48/whatsapp.png" alt="WhatsApp" style="width: 32px; height: 32px;">
    </a>
    <a href="https://instagram.com/batu_medikal" style="display: inline-block; margin: 0 8px; text-decoration: none;">
      <img src="https://img.icons8.com/color/48/instagram-new.png" alt="Instagram" style="width: 32px; height: 32px;">
    </a>
    <a href="https://www.tiktok.com/@batu_medikal" style="display: inline-block; margin: 0 8px; text-decoration: none;">
      <img src="https://img.icons8.com/color/48/tiktok--v1.png" alt="TikTok" style="width: 32px; height: 32px;">
    </a>
    <a href="https://youtube.com/@Batu_Medikal" style="display: inline-block; margin: 0 8px; text-decoration: none;">
      <img src="https://img.icons8.com/color/48/youtube-play.png" alt="YouTube" style="width: 32px; height: 32px;">
    </a>
    <a href="https://facebook.com/medikal.batu" style="display: inline-block; margin: 0 8px; text-decoration: none;">
      <img src="https://img.icons8.com/color/48/facebook-new.png" alt="Facebook" style="width: 32px; height: 32px;">
    </a>
  </div>

  <!-- ŞİRKET BİLGİLERİ -->
  <div style="text-align: center; padding: 16px 0 8px; font-size: 12px; color: #6b7280; line-height: 1.8;">
    <p style="margin: 0; font-weight: 700; color: #111827; font-size: 14px;">Hydrozid® Türkiye</p>
    <p style="margin: 4px 0;">Batu Medikal — Çorum, Türkiye</p>
    <p style="margin: 4px 0;">MERSİS NO: 4016506204800017</p>
    <p style="margin: 4px 0;">
      <a href="https://wa.me/905534759032" style="color: #25D366; text-decoration: none; font-weight: 600;">WhatsApp: +90 553 475 9032</a> &nbsp;|&nbsp;
      <a href="mailto:bilgi@hydrozidtr.com" style="color: #0369a1; text-decoration: none;">bilgi@hydrozidtr.com</a>
    </p>
    <p style="margin: 4px 0;">
      <a href="https://www.hydrozidtr.com" style="color: #0369a1; text-decoration: none;">www.hydrozidtr.com</a> &nbsp;|&nbsp;
      <a href="https://www.batumedikal.com" style="color: #6b7280; text-decoration: none;">batumedikal.com</a>
    </p>
    <p style="margin: 12px 0 0; padding-top: 12px; border-top: 1px solid #e5e7eb; font-size: 11px;">
      © 2026 Hydrozid® Türkiye — FDA 510(k) onaylı, CE belgeli
    </p>
  </div>
</div>`;

    emailJobs.push(sendEmail(env, {
      to: order.customerEmail,
      subject: 'Hydrozid® Siparişiniz Alındı',
      html: customerHtml,
      replyTo: env.RESEND_FROM_EMAIL || 'bilgi@hydrozidtr.com',
    }));

    const results = await Promise.allSettled(emailJobs);
    const failures = results.filter(r => r.status === 'rejected' || r.value === false).length;
    if (failures) console.warn(`[notify:${source}] mail failures:`, failures);
  }

  await env.PAYMENT_KV.put(
    `order:${invoiceId}`,
    JSON.stringify({ ...order, notifiedAt }),
    { expirationTtl: 86400 * 30 }
  );

  return { ok: true, notifiedAt, siparis: siparisOzeti(order, orderId) };
}

// ══════════════════════════════════════════════════════════════════════════════
// sendEmail (Zoho Mail API → Resend fallback)
// ══════════════════════════════════════════════════════════════════════════════
async function sendEmail(env, { to, subject, html, replyTo }) {
  if (env.ZOHO_REFRESH_TOKEN && env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET) {
    const zoho = await sendZohoEmail(env, { to, subject, html, replyTo });
    if (zoho.ok) return true;
    console.warn('[zoho] fallback to resend:', zoho.error || 'unknown error');
  }

  if (!env.RESEND_API_KEY) return false;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${env.RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        from: env.RESEND_FROM_EMAIL || 'Hydrozid Sipariş <siparis@hydrozidtr.com>',
        to: [to],
        subject,
        html,
        reply_to: replyTo || 'bilgi@hydrozidtr.com',
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error('[resend] failed:', res.status, err);
      return false;
    }
    return true;
  } catch (e) {
    console.error('[resend] exception:', e.message);
    return false;
  }
}

async function sendZohoEmail(env, { to, subject, html, replyTo }) {
  try {
    const accessToken = await getZohoAccessToken(env);
    if (!accessToken) return { ok: false, error: 'access token alınamadı' };

    const account = await getZohoAccount(env, accessToken);
    if (!account?.accountId || !account?.email) {
      return { ok: false, error: 'Zoho account bulunamadı' };
    }

    const sender = chooseZohoSender(env, account);
    const body = {
      fromAddress: sender,
      toAddress: to,
      subject,
      content: html,
      mailFormat: 'html',
      askReceipt: 'no',
      encoding: 'UTF-8',
    };

    const res = await fetch(`https://mail.zoho.com/api/accounts/${account.accountId}/messages`, {
      method: 'POST',
      headers: {
        'Authorization': `Zoho-oauthtoken ${accessToken}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}: ${text.slice(0, 240)}` };
    return { ok: true, raw: text };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

async function getZohoAccessToken(env) {
  const cacheKey = 'zoho:access_token';
  if (env.PAYMENT_KV) {
    const cached = await env.PAYMENT_KV.get(cacheKey, { type: 'json' });
    if (cached?.access_token && cached?.expires_at && cached.expires_at > Date.now() + 60000) {
      return cached.access_token;
    }
  }

  const tokenUrl = new URL('https://accounts.zoho.com/oauth/v2/token');
  tokenUrl.searchParams.set('grant_type', 'refresh_token');
  tokenUrl.searchParams.set('refresh_token', env.ZOHO_REFRESH_TOKEN);
  tokenUrl.searchParams.set('client_id', env.ZOHO_CLIENT_ID);
  tokenUrl.searchParams.set('client_secret', env.ZOHO_CLIENT_SECRET);
  if (env.ZOHO_REDIRECT_URI) tokenUrl.searchParams.set('redirect_uri', env.ZOHO_REDIRECT_URI);

  const res = await fetch(tokenUrl, { method: 'POST' });
  const data = await res.json().catch(() => ({}));
  const accessToken = data?.access_token || '';
  const expiresIn = Number(data?.expires_in || 3600);
  if (!accessToken) {
    console.error('[zoho] token error:', res.status, JSON.stringify(data).slice(0, 240));
    return '';
  }

  if (env.PAYMENT_KV) {
    await env.PAYMENT_KV.put(cacheKey, JSON.stringify({
      access_token: accessToken,
      expires_at: Date.now() + Math.max(300, expiresIn - 60) * 1000,
    }), { expirationTtl: Math.max(300, expiresIn - 60) });
  }
  return accessToken;
}

async function getZohoAccount(env, accessToken) {
  const cacheKey = 'zoho:account';
  if (env.PAYMENT_KV) {
    const cached = await env.PAYMENT_KV.get(cacheKey, { type: 'json' });
    if (cached?.accountId && cached?.email) return cached;
  }

  const res = await fetch('https://mail.zoho.com/api/accounts', {
    headers: {
      'Authorization': `Zoho-oauthtoken ${accessToken}`,
      'Accept': 'application/json',
    },
  });
  const data = await res.json().catch(() => ({}));
  const list = Array.isArray(data?.data) ? data.data : [];
  const wanted = (env.ZOHO_FROM_EMAIL || '').trim().toLowerCase();
  const picked = (wanted && list.find(a => {
    const emails = [
      a.primaryEmailAddress,
      a.mailboxAddress,
      a.incomingUserName,
      ...(Array.isArray(a.emailAddress) ? a.emailAddress.map(e => e.mailId) : []),
    ].filter(Boolean).map(x => String(x).toLowerCase());
    return emails.includes(wanted);
  })) || list[0];
  const account = picked ? {
    accountId: picked.accountId || picked.id || picked.account_id || '',
    email: picked.primaryEmailAddress
      || picked.mailboxAddress
      || picked.incomingUserName
      || (Array.isArray(picked.emailAddress) ? picked.emailAddress.find(e => e.isPrimary)?.mailId : '')
      || (Array.isArray(picked.emailAddress) ? picked.emailAddress[0]?.mailId : '')
      || '',
  } : null;

  if (account?.accountId && account?.email && env.PAYMENT_KV) {
    await env.PAYMENT_KV.put(cacheKey, JSON.stringify(account), { expirationTtl: 86400 });
  }
  return account;
}

function getOrderAlertEmails(env) {
  const raw = env.ORDER_ALERT_EMAILS || '';
  const parsed = raw
    .split(/[\s,;]+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (parsed.length) return parsed;
  return ['bilgi@hydrozidtr.com', 'enginkantar@gmail.com', 'medikalbatu@gmail.com'];
}

function chooseZohoSender(env, account) {
  const preferred = (env.ZOHO_FROM_EMAIL || '').trim().toLowerCase();
  const addresses = new Set([
    account?.email,
    account?.primaryEmailAddress,
    account?.mailboxAddress,
    account?.incomingUserName,
    ...(Array.isArray(account?.emailAddress) ? account.emailAddress.map(e => e.mailId) : []),
  ].filter(Boolean).map(x => String(x).toLowerCase()));

  if (preferred && addresses.has(preferred)) return preferred;
  if (addresses.has('bilgi@hydrozidtr.com')) return 'bilgi@hydrozidtr.com';
  if (account?.primaryEmailAddress) return account.primaryEmailAddress;
  if (account?.mailboxAddress) return account.mailboxAddress;
  if (account?.incomingUserName) return account.incomingUserName;
  return account?.email || '';
}

async function sendTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    });
    if (!res.ok) {
      console.error('[telegram] sendMessage failed:', res.status, await res.text());
      return false;
    }
    return true;
  } catch (e) {
    console.error('[telegram] sendMessage error:', e.message);
    return false;
  }
}

// ══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ══════════════════════════════════════════════════════════════════════════════
function isAllowedOrigin(request) {
  const origin = request.headers.get('Origin');
  if (!origin) return true;

  let host;
  try {
    const url = new URL(origin);
    host = url.hostname.toLowerCase();
  } catch {
    return false;
  }

  const allowed = ['hydrozidtr.com', 'www.hydrozidtr.com', 'localhost', '127.0.0.1'];
  if (allowed.includes(host)) return true;
  if (host.startsWith('192.168.')) return true;
  return false;
}

function corsHeaders(request) {
  const origin = request.headers.get('Origin');
  // SADECE whitelist'teki origin'leri echo et
  const safeOrigin = (origin && isAllowedOrigin(request))
    ? origin
    : 'https://www.hydrozidtr.com';
  return {
    'Access-Control-Allow-Origin':  safeOrigin,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}

function jsonResp(request, data, status = 200) {
  const resp = new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type':  'application/json',
      'Cache-Control': 'no-store',
      ...corsHeaders(request),
    },
  });
  return addSecurityHeaders(resp);
}

function handleOptions(request) {
  if (!isAllowedOrigin(request)) {
    return new Response(null, { status: 403 });
  }
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

async function getToken(env, platformodeBase = PLATFORMODE_DEFAULT_BASE) {
  const cached = await env.PAYMENT_KV.get(TOKEN_KV_KEY, { type: 'text' });
  if (cached) return cached;

  const resp = await fetch(`${platformodeBase}/api/token`, {
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
    const processed = String(hashKey || '').replace(/__/g, '/');
    const parts = processed.split(':');
    if (parts.length !== 3) return null;

    const [ivHex, saltHex, encBase64] = parts;

    const secretSha1 = await sha1(appSecret);
    const keyHex = await sha256(secretSha1 + saltHex);

    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(keyHex.slice(0, 32)),
      { name: 'AES-CBC' }, false, ['decrypt']
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: new TextEncoder().encode(ivHex.slice(0, 16)) },
      key,
      base64ToBytes(encBase64)
    );

    const text = new TextDecoder().decode(decrypted);
    const decryptedParts = text.split('|');
    const decStatus = decryptedParts[0] || '';
    const decInvoiceId = decryptedParts[2] || '';
    const decOrderId = decryptedParts[3] || decryptedParts[2] || '';

    if (!timingSafeEqual(decStatus, expStatus)) return null;
    if (!timingSafeEqual(decOrderId, String(expOrderId))) return null;
    if (!timingSafeEqual(decInvoiceId, expInvoiceId)) return null;

    return text;
  } catch (e) {
    console.error('[webhook] hash decrypt error:', e.message);
    return null;
  }
}

async function generatePlatformodeHashKey(dataParts, appSecret) {
  const iv = randomHex(16);
  const salt = randomHex(4);
  const password = await sha1(appSecret);
  const saltWithPassword = await sha256(password + salt);

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(saltWithPassword.slice(0, 32)),
    { name: 'AES-CBC' },
    false,
    ['encrypt']
  );

  const plaintext = new TextEncoder().encode(dataParts.join('|'));
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-CBC', iv: new TextEncoder().encode(iv.slice(0, 16)) },
    key,
    plaintext
  );

  const bundle = `${iv}:${salt}:${bytesToBase64(new Uint8Array(encrypted))}`;
  return bundle.replace(/\//g, '__');
}

async function generateCheckStatusHashKey(invoiceId, merchantKey, appSecret) {
  return generatePlatformodeHashKey([String(invoiceId), String(merchantKey)], appSecret);
}

async function generatePaySmart3dHashKey(total, installment, currencyCode, merchantKey, invoiceId, appSecret) {
  return generatePlatformodeHashKey([
    String(Number(total).toFixed(2)),
    String(installment),
    String(currencyCode),
    String(merchantKey),
    String(invoiceId),
  ], appSecret);
}

async function checkPlatformodeOrderStatus(env, invoiceId) {
  try {
    const platformodeBase = getPlatformodeBase(env);
    const token = await getToken(env, platformodeBase);
    const hash_key = await generateCheckStatusHashKey(invoiceId, env.HALKODE_MERCHANT_KEY, env.HALKODE_APP_SECRET);
    const res = await fetch(`${platformodeBase}/api/checkstatus`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        invoice_id: invoiceId,
        merchant_key: env.HALKODE_MERCHANT_KEY,
        hash_key,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}`, raw: data };
    const statusCode = Number(data?.status_code || 0);
    const transactionStatus = String(data?.transaction_status || '');
    if (statusCode === 100 || transactionStatus.toLowerCase() === 'completed') {
      return { ok: true, orderId: data?.order_id || '', raw: data };
    }
    return { ok: false, error: data?.status_description || data?.message || 'order status not completed', raw: data };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
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

function bytesToBase64(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function randomHex(length) {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, length);
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

// ══════════════════════════════════════════════════════════════════════════════
// /api/telegram/webhook
// ══════════════════════════════════════════════════════════════════════════════
async function handleTelegramWebhook(request, env) {
  const headerSecret = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
  if (!env.TELEGRAM_WEBHOOK_SECRET || headerSecret !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response('Forbidden', { status: 403 });
  }

  let update;
  try { update = await request.json(); }
  catch { return new Response('Bad request', { status: 400 }); }

  const msg = update?.message;
  if (!msg?.text) return new Response('OK', { status: 200 });

  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (String(chatId) !== String(env.TELEGRAM_CHAT_ID)) {
    return new Response('OK', { status: 200 });
  }

  let reply;
  try {
    if (text === '/start' || text === '/help') {
      reply = '🤖 *Hydrozid Bot Komutları*\n\n' +
              '/today - Bugünkü işlemler\n' +
              '/last - Son 10 işlem\n' +
              '/find <email> - Email ile ara\n' +
              '/order <invoice_id> - Order detayı\n' +
              '/health - Sistem durumu';
    }
    else if (text === '/today')      reply = await cmdToday(env);
    else if (text === '/last' || text.startsWith('/last ')) {
      const n = parseInt(text.split(' ')[1] || '10', 10);
      reply = await cmdLast(env, Math.min(Math.max(n, 1), 20));
    }
    else if (text.startsWith('/find ')) {
      const email = text.substring(6).trim().toLowerCase();
      reply = await cmdFind(env, email);
    }
    else if (text.startsWith('/order ')) {
      const id = text.substring(7).trim();
      reply = await cmdOrder(env, id);
    }
    else if (text === '/health')     reply = await cmdHealth(env);
    else reply = 'Bilinmeyen komut. /help yazabilirsin.';
  } catch (e) {
    reply = '⚠️ Hata: ' + (e.message || 'bilinmiyor');
  }

  try {
    await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: reply,
        parse_mode: 'Markdown',
      }),
    });
  } catch (e) {
    console.error('[telegram] sendMessage error:', e.message);
  }

  return new Response('OK', { status: 200 });
}

async function cmdToday(env) {
  const list = await env.PAYMENT_KV.list({ prefix: 'order:', limit: 200 });
  const today = new Date().toISOString().split('T')[0];

  let paid = 0, pending = 0, failed = 0, revenue = 0;
  let currency = '';

  for (const k of list.keys) {
    const raw = await env.PAYMENT_KV.get(k.name);
    if (!raw) continue;
    try {
      const o = JSON.parse(raw);
      if (!o.createdAt || !o.createdAt.startsWith(today)) continue;
      if (o.status === 'PAID') { paid++; revenue += Number(o.amount || 0); currency = o.currency || ''; }
      else if (o.status === 'FAILED') failed++;
      else pending++;
    } catch {}
  }

  return '📊 *Bugün (' + today + ')*\n\n' +
         '✅ PAID: ' + paid + '\n' +
         '⏳ PENDING: ' + pending + '\n' +
         '❌ FAILED: ' + failed + '\n\n' +
         '💰 Ciro: ' + revenue.toFixed(2) + ' ' + currency;
}

async function cmdLast(env, n) {
  const list = await env.PAYMENT_KV.list({ prefix: 'order:', limit: 200 });
  const orders = [];

  for (const k of list.keys) {
    const raw = await env.PAYMENT_KV.get(k.name);
    if (!raw) continue;
    try { orders.push(JSON.parse(raw)); } catch {}
  }

  orders.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const top = orders.slice(0, n);

  if (top.length === 0) return 'Hiç order bulunamadı.';

  return '📋 *Son ' + top.length + ' işlem:*\n\n' +
    top.map(o => {
      const icon = o.status === 'PAID' ? '✅' : o.status === 'FAILED' ? '❌' : '⏳';
      const time = (o.createdAt || '').substring(11, 16);
      const day = (o.createdAt || '').substring(5, 10);
      return icon + ' ' + day + ' ' + time + ' | ' + (o.package || '-') + ' | ' + (o.amount || 0) + ' ' + (o.currency || '');
    }).join('\n');
}

async function cmdFind(env, email) {
  const list = await env.PAYMENT_KV.list({ prefix: 'order:', limit: 500 });
  const matches = [];

  for (const k of list.keys) {
    const raw = await env.PAYMENT_KV.get(k.name);
    if (!raw) continue;
    try {
      const o = JSON.parse(raw);
      if ((o.customerEmail || '').toLowerCase().includes(email)) matches.push(o);
    } catch {}
  }

  if (matches.length === 0) return '🔍 ' + email + ' için sonuç yok.';

  matches.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  const top = matches.slice(0, 10);

  return '🔍 *' + email + ' için ' + matches.length + ' sonuç:*\n\n' +
    top.map(o => {
      const icon = o.status === 'PAID' ? '✅' : o.status === 'FAILED' ? '❌' : '⏳';
      const date = (o.createdAt || '').substring(0, 10);
      const idShort = (o.invoiceId || '').substring(0, 8);
      return icon + ' ' + date + ' | ' + (o.amount || 0) + ' ' + (o.currency || '') + ' | ' + idShort;
    }).join('\n');
}

async function cmdOrder(env, invoiceId) {
  const raw = await env.PAYMENT_KV.get('order:' + invoiceId);
  if (!raw) return '❌ Order bulunamadı: ' + invoiceId;

  try {
    const o = JSON.parse(raw);
    let reply = '📦 *Order Detayı*\n\n' +
                'ID: ' + invoiceId.substring(0, 16) + '...\n' +
                'Status: ' + o.status + '\n' +
                'Paket: ' + o.package + '\n' +
                'Tutar: ' + o.amount + ' ' + o.currency + '\n\n' +
                '👤 ' + o.customerName + '\n' +
                '📧 ' + o.customerEmail + '\n' +
                '📱 ' + o.customerPhone + '\n' +
                '📍 ' + o.customerCity + '\n' +
                '🏥 Diploma: ' + o.diploma + '\n\n' +
                '⏰ ' + o.createdAt;
    if (o.paidAt) reply += '\n💚 Ödendi: ' + o.paidAt;
    if (o.failedAt) reply += '\n💔 Başarısız: ' + o.failedAt + '\n   ' + (o.failureReason || '-');
    return reply;
  } catch {
    return '⚠️ Order verisi bozuk.';
  }
}

async function cmdHealth(env) {
  let kvStatus = '❌';
  let tokenStatus = '❌';
  let halkStatus = '❌';

  try {
    await env.PAYMENT_KV.list({ limit: 1 });
    kvStatus = '✅';
  } catch (e) {
    kvStatus = '❌ ' + e.message.substring(0, 30);
  }

  try {
    const cached = await env.PAYMENT_KV.get('token:halkode');
    tokenStatus = cached ? '✅ cached' : '⚠️ yok';
  } catch {}

  try {
    const r = await fetch('https://app.halkode.com.tr/ccpayment/api/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app_id: env.HALKODE_APP_ID, app_secret: env.HALKODE_APP_SECRET }),
    });
    halkStatus = r.ok ? '✅ ' + r.status : '❌ ' + r.status;
  } catch (e) {
    halkStatus = '❌ ' + e.message.substring(0, 30);
  }

  return '🏥 *Sistem Sağlık Durumu*\n\n' +
         'Worker: ✅ (çalışıyor)\n' +
         'KV: ' + kvStatus + '\n' +
         'Token: ' + tokenStatus + '\n' +
         'HalkÖde API: ' + halkStatus + '\n\n' +
         '⏰ ' + new Date().toISOString();
}

// Başarı sayfasında gösterilecek sipariş özeti (müşterinin kendi verisi)
function siparisOzeti(order, orderId) {
  return {
    orderNo: order.orderNo || orderId,
    ad: order.customerName || '',
    email: order.customerEmail || '',
    telefon: order.customerPhone || '',
    sehir: order.customerCity || '',
    ilce: order.customerTown || '',
    adres: order.customerAddress || '',
    diploma: order.diploma || '',
    paket: order.package || '',
    adet: order.quantity || '',
    tutar: order.amount || '',
    paraBirimi: order.currency || 'TRY',
    kargoBarkod: order.kargoBarcode || '',
    kargoDurum: order.kargoBarcode ? 'hazırlanıyor' : (order.kargoError ? 'beklemede' : ''),
    faturaNo: order.faturaNo || '',
    tarih: order.paidAt || order.createdAt || '',
  };
}

function escapeHtmlAttr(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

async function handleBarcodeSvg(request, env) {
  const url = new URL(request.url);
  const code = (url.searchParams.get('code') || '').trim() || 'HYDROZID';
  const svg = buildBarcodeSvg(code);
  return new Response(svg, {
    status: 200,
    headers: {
      'Content-Type': 'image/svg+xml; charset=UTF-8',
      'Cache-Control': 'no-store',
    },
  });
}

async function handleInvoicePdf(request, env) {
  const url = new URL(request.url);
  const invoiceId = (url.searchParams.get('invoice_id') || '').trim();
  const orderId = (url.searchParams.get('order_id') || '').trim();
  if (!env.PAYMENT_KV) return jsonResp(request, { error: 'KV not configured' }, 503);

  let resolvedInvoiceId = invoiceId;
  if (!resolvedInvoiceId && orderId) {
    resolvedInvoiceId = await env.PAYMENT_KV.get(`halkode:${orderId}`, { type: 'text' }) || '';
  }
  if (!resolvedInvoiceId) return new Response('Order not found', { status: 404 });

  const raw = await env.PAYMENT_KV.get(`order:${resolvedInvoiceId}`, { type: 'text' });
  if (!raw) return new Response('Order not found', { status: 404 });

  let order;
  try { order = JSON.parse(raw); }
  catch { return new Response('Invalid order data', { status: 500 }); }

  const pdf = buildInvoicePdf(order, resolvedInvoiceId, {
    kargoFirma: order.kargoFirma || order.kargoHandler || 'KARGO',
  });

  return new Response(pdf, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="hydrozid-fatura-${String(order.orderNo || resolvedInvoiceId).slice(0, 24)}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}

async function handleShippingCostPdf(request, env) {
  const url = new URL(request.url);
  const invoiceId = (url.searchParams.get('invoice_id') || '').trim();
  const orderId = (url.searchParams.get('order_id') || '').trim();
  if (!env.PAYMENT_KV) return jsonResp(request, { error: 'KV not configured' }, 503);

  let resolvedInvoiceId = invoiceId;
  if (!resolvedInvoiceId && orderId) {
    resolvedInvoiceId = await env.PAYMENT_KV.get(`halkode:${orderId}`, { type: 'text' }) || '';
  }
  if (!resolvedInvoiceId) return new Response('Order not found', { status: 404 });

  const raw = await env.PAYMENT_KV.get(`order:${resolvedInvoiceId}`, { type: 'text' });
  if (!raw) return new Response('Order not found', { status: 404 });

  let order;
  try { order = JSON.parse(raw); }
  catch { return new Response('Invalid order data', { status: 500 }); }

  const pdf = buildShippingCostPdf(order, resolvedInvoiceId, {
    kargoFirma: order.kargoFirma || order.kargoHandler || 'KARGO',
    kargoMasraf: order.kargoMasraf || 0,
  });

  return new Response(pdf, {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `inline; filename="hydrozid-kargo-masraf-${String(order.orderNo || resolvedInvoiceId).slice(0, 24)}.pdf"`,
      'Cache-Control': 'no-store',
    },
  });
}

function addSecurityHeaders(response) {
  const newHeaders = new Headers(response.headers);
  newHeaders.set('Strict-Transport-Security', 'max-age=63072000; includeSubDomains; preload');
  newHeaders.set('X-Content-Type-Options', 'nosniff');
  newHeaders.set('X-Frame-Options', 'DENY');
  newHeaders.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  newHeaders.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  newHeaders.set('Content-Security-Policy',
    "default-src 'self'; " +
    "script-src 'self' 'unsafe-inline' https://www.googletagmanager.com https://www.google-analytics.com; " +
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; " +
    "font-src 'self' https://fonts.gstatic.com data:; " +
    "img-src 'self' data: https://img.icons8.com https://www.google-analytics.com https://www.googletagmanager.com; " +
    "connect-src 'self' https://www.tcmb.gov.tr https://api.telegram.org https://api.resend.com https://www.google-analytics.com; " +
    "frame-src https://app.halkode.com.tr https://app.platformode.com.tr; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self' https://app.halkode.com.tr https://app.platformode.com.tr;"
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
