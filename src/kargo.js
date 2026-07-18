// src/kargo.js
// Basit Kargo GERÇEK API entegrasyonu (BITMEDENAL/go/internal/kargo/kargo.go portu).
// Doküman: basitkargo.com/api — 7 Tem canlı doğrulanmış akış.
//
//   POST /api/v2/order/barcode  → TEK çağrıda gönderi + firma seçimi + barkod
//     handlerCode: ARAS | MNG | YURTICI | SURAT | PTT | ECONOMIC | FAST | SELF_*
//   Authorization: Bearer <BASITKARGO_TOKEN>
//
// Gönderen (bizim) adres Basit Kargo panel hesabında tanımlı — token o hesabı temsil eder.
// client = ALICI (müşteri). Gönderi çıkınca SMS'i Basit Kargo kendisi atar (panel ayarı).

const BASIT_KARGO_KOK = 'https://basitkargo.com/api/v2';

function kisalt(s, n) {
  const r = Array.from(String(s || ''));
  return r.length <= n ? String(s || '') : r.slice(0, n).join('') + '…';
}

// order: notify-success'teki KV order objesi
// dönüş: { ok, barcode, id, handler, raw } | { ok:false, error, raw }
export async function basitKargoGonderiOlustur(env, order) {
  const token = env.BASITKARGO_TOKEN;
  if (!token) {
    console.warn('[kargo] BASITKARGO_TOKEN yok → elle kargolama modu');
    return { ok: false, error: 'token yok (elle mod)', manual: true };
  }

  const handler = 'YURTICI';

  // Gönderi kodu: sipariş numarası (panelde iz)
  const kod = `HYDROZID-${(order.orderNo || order.invoiceId || '').toString().slice(0, 40)}`;

  // Desi: Hydrozid sprey seti — paket adedine göre kaba tahmin (min 1)
  const desi = Math.max(1, Number(order.quantity) || 1);

  const govde = {
    handlerCode: handler,
    type: 'OUTGOING',
    content: {
      name: kisalt(`Hydrozid ${order.package || ''} (${order.quantity || 1} adet)`, 120),
      code: kod,
      packages: [{ height: 15, width: 20, depth: 10, weight: desi }],
    },
    client: {
      name: order.customerName || '-',
      phone: order.customerPhone || '',
      city: order.customerCity || '',
      town: order.customerTown || order.customerCity || '',
      address: kisalt(order.customerAddress || '', 250),
    },
  };

  let res, data;
  try {
    res = await fetch(`${BASIT_KARGO_KOK}/order/barcode`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(govde),
    });
  } catch (e) {
    console.error('[kargo] fetch hatası:', e.message);
    return { ok: false, error: `bağlantı: ${e.message}` };
  }

  const text = await res.text();
  try { data = JSON.parse(text); } catch { data = { _raw: text }; }

  console.log(`[kargo] ${handler} → HTTP ${res.status}: ${text.slice(0, 400)}`);

  if (res.status >= 400) {
    // Bakiye yetersiz / firma reddi vb. — barkod dönmez, akış kırılmaz
    return {
      ok: false,
      error: `HTTP ${res.status}`,
      detay: data?.message || data?.error || text.slice(0, 200),
      raw: data,
    };
  }

  // Başarılı: barcode ya da (asenkron) id
  const barcode = data?.barcode || data?.data?.barcode || '';
  const id = data?.id || data?.data?.id || '';
  const masraf = Number(
    data?.price ??
    data?.fee ??
    data?.shipping_fee ??
    data?.data?.price ??
    data?.data?.fee ??
    data?.data?.shipping_fee ??
    0
  ) || 0;
  if (barcode) return { ok: true, barcode, id, handler, raw: data, cost: masraf };
  if (id) {
    console.log('[kargo] barkod asenkron — id takip olarak kullanılıyor:', id);
    return { ok: true, barcode: id, id, handler, asyncBarcode: true, raw: data, cost: masraf };
  }

  return { ok: false, error: 'barkod/id dönmedi', raw: data };
}

// ══════════════════════════════════════════════════════════════════════════════
// KARGONOMI ADAPTÖRÜ — ID tabanlı (il/ilçe ID ile, isim eşleştirme riski yok)
//   GET /states           → il listesi (id, name)
//   GET /cities/{stateId} → ilçe listesi (id, name)
//   POST /shipments       → buyer_state_id + buyer_city_id (integer)
// İl/ilçe listeleri KV'de cache'lenir (nadir değişir). Token gelince aktif.
// ══════════════════════════════════════════════════════════════════════════════
const KARGONOMI_KOK = 'https://app.kargonomi.com.tr/api/v1';

