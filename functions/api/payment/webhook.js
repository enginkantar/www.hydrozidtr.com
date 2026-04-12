/**
 * /api/payment/webhook
 * POST endpoint for HalkÖde payment confirmation
 *
 * SECURITY: Full hash_key validation per Platformode Section 11.5
 * Decrypts AES-256-CBC encrypted hash using app_secret
 *
 * Webhook comes as POST form-urlencoded with these fields:
 * - invoice_id
 * - order_id
 * - status (Completed/Failed)
 * - payment_status (1=success, 0=fail)
 * - status_description
 * - payment_method
 * - hash_key (encrypted: status|order_id|invoice_id|...)
 * - transaction_type
 */

export async function onRequestPost(ctx) {
  const { request, env } = ctx;

  try {
    // ═══════════════════════════════════════════════════════════
    // 1. PARSE WEBHOOK PAYLOAD (form-urlencoded from HalkÖde)
    // ═══════════════════════════════════════════════════════════
    const contentType = request.headers.get('content-type') || '';
    let webhookData = {};

    if (contentType.includes('application/x-www-form-urlencoded')) {
      const formData = await request.formData();
      webhookData = Object.fromEntries(formData);
    } else if (contentType.includes('application/json')) {
      webhookData = await request.json();
    } else {
      console.warn('Unknown content-type:', contentType);
      return errorResponse('Invalid content type', 400);
    }

    const {
      invoice_id,
      order_id,
      status,
      payment_status,
      status_description,
      payment_method,
      hash_key,
      transaction_type
    } = webhookData;

    console.log('Webhook received:', { invoice_id, order_id, status, payment_status });

    // ═══════════════════════════════════════════════════════════
    // 2. VALIDATE REQUIRED FIELDS
    // ═══════════════════════════════════════════════════════════
    if (!invoice_id) {
      console.warn('Webhook missing invoice_id');
      return errorResponse('Missing invoice_id', 400);
    }

    if (!hash_key) {
      console.warn('Webhook missing hash_key for invoice:', invoice_id);
      return errorResponse('Missing hash_key', 400);
    }

    // ═══════════════════════════════════════════════════════════
    // 3. VALIDATE HASH_KEY (CRITICAL SECURITY CHECK)
    // ═══════════════════════════════════════════════════════════
    const decryptedData = await validateAndDecryptHash(
      hash_key,
      status,
      order_id,
      invoice_id,
      env.APP_SECRET || env.MERCHANT_KEY
    );

    if (!decryptedData) {
      console.error('❌ SECURITY ALERT: Hash validation FAILED for invoice:', invoice_id);
      return new Response(JSON.stringify({
        success: false,
        message: 'Hash validation failed'
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    console.log('✅ Hash validation SUCCESS for invoice:', invoice_id);

    // ═══════════════════════════════════════════════════════════
    // 4. GET ORDER FROM KV
    // ═══════════════════════════════════════════════════════════
    const orderData = await env.PAYMENT_KV.get(`order:${invoice_id}`);

    if (!orderData) {
      console.warn('⚠️ Order not found in KV for invoice:', invoice_id);
      return new Response(JSON.stringify({
        success: true,
        note: 'Order not found but webhook acknowledged',
        invoice_id
      }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const order = JSON.parse(orderData);

    // ═══════════════════════════════════════════════════════════
    // 5. UPDATE ORDER STATUS
    // ═══════════════════════════════════════════════════════════
    let updatedOrder = { ...order };
    let isSuccess = false;

    if (payment_status == 1 || status === 'Completed') {
      console.log('✅ Payment SUCCESS - Invoice:', invoice_id);
      updatedOrder = {
        ...order,
        status: 'paid',
        payment_status: 'Completed',
        order_no: order_id,
        paid_at: new Date().toISOString(),
        transaction_type: transaction_type || 'Auth',
        webhook_verified: true,
        webhook_status: status,
        webhook_payment_method: payment_method
      };
      isSuccess = true;

    } else if (payment_status == 0 || status === 'Failed') {
      console.log('❌ Payment FAILED - Invoice:', invoice_id, 'Reason:', status_description);
      updatedOrder = {
        ...order,
        status: 'failed',
        payment_status: 'Failed',
        failed_at: new Date().toISOString(),
        failure_reason: status_description,
        transaction_type: transaction_type || 'Auth',
        webhook_verified: true,
        webhook_status: status
      };
      isSuccess = false;

    } else {
      console.warn('⚠️ Unknown payment status:', status, payment_status);
      updatedOrder.webhook_status = status;
      updatedOrder.webhook_verified = true;
    }

    // ═══════════════════════════════════════════════════════════
    // 6. SAVE TO KV
    // ═══════════════════════════════════════════════════════════
    await env.PAYMENT_KV.put(
      `order:${invoice_id}`,
      JSON.stringify(updatedOrder),
      { expirationTtl: isSuccess ? (86400 * 30) : (86400 * 7) }
    );

    // ═══════════════════════════════════════════════════════════
    // 7. TELEGRAM NOTIFICATION
    // ═══════════════════════════════════════════════════════════
    if (env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_CHAT_ID) {
      const emoji = isSuccess ? '✅' : '❌';
      const statusText = isSuccess ? 'BAŞARILI' : 'BAŞARISIZ';

      const telegramMsg = `
${emoji} ÖDEME ${statusText} (WEBHOOK)

👤 Ad: ${order.name}
📧 Email: ${order.email}
📱 Telefon: ${order.phone}
📍 Şehir: ${order.city}
🏥 Diploma: ${order.diploma}

📦 Paket: ${order.package}
💰 Tutar: ${order.price_final} ${order.currency}
🆔 Invoice: ${invoice_id}
🔗 Order: ${order_id || 'N/A'}

${isSuccess ? '✅ Durum: Tamamlandı' : `❌ Hata: ${status_description}`}
💳 Ödeme Yöntemi: ${getPaymentMethod(payment_method)}
🔑 İşlem Tipi: ${transaction_type || 'Auth'}

🔐 Hash Doğrulandı: ✅
⏰ ${new Date().toLocaleString('tr-TR')}
      `.trim();

      try {
        await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: env.TELEGRAM_CHAT_ID,
            text: telegramMsg,
            parse_mode: 'HTML'
          })
        });
        console.log('✅ Telegram notification sent');
      } catch (e) {
        console.error('⚠️ Telegram error:', e.message);
      }
    }

    // ═══════════════════════════════════════════════════════════
    // 8. ACKNOWLEDGE
    // ═══════════════════════════════════════════════════════════
    return new Response(JSON.stringify({
      success: true,
      invoice_id,
      order_no: order_id,
      status: isSuccess ? 'paid' : 'failed',
      verified: true
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    console.error('❌ Webhook error:', err);
    return new Response(JSON.stringify({
      success: true,
      error: err.message
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}

/**
 * Validate & Decrypt webhook hash_key
 * Per Platformode Documentation Section 11.5
 */
async function validateAndDecryptHash(hashKey, expectedStatus, expectedOrderId, expectedInvoiceId, appSecret) {
  try {
    if (!hashKey || !appSecret) {
      console.error('Missing hashKey or appSecret');
      return null;
    }

    // Step 1: Restore slashes (__ → /)
    const processedHash = hashKey.replace(/__/g, '/');

    // Step 2: Split into [iv:salt:encrypted]
    const components = processedHash.split(':');
    if (components.length !== 3) {
      console.error('Invalid hash format - expected 3 components, got:', components.length);
      return null;
    }

    const [ivHex, saltHex, encryptedBase64] = components;

    // Step 3: Derive key = sha256(sha1(appSecret) + salt)
    const appSecretSha1 = await sha1Hash(appSecret);
    const derivedKeyHex = await sha256Hash(appSecretSha1 + saltHex);

    // Step 4: Import key and decrypt
    const key = await crypto.subtle.importKey(
      'raw',
      hexToBytes(derivedKeyHex),
      { name: 'AES-CBC' },
      false,
      ['decrypt']
    );

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv: hexToBytes(ivHex) },
      key,
      base64ToBytes(encryptedBase64)
    );

    const decryptedText = new TextDecoder().decode(decrypted);
    console.log('Decrypted data:', decryptedText);

    // Step 5: Verify values
    const [decStatus, decOrderId, decInvoiceId] = decryptedText.split('|');

    if (decStatus !== expectedStatus) {
      console.error('Status mismatch:', decStatus, '!==', expectedStatus);
      return null;
    }
    if (decOrderId !== String(expectedOrderId)) {
      console.error('Order ID mismatch:', decOrderId, '!==', expectedOrderId);
      return null;
    }
    if (decInvoiceId !== expectedInvoiceId) {
      console.error('Invoice ID mismatch:', decInvoiceId, '!==', expectedInvoiceId);
      return null;
    }

    console.log('✅ All hash validations passed!');
    return decryptedText;

  } catch (err) {
    console.error('❌ Hash validation error:', err.message);
    return null;
  }
}

async function sha1Hash(input) {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-1', data);
  return bytesToHex(new Uint8Array(hashBuffer));
}

async function sha256Hash(input) {
  const data = new TextEncoder().encode(input);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return bytesToHex(new Uint8Array(hashBuffer));
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substr(i, 2), 16);
  }
  return bytes;
}

function bytesToHex(bytes) {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function base64ToBytes(base64) {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}

function getPaymentMethod(methodId) {
  const methods = { '1': 'Credit Card', '2': 'Mobile', '3': 'Wallet' };
  return methods[methodId] || 'Unknown';
}

function errorResponse(message, status = 400) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}
