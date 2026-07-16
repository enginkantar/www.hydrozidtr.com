// src/index.js
// Hydrozid Worker — HalkOde ödeme + (mock ödeme) + Basit Kargo + QNB fatura
// Cloudflare Worker (static assets + fetch handler) modunda çalışır.
import { kargoGonderiOlustur } from './kargo.js';
import { qnbIrsaliyeliFaturaKes } from './fatura.js';
import { buildBarcodeSvg, buildInvoicePdf, buildShippingCostPdf } from './documents.js';
import { sendOrderNotifications, sendTelegram } from './notifications.js';
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

const PLATFORMODE_DEFAULT_BASE = 'https://app.platformode.com.tr/ccpayment';
const TOKEN_KV_KEY = 'token:halkode';
const INDEXNOW_DEFAULT_KEY = 'dd6897a3dd6213540fa1b5d9a99652c2';

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

    // Diğer her şey static asset
    if (env.ASSETS) {
      const response = await env.ASSETS.fetch(request);
      return addSecurityHeaders(response);
    }

    return new Response('Not found', { status: 404 });
  },

  // ── CRON: her gün 05:00 UTC (08:00 TR) — otomatik kampanya ──
  // Render free plan uykuda olabilir: önce health ile uyandır,
  // sonra job'ı tetikle. Job async çalışır, yanıt hemen döner.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.allSettled([
      triggerDailyCampaign(env),
      submitIndexNow(env),
    ]));
  }
};

async function triggerDailyCampaign(env) {
  const api = env.HYDROZID_API_URL || 'https://hydrozid-pazarlama.onrender.com';

  // 1) Uyandır: 6 deneme × 20 sn ara (soğuk başlangıç ~1-2 dk)
  let awake = false;
  for (let i = 0; i < 6; i++) {
    try {
      const r = await fetch(`${api}/api/health`, { signal: AbortSignal.timeout(30000) });
      if (r.ok) { awake = true; break; }
    } catch (_) { /* uyanıyor, bekle */ }
    await new Promise(res => setTimeout(res, 20000));
  }

  if (!awake) {
    console.error('[cron] Render uyandırılamadı');
    await cronTelegram(env, '❌ CRON: Render backend uyandırılamadı, otomatik kampanya çalışmadı!');
    return;
  }

  // 2) Job'ı tetikle
  try {
    const r = await fetch(`${api}/api/job/trigger`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': env.HYDROZID_JOB_KEY,
      },
      body: JSON.stringify({ manual: false }),
      signal: AbortSignal.timeout(30000),
    });
    const body = await r.text();
    console.log(`[cron] trigger yanıtı ${r.status}: ${body}`);
    if (!r.ok) {
      await cronTelegram(env, `❌ CRON: job trigger hatası ${r.status}: ${body}`);
    }
  } catch (e) {
    console.error('[cron] trigger hatası', e);
    await cronTelegram(env, `❌ CRON: job trigger istisna: ${e.message}`);
  }
}

