/**
 * GET /api/payment/verify?invoice_id=xxx
 * Verifies payment status with Platformode checkstatus API
 * Returns: { status, order_no, invoice_id }
 */

const PLATFORMODE_BASE = 'https://app.halkode.com.tr/ccpayment';
const TOKEN_KV_KEY = 'token:platformode';

export async function onRequestGet(ctx) {
  const { request, env } = ctx;
  const url = new URL(request.url);
  const invoiceId = url.searchParams.get('invoice_id');
  const hashKey = url.searchParams.get('hash_key');

  if (!invoiceId) {
    return json({ error: 'invoice_id gerekli' }, 400);
  }

  // Get token
  let token;
  try {
    token = await getToken(env);
  } catch (e) {
    return json({ error: 'Token alınamadı' }, 502);
  }

  // Check status
  try {
    const formData = new URLSearchParams();
    formData.append('merchant_key', env.MERCHANT_KEY);
    formData.append('invoice_id', invoiceId);
    if (hashKey) formData.append('hash_key', hashKey);

    const resp = await fetch(`${PLATFORMODE_BASE}/api/checkstatus`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Authorization': `Bearer ${token}`,
      },
      body: formData.toString(),
    });

    const data = await resp.json();
    return json(data);
  } catch (e) {
    return json({ error: 'Doğrulama hatası' }, 502);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function getToken(env) {
  const cached = await env.PAYMENT_KV.get(TOKEN_KV_KEY, { type: 'text' });
  if (cached) return cached;

  const resp = await fetch(`${PLATFORMODE_BASE}/api/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ app_id: env.APP_ID, app_secret: env.APP_SECRET }),
  });

  if (!resp.ok) throw new Error(`Token fetch failed: ${resp.status}`);
  const data = await resp.json();
  const token = data.token || data.access_token || data.data?.token;
  if (!token) throw new Error('No token in response');

  await env.PAYMENT_KV.put(TOKEN_KV_KEY, token, { expirationTtl: 110 * 60 });
  return token;
}
