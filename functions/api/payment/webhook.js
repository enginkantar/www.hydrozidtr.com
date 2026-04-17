// POST /api/payment/webhook
// HalkÖde (Platformode) server-to-server webhook
//
// HalkÖde başarılı/başarısız ödemede BROWSER return_url'e yönlendirirken AYRICA
// backend'e form-urlencoded POST atar. Bu webhook kullanıcı bağlantısından
// bağımsız çalışır — cüzdan doğrulama, idempotency, audit için KRITIK.
//
// Webhook payload (form-urlencoded):
//   invoice_id, order_id, status (Completed/Failed), payment_status (1/0),
//   status_description, payment_method, hash_key, transaction_type
//
// hash_key doğrulaması: Platformode Section 11.5 — AES-256-CBC decrypt
//   key = sha256(sha1(app_secret) + salt)
//   hash_key formatı: "iv:salt:base64(encrypted)" ama '/' → '__' değiştirilmiş

export async function onRequestPost(ctx) {
  const { request, env } = ctx;

  try {
    // ─── 1. Parse webhook payload ───────────────────────────────────────────
    const contentType = request.headers.get('content-type') || '';
    let data = {};

    if (contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await request.formData();
      data = Object.fromEntries(formData);
    } else if (contentType.includes('application/json')) {
      data = await request.json();
    } else {
      console.warn('[webhook] unknown content-type:', contentType);
      return errorResp('Invalid content type', 400);
    }

    const { invoice_id, order_id, status, payment_status, status_description,
            payment_method, hash_key, transaction_type } = data;

    console.log('[webhook] received:', { invoice_id, order_id, status, payment_status });

    if (!invoice_id) {
      console.warn('[webhook] missing invoice_id');
      return errorResp('Missing invoice_id', 400);
    }

    // ─── 2. Hash doğrulama (GÜVENLİK KRİTİK) ────────────────────────────────
    if (!env.HALKODE_APP_SECRET) {
      console.error('[webhook] HALKODE_APP_SECRET not configured');
      return errorResp('Not configured', 500);
    }

    if (!hash_key) {
      console.warn('[webhook] missing hash_key for invoice:', invoice_id);
      return ack({ success: false, message: 'Missing hash_key' });
    }

    const decrypted = await validateHash(hash_key, status, order_id, invoice_id, env.HALKODE_APP_SECRET);
    if (!decrypted) {
      console.error('[webhook] ❌ HASH VALIDATION FAILED for invoice:', invoice_id);
      return ack({ success: false, message: 'Hash validation failed' });
    }
    console.log('[webhook] ✅ hash validated for invoice:', invoice_id);

    // ─── 3. Order'ı KV'den al ───────────────────────────────────────────────
    const orderRaw = await env.PAYMENT_KV.get(`order:${invoice_id}`);
    if (!orderRaw) {
      console.warn('[webhook] order not found:', invoice_id);
      return ack({ success: true, note: 'Order not found but acknowledged', invoice_id });
    }

    let order;
    try { order = JSON.parse(orderRaw); }
    catch { return ack({ success: false, message: 'Invalid order data' }); }

    // ─── 4. Idempotency — zaten işlendiyse geç ──────────────────────────────
    if (order.status === 'PAID' || order.status === 'FAILED') {
      console.log('[webhook] already processed:', invoice_id, order.status);
      return ack({ success: true, invoice_id, status: order.status, idempotent: true });
    }

    // ─── 5. Update order ────────────────────────────────────────────────────
    const isSuccess = (payment_status == 1 || status === 'Completed');
    const updatedOrder = isSuccess
      ? {
          ...order,
          status: 'PAID',
          orderNo: order_id,
          paidAt: new Date().toISOString(),
          transactionType: transaction_type || 'Auth',
          paymentMethod: getPaymentMethod(payment_method),
        }
      : {
          ...order,
          status: 'FAILED',
          failedAt: new Date().toISOString(),
          failureReason: status_description,
          transactionType: transaction_type || 'Auth',
        };

    await env.PAYMENT_KV.put(
      `order:${invoice_id}`,
      JSON.stringify(updatedOrder),
      { expirationTtl: isSuccess ? 86400 * 30 : 86400 * 7 }
    );

    // ─── 6. Telegram bildirimi ──────────────────────────────────────────────
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
🔐 Hash: ✅
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
    // HalkÖde retry'ı tetiklemesin diye 200 dön
    return ack({ success: false, error: err.message });
  }
}

// ─── Hash validation helper (Platformode Section 11.5) ───────────────────────
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

function errorResp(msg, status = 400) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