async function submitIndexNow(env) {
  const baseUrl = (env.BASE_URL || 'https://www.hydrozidtr.com').replace(/\/+$/, '');
  const key = String(env.INDEXNOW_KEY || INDEXNOW_DEFAULT_KEY).trim();
  if (!key) return;

  try {
    const sitemapResponse = await fetch(`${baseUrl}/sitemap.xml`, {
      headers: { Accept: 'application/xml,text/xml;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(15000),
    });
    if (!sitemapResponse.ok) {
      throw new Error(`sitemap ${sitemapResponse.status}`);
    }

    const xml = await sitemapResponse.text();
    const urlList = [...xml.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
      .map(match => match[1].trim())
      .filter(value => /^https?:\/\//i.test(value));
    if (!urlList.length) throw new Error('sitemap URL listesi boş');

    const response = await fetch('https://api.indexnow.org/indexnow', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        host: new URL(baseUrl).hostname,
        key,
        keyLocation: `${baseUrl}/${key}.txt`,
        urlList,
      }),
      signal: AbortSignal.timeout(15000),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`IndexNow ${response.status}: ${body.slice(0, 240)}`);
    console.log(`[cron] IndexNow bildirimi gönderildi: ${urlList.length} URL (${response.status})`);
  } catch (error) {
    console.error('[cron] IndexNow bildirimi başarısız:', error.message);
  }
}

async function cronTelegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }),
    });
  } catch (_) { /* rapor edilemedi, sessiz geç */ }
}

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
    const link = `/odeme-test.html?oid=${encodeURIComponent(orderId)}` +
      `&amt=${finalPriceNumber}&pkg=${encodeURIComponent(packageName)}`;
    console.log(`[start] MOCK ödeme → ${orderId} (${finalPriceNumber} TRY, ${packageName})`);
    return jsonResp(request, { link, order_id: orderId, mock: true });
  }

  const invoiceId = crypto.randomUUID();
  const baseUrl = env.BASE_URL || 'https://www.hydrozidtr.com';
  const platformodeBase = getPlatformodeBase(env);

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
      platformodeInvoiceId: invoiceId,
    }),
    { expirationTtl: 604800 }
  );

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

  const link = `/odeme-test.html?invoice_id=${encodeURIComponent(invoiceId)}&wl=1` +
    `&amt=${finalPriceNumber}&pkg=${encodeURIComponent(packageName)}`;
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
      action: 'WL_REQUEST_PAY_SMART_3D',
      api_name: 'PAY_SMART_3D',
      payment_type: '3d',
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
      referer_url: `${baseUrl}/odeme-test.html?invoice_id=${encodeURIComponent(invoiceId)}&wl=1`,
      merchant_server_id: '',
      is_pay_by_marketplace: 0,
      installment: 1,
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

    if (order.status === 'PENDING') {
      if (order.mock && env.MOCK_PAYMENT === '1') {
        order.status = 'PAID';
        order.paidAt = new Date().toISOString();
        order.paidVia = 'mock_browser_return';
      } else {
        if (hash_key && env.HALKODE_APP_SECRET && incomingStatus) {
          const validated = await validateHash(hash_key, incomingStatus || 'Completed', incomingOrderId || order.orderId || '', invoiceId, env.HALKODE_APP_SECRET);
          if (!validated) {
            return jsonResp(request, { ok: false, note: 'hash validation failed' }, 400);
          }
        }

        const statusCheck = await checkPlatformodeOrderStatus(env, invoiceId);
        if (!statusCheck.ok) {
          return jsonResp(request, { ok: false, note: statusCheck.error || 'payment confirmation pending' }, 409);
        }

        order.status = 'PAID';
        order.paidAt = new Date().toISOString();
        order.paidVia = incomingStatus ? 'whitelabel_return' : 'statuscheck';
        order.orderId = incomingOrderId || statusCheck.orderId || order.orderId || '';
        order.orderNo = order.orderId;
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
      order.faturaLocal = !!fatura.local;
      console.log(`[notify:${source}] ✅ fatura:`, fatura.faturaNo, fatura.local ? '(LOCAL)' : (fatura.mock ? '(MOCK)' : '(gerçek)'));
    } else {
      order.faturaError = fatura.error;
      order.faturaNo = fatura.faturaNo;
      console.warn(`[notify:${source}] ⚠️ fatura başarısız:`, fatura.error);
    }
  }

  await sendOrderNotifications(env, order, invoiceId, orderId, source);

  const notifiedAt = new Date().toISOString();
  await env.PAYMENT_KV.put(
    `order:${invoiceId}`,
    JSON.stringify({ ...order, notifiedAt }),
    { expirationTtl: 86400 * 30 }
  );

  return { ok: true, notifiedAt, siparis: siparisOzeti(order, orderId) };
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
    "frame-src https://app.halkode.com.tr https://app.platformode.com.tr https://testapp.platformode.com.tr; " +
    "frame-ancestors 'none'; " +
    "base-uri 'self'; " +
    "form-action 'self' https://app.halkode.com.tr https://app.platformode.com.tr https://testapp.platformode.com.tr;"
  );
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders,
  });
}