function trNorm(s) {
  // İsim eşleştirme: büyük/küçük + Türkçe karakter toleransı
  return String(s || '').toLocaleLowerCase('tr-TR').trim()
    .replace(/i̇/g, 'i').replace(/ı/g, 'i').replace(/ş/g, 's').replace(/ğ/g, 'g')
    .replace(/ü/g, 'u').replace(/ö/g, 'o').replace(/ç/g, 'c');
}

async function kargonomiListe(env, yol, kvKey) {
  if (env.PAYMENT_KV) {
    const cached = await env.PAYMENT_KV.get(kvKey, { type: 'json' });
    if (cached) return cached;
  }
  const headers = { 'Authorization': `Bearer ${env.KARGONOMI_TOKEN}`, 'Accept': 'application/json' };
  if (env.KARGONOMI_APP_KEY) headers['X-App-Key'] = env.KARGONOMI_APP_KEY;
  const res = await fetch(`${KARGONOMI_KOK}${yol}`, { headers });
  const data = await res.json();
  const list = data?.data || data || [];
  if (env.PAYMENT_KV && Array.isArray(list) && list.length) {
    await env.PAYMENT_KV.put(kvKey, JSON.stringify(list), { expirationTtl: 2592000 }); // 30 gün
  }
  return list;
}

function kargonomiHeaders(env) {
  const h = {
    'Authorization': `Bearer ${env.KARGONOMI_TOKEN}`,
    'Content-Type': 'application/json', 'Accept': 'application/json',
  };
  if (env.KARGONOMI_APP_KEY) h['X-App-Key'] = env.KARGONOMI_APP_KEY; // sadece partner firmalar için
  return h;
}

