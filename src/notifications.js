function getOrderAlertEmails(env) {
  const raw = env.ORDER_ALERT_EMAILS || '';
  const parsed = raw
    .split(/[\s,;]+/)
    .map(s => s.trim())
    .filter(Boolean);
  if (parsed.length) return parsed;
  return ['bilgi@hydrozidtr.com', 'enginkantar@gmail.com', 'medikalbatu@gmail.com'];
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

async function sendZohoEmail(env, { to, subject, html }) {
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

function buildAdminHtml(order, invoiceId, orderId, trDate) {
  return `
<div style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
  <h2>Yeni Sipariş — Hydrozid</h2>
  <table style="font-family:sans-serif;font-size:14px;border-collapse:collapse">
    <tr><td style="padding:6px 12px;color:#666">Müşteri</td><td style="padding:6px 12px"><strong>${order.customerName}</strong></td></tr>
    <tr><td style="padding:6px 12px;color:#666">E-posta</td><td style="padding:6px 12px">${order.customerEmail}</td></tr>
    <tr><td style="padding:6px 12px;color:#666">Telefon</td><td style="padding:6px 12px">${order.customerPhone}</td></tr>
    <tr><td style="padding:6px 12px;color:#666">Şehir</td><td style="padding:6px 12px">${order.customerCity}</td></tr>
    <tr><td style="padding:6px 12px;color:#666">Adres</td><td style="padding:6px 12px">${order.customerAddress}</td></tr>
    <tr><td style="padding:6px 12px;color:#666">Diploma No</td><td style="padding:6px 12px">${order.diploma}</td></tr>
    <tr><td style="padding:6px 12px;color:#666">Paket</td><td style="padding:6px 12px">${order.package} (${order.quantity} adet)</td></tr>
    <tr><td style="padding:6px 12px;color:#666">Tutar</td><td style="padding:6px 12px"><strong>${order.amount} ${order.currency}</strong></td></tr>
    <tr><td style="padding:6px 12px;color:#666">Sipariş No</td><td style="padding:6px 12px">${order.orderNo || orderId}</td></tr>
    <tr><td style="padding:6px 12px;color:#666">Kargo Firması</td><td style="padding:6px 12px">${order.kargoFirma || order.kargoHandler || '—'}</td></tr>
    <tr><td style="padding:6px 12px;color:#666">Kargo Masrafı</td><td style="padding:6px 12px"><strong>${Number(order.kargoMasraf || 0).toLocaleString('tr-TR')} TRY</strong></td></tr>
    <tr><td style="padding:6px 12px;color:#666">Kargo Barkod</td><td style="padding:6px 12px"><strong>${order.kargoBarcode || ('— ' + (order.kargoError || ''))}</strong> ${order.kargoHandler || ''}</td></tr>
    <tr><td style="padding:6px 12px;color:#666">Fatura No</td><td style="padding:6px 12px"><strong>${order.faturaNo || '—'}</strong>${order.faturaLocal ? ' (lokal)' : (order.faturaMock ? ' (mock)' : '')}${order.faturaError ? ' — ' + order.faturaError : ''}</td></tr>
    <tr><td style="padding:6px 12px;color:#666">Tarih</td><td style="padding:6px 12px">${trDate}</td></tr>
  </table>
</div>`;
}

function buildCustomerHtml(order, orderId) {
  return `
<div style="font-family:'Nunito Sans',sans-serif;background:#070B14;color:#CBD5E1;padding:40px 24px;max-width:560px;margin:0 auto;border-radius:16px">
  <h1 style="font-family:Rubik,sans-serif;color:#00D4FF;font-size:1.4rem;margin-bottom:8px">Siparişiniz Alındı!</h1>
  <p style="color:#94A3B8;margin-bottom:24px">Sayın <strong style="color:#fff">${order.customerName}</strong>, ödemeniz başarıyla tamamlandı.</p>
  <table style="font-size:14px;border-collapse:collapse;width:100%">
    <tr><td style="padding:8px 0;color:#64748B;width:140px">Sipariş No</td><td style="padding:8px 0;color:#fff;font-weight:700">${order.orderNo || orderId}</td></tr>
    <tr><td style="padding:8px 0;color:#64748B">Ürün</td><td style="padding:8px 0;color:#fff">Hydrozid® ${order.package} — ${order.quantity} adet</td></tr>
    <tr><td style="padding:8px 0;color:#64748B">Tutar</td><td style="padding:8px 0;color:#22C55E;font-weight:700">${order.amount} ${order.currency}</td></tr>
    <tr><td style="padding:8px 0;color:#64748B">Teslimat Adresi</td><td style="padding:8px 0;color:#CBD5E1">${order.customerCity} — ${order.customerAddress}</td></tr>
    <tr><td style="padding:8px 0;color:#64748B">Kargo Firması</td><td style="padding:8px 0;color:#CBD5E1">${order.kargoFirma || order.kargoHandler || '—'}</td></tr>
    <tr><td style="padding:8px 0;color:#64748B">Kargo Barkod</td><td style="padding:8px 0;color:#CBD5E1">${order.kargoBarcode || '—'}</td></tr>
    <tr><td style="padding:8px 0;color:#64748B">Fatura No</td><td style="padding:8px 0;color:#CBD5E1">${order.faturaNo || '—'}${order.faturaLocal ? ' (lokal)' : (order.faturaMock ? ' (mock)' : '')}</td></tr>
  </table>
</div>`;
}

export async function sendOrderNotifications(env, order, invoiceId, orderId, source) {
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
🧾 Fatura: ${order.faturaNo || '-'}${order.faturaLocal ? ' (lokal)' : (order.faturaMock ? ' (mock)' : '')}${order.faturaError ? ' HATA: ' + order.faturaError : ''}
⏰ ${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}`;

  await sendTelegram(env, telegramText);

  if (env.RESEND_API_KEY || (env.ZOHO_REFRESH_TOKEN && env.ZOHO_CLIENT_ID && env.ZOHO_CLIENT_SECRET)) {
    const trDate = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
    const adminHtml = buildAdminHtml(order, invoiceId, orderId, trDate);
    const recipientSet = new Set(getOrderAlertEmails(env));
    if (env.FATURA_KOPYA_EMAIL) recipientSet.add(env.FATURA_KOPYA_EMAIL);
    recipientSet.add('enginkantar@gmail.com');

    const emailJobs = Array.from(recipientSet).map(to => sendEmail(env, {
      to,
      subject: `[Hydrozid] Yeni Sipariş — ${order.customerName} / ${order.package}`,
      html: adminHtml,
    }));

    emailJobs.push(sendEmail(env, {
      to: order.customerEmail,
      subject: 'Hydrozid® Siparişiniz Alındı',
      html: buildCustomerHtml(order, orderId),
      replyTo: env.RESEND_FROM_EMAIL || 'bilgi@hydrozidtr.com',
    }));

    const results = await Promise.allSettled(emailJobs);
    const failures = results.filter(r => r.status === 'rejected' || r.value === false).length;
    if (failures) console.warn(`[notify:${source}] mail failures:`, failures);
  }
}

export { sendTelegram };
