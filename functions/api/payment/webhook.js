/**
 * POST /api/payment/webhook
 * Platformode (Halkode) ödeme bildirim webhook'u
 * 1. Hash doğrulama (WEBHOOK_SECRET)
 * 2. KV'ye sipariş kaydet
 * 3. Telegram bildirimi gönder
 */

export async function onRequestPost(ctx) {
  const { request, env } = ctx;

  let body;
  try {
    const text = await request.text();
    // Platformode hem JSON hem form-urlencoded gönderebilir
    try {
      body = JSON.parse(text);
    } catch {
      body = Object.fromEntries(new URLSearchParams(text));
    }
  } catch {
    return resp('Bad Request', 400);
  }

  const { invoice_id, status, hash_key, total, currency, merchant_key: bodyMerchantKey } = body;

  if (!invoice_id) return resp('invoice_id gerekli', 400);

  // ─── HASH DOĞRULAMA ──────────────────────────────────────────────
  // Platformode hash = SHA256(invoice_id + env.MERCHANT_KEY + env.WEBHOOK_SECRET)
  const expectedHash = await sha256(invoice_id + env.MERCHANT_KEY + env.WEBHOOK_SECRET);
  if (hash_key && hash_key !== expectedHash) {
    console.error('Webhook hash mismatch', { invoice_id, received: hash_key, expected: expectedHash });
    return resp('Unauthorized', 401);
  }

  // ─── SİPARİŞ DURUMU ──────────────────────────────────────────────
  const isPaid = status === '1' || status === 'True' || status === 'true' || status === 'paid';
  const orderKey = `order:${invoice_id}`;

  // Mevcut sipariş verisini al
  let existingOrder = {};
  try {
    const raw = await env.PAYMENT_KV.get(orderKey, { type: 'text' });
    if (raw) existingOrder = JSON.parse(raw);
  } catch {}

  // Güncelle
  const updatedOrder = {
    ...existingOrder,
    invoice_id,
    status: isPaid ? 'paid' : (status || 'unknown'),
    total: total || existingOrder.total,
    currency: currency || existingOrder.currency,
    webhookReceivedAt: Date.now(),
  };

  await env.PAYMENT_KV.put(orderKey, JSON.stringify(updatedOrder), {
    expirationTtl: 60 * 60 * 24 * 30, // 30 gün
  });

  // ─── TELEGRAM BİLDİRİMİ ──────────────────────────────────────────
  if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
    const emoji = isPaid ? '✅' : '⚠️';
    const statusLabel = isPaid ? 'ÖDEME ALINDI' : `DURUM: ${status}`;
    const msg = [
      `${emoji} *${statusLabel}*`,
      ``,
      `📦 Paket: ${existingOrder.package || updatedOrder.package || 'Bilinmiyor'}`,
      `💰 Tutar: ${total || existingOrder.total || '?'} ${currency || existingOrder.currency || '?'}`,
      `👤 Ad: ${existingOrder.name || '?'}`,
      `📧 E-posta: ${existingOrder.email || '?'}`,
      `📱 Telefon: ${existingOrder.phone || '?'}`,
      `🏙️ Şehir: ${existingOrder.city || '?'}`,
      `🆔 Invoice: \`${invoice_id}\``,
    ].join('\n');

    await sendTelegram(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_CHAT_ID, msg).catch(e =>
      console.error('Telegram error:', e)
    );
  }

  return resp('OK', 200);
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────

function resp(text, status) {
  return new Response(text, { status, headers: { 'Content-Type': 'text/plain' } });
}

async function sha256(message) {
  const msgBuffer = new TextEncoder().encode(message);
  const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sendTelegram(token, chatId, text) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'Markdown',
    }),
  });
}