async function kargonomiCagri(env, metod, yol, govde) {
  const res = await fetch(`${KARGONOMI_KOK}${yol}`, {
    method: metod, headers: kargonomiHeaders(env),
    body: govde ? JSON.stringify(govde) : undefined,
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch { data = { _raw: text }; }
  console.log(`[kargo] kargonomi ${metod} ${yol} → HTTP ${res.status}: ${text.slice(0, 300)}`);
  return { status: res.status, data, text };
}

// Doğrulanmış akış (18 Tem, resmi doküman + canlı /states testi):
//   1) POST /shipments  {shipment:{buyer_*, packages:[{content,desi}]}} → taslak, id döner
//   2) GET  /shipment-price-comparison/{id} → sağlayıcı+fiyat listesi
//   3) POST /confirm-shipping-price {shipment_id, shipping_provider_id} → gönderi hazır
//   4) GET  /shipments/{id} → shipping_webservice_tracking_code/barcode (asenkron dolabilir)
async function kargonomiGonderiOlustur(env, order) {
  if (!env.KARGONOMI_TOKEN) {
    console.warn('[kargo] KARGONOMI_TOKEN yok → elle mod');
    return { ok: false, error: 'kargonomi token yok', manual: true };
  }
  try {
    // 1) İl/ilçe adı → ID (KV cache'li listeden)
    const iller = await kargonomiListe(env, '/states', 'kargonomi:states');
    const il = iller.find(s => trNorm(s.name) === trNorm(order.customerCity));
    if (!il) return { ok: false, error: `il eşleşmedi: ${order.customerCity}` };
    const ilceler = await kargonomiListe(env, `/cities/${il.id}`, `kargonomi:cities:${il.id}`);
    const ilce = ilceler.find(c => trNorm(c.name) === trNorm(order.customerTown));
    if (!ilce) return { ok: false, error: `ilçe eşleşmedi: ${order.customerTown} (${order.customerCity})` };

    // 2) Taslak gönderi
    // Canlı 422 testleriyle doğrulandı (18 Tem): sender_* alanları zorunlu,
    // telefonlar başındaki 0'sız 10 hane, sender_tax_number checksum'lı gerçek VKN/TCKN olmalı.
    const tel10 = (t) => String(t || '').replace(/\D/g, '').replace(/^0/, '');
    const olustur = await kargonomiCagri(env, 'POST', '/shipments', {
      shipment: {
        sender_name: env.KARGO_GONDERICI_UNVAN || 'Engin Kantar Batu Ticaret',
        sender_tax_number: env.KARGO_GONDERICI_VKN,
        sender_phone: tel10(env.KARGO_GONDERICI_TEL),
        sender_address: env.KARGO_GONDERICI_ADRES,
        sender_state_id: Number(env.KARGO_GONDERICI_STATE_ID),
        sender_city_id: Number(env.KARGO_GONDERICI_CITY_ID),
        buyer_name: order.customerName,
        buyer_email: order.customerEmail || undefined,
        buyer_phone: tel10(order.customerPhone),
        buyer_address: order.customerAddress,
        buyer_state_id: il.id,
        buyer_city_id: ilce.id,
        packages: [{
          content: kisalt(`Hydrozid ${order.package || ''} - ${order.orderNo || order.invoiceId || ''}`, 100),
          desi: Math.max(1, Number(order.quantity) || 1),
        }],
      },
    });
    if (olustur.status >= 400) return { ok: false, error: `HTTP ${olustur.status}`, detay: olustur.data?.message || olustur.text.slice(0, 200) };
    const gonderiId = olustur.data?.data?.id ?? olustur.data?.id;
    if (!gonderiId) return { ok: false, error: 'gönderi id dönmedi', raw: olustur.data };

    // 3) Fiyat karşılaştır → sağlayıcı seç (env pin varsa o, yoksa en ucuz)
    const fiyatlar = await kargonomiCagri(env, 'GET', `/shipment-price-comparison/${gonderiId}`);
    const liste = (fiyatlar.data?.shipping_provider_with_price
      || fiyatlar.data?.data?.shipping_provider_with_price || [])
      .map(p => ({ ...p, fiyat: parseFloat(String(p.price)) }))   // "22.67 + KDV" → 22.67
      .filter(p => Number.isFinite(p.fiyat));                      // "Hizmet Dışı Bölge" elenir
    if (!liste.length) return { ok: false, error: 'uygun kargo sağlayıcısı yok', raw: fiyatlar.data };
    const pin = trNorm(env.KARGONOMI_SAGLAYICI || '');
    const secilen = liste.find(p => trNorm(p.slug) === pin) || liste.sort((a, b) => a.fiyat - b.fiyat)[0];

    // 4) Onayla
    const onay = await kargonomiCagri(env, 'POST', '/confirm-shipping-price', {
      shipment_id: gonderiId, shipping_provider_id: secilen.id,
    });
    if (onay.status >= 400) return { ok: false, error: `onay HTTP ${onay.status}`, detay: onay.data?.message || onay.text.slice(0, 200) };

    // 5) Takip kodu (asenkron dolabilir; boşsa gönderi id'si takip referansı olur)
    const detay = await kargonomiCagri(env, 'GET', `/shipments/${gonderiId}`);
    const d = detay.data?.data ?? detay.data ?? {};
    const barcode = d.shipping_webservice_tracking_code || d.shipping_webservice_barcode || '';
    const masraf = Number(d.real_price ?? d.estimated_price ?? secilen.fiyat) || 0;
    const handler = (secilen.name || secilen.slug || 'KARGONOMI').toUpperCase();
    if (barcode) return { ok: true, barcode, id: gonderiId, handler, cost: masraf, raw: d };
    console.log('[kargo] kargonomi takip kodu asenkron — gönderi id takip olarak kullanılıyor:', gonderiId);
    return { ok: true, barcode: `KRG-${gonderiId}`, id: gonderiId, handler, asyncBarcode: true, cost: masraf, raw: d };
  } catch (e) {
    console.error('[kargo] kargonomi hata:', e.message);
    return { ok: false, error: `bağlantı: ${e.message}` };
  }
}

// ── DISPATCHER: carrier-agnostik giriş noktası ──
// env.KARGO_SAGLAYICI: 'kargonomi' (varsayılan) | 'basitkargo'
export async function kargoGonderiOlustur(env, order) {
  // ── ARKA UÇ GUARD (çift kontrol): eksik adresle kargoya gitme ──
  const eksik = [];
  if (!order.customerName) eksik.push('ad');
  if (!order.customerPhone || !/^0[5][0-9]{9}$/.test(order.customerPhone)) eksik.push('geçerli telefon');
  if (!order.customerCity) eksik.push('şehir');
  if (!order.customerTown) eksik.push('ilçe');
  if (!order.customerAddress || order.customerAddress.trim().length < 10) eksik.push('adres (min 10 karakter)');
  if (eksik.length) {
    const msg = `Kargo oluşturulmadı — eksik alıcı bilgisi: ${eksik.join(', ')}.`;
    console.warn('[kargo] GUARD:', msg);
    return { ok: false, error: msg, guard: true };
  }
  if (env.KARGO_MOCK === '1') {
    return { ok: true, barcode: `TEST-YURTICI-${crypto.randomUUID().slice(0, 8).toUpperCase()}`, handler: 'YURTICI', mock: true };
  }
  const saglayici = (env.KARGO_SAGLAYICI || 'kargonomi').toLowerCase();
  if (saglayici === 'kargonomi') return kargonomiGonderiOlustur(env, order);
  return basitKargoGonderiOlustur(env, order);
}
