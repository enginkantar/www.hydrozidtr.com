// src/fatura.js
// QNB eSolutions (eFinans) — İRSALİYELİ e-FATURA (tek belge: fatura + sevk irsaliyesi).
// SOAP altyapısı (doğrulandı 13 Tem): wsLogin → CSAPSESSIONID cookie → belgeGonderExt.
//
// Endpointler (.dev.vars):
//   userService:      QNB_EFATURA_USER_WS      → wsLogin(userId, password, lang)
//   connectorService: QNB_EFATURA_CONNECTOR_WS → belgeGonderExt(parametreler)
// Test: erpefaturatest1 (gönderici VKN 4016562048) → erpefaturatest2 (alıcı VKN 4016562049)
// ERP kodu: BTU31425 (sabit, gidenBelgeParametreleri.erpKodu)
//
// İKİ MOD:
//   QNB_MOCK=1 → gerçek servise gitmez, sahte fatura no/UUID üretir (local QA).
//   QNB_MOCK=0 → gerçek belgeGonderExt (UBL-TR imzasını QNB server-side ekler).

// ── Yardımcılar ───────────────────────────────────────────────────────────────
function xmlEsc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function b64encode(str) {
  // UTF-8 güvenli base64 (Worker: TextEncoder + btoa)
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// MD5 — Cloudflare Workers Web Crypto MD5 desteklemez; saf JS (UTF-8 bytes → hex).
// QNB belgeHash bu değeri (ham UBL XML'in MD5'i) bekler.
async function md5Hex(str) {
  function toWords(bytes) {
    const w = [];
    for (let i = 0; i < bytes.length; i++) w[i >> 2] = (w[i >> 2] || 0) | (bytes[i] << ((i % 4) * 8));
    return w;
  }
  function add(a, b) { return (a + b) & 0xffffffff; }
  function rol(n, c) { return (n << c) | (n >>> (32 - c)); }
  function cmn(q, a, b, x, s, t) { return add(rol(add(add(a, q), add(x, t)), s), b); }
  function ff(a, b, c, d, x, s, t) { return cmn((b & c) | (~b & d), a, b, x, s, t); }
  function gg(a, b, c, d, x, s, t) { return cmn((b & d) | (c & ~d), a, b, x, s, t); }
  function hh(a, b, c, d, x, s, t) { return cmn(b ^ c ^ d, a, b, x, s, t); }
  function ii(a, b, c, d, x, s, t) { return cmn(c ^ (b | ~d), a, b, x, s, t); }

  const bytes = new TextEncoder().encode(str);
  const len = bytes.length;
  const words = toWords(bytes);
  words[len >> 2] = (words[len >> 2] || 0) | (0x80 << ((len % 4) * 8));
  words[(((len + 8) >> 6) + 1) * 16 - 2] = len * 8;

  let a = 1732584193, b = -271733879, c = -1732584194, d = 271733878;
  for (let i = 0; i < words.length; i += 16) {
    const oa = a, ob = b, oc = c, od = d;
    const x = (j) => words[i + j] || 0;
    a = ff(a, b, c, d, x(0), 7, -680876936); d = ff(d, a, b, c, x(1), 12, -389564586);
    c = ff(c, d, a, b, x(2), 17, 606105819); b = ff(b, c, d, a, x(3), 22, -1044525330);
    a = ff(a, b, c, d, x(4), 7, -176418897); d = ff(d, a, b, c, x(5), 12, 1200080426);
    c = ff(c, d, a, b, x(6), 17, -1473231341); b = ff(b, c, d, a, x(7), 22, -45705983);
    a = ff(a, b, c, d, x(8), 7, 1770035416); d = ff(d, a, b, c, x(9), 12, -1958414417);
    c = ff(c, d, a, b, x(10), 17, -42063); b = ff(b, c, d, a, x(11), 22, -1990404162);
    a = ff(a, b, c, d, x(12), 7, 1804603682); d = ff(d, a, b, c, x(13), 12, -40341101);
    c = ff(c, d, a, b, x(14), 17, -1502002290); b = ff(b, c, d, a, x(15), 22, 1236535329);
    a = gg(a, b, c, d, x(1), 5, -165796510); d = gg(d, a, b, c, x(6), 9, -1069501632);
    c = gg(c, d, a, b, x(11), 14, 643717713); b = gg(b, c, d, a, x(0), 20, -373897302);
    a = gg(a, b, c, d, x(5), 5, -701558691); d = gg(d, a, b, c, x(10), 9, 38016083);
    c = gg(c, d, a, b, x(15), 14, -660478335); b = gg(b, c, d, a, x(4), 20, -405537848);
    a = gg(a, b, c, d, x(9), 5, 568446438); d = gg(d, a, b, c, x(14), 9, -1019803690);
    c = gg(c, d, a, b, x(3), 14, -187363961); b = gg(b, c, d, a, x(8), 20, 1163531501);
    a = gg(a, b, c, d, x(13), 5, -1444681467); d = gg(d, a, b, c, x(2), 9, -51403784);
    c = gg(c, d, a, b, x(7), 14, 1735328473); b = gg(b, c, d, a, x(12), 20, -1926607734);
    a = hh(a, b, c, d, x(5), 4, -378558); d = hh(d, a, b, c, x(8), 11, -2022574463);
    c = hh(c, d, a, b, x(11), 16, 1839030562); b = hh(b, c, d, a, x(14), 23, -35309556);
    a = hh(a, b, c, d, x(1), 4, -1530992060); d = hh(d, a, b, c, x(4), 11, 1272893353);
    c = hh(c, d, a, b, x(7), 16, -155497632); b = hh(b, c, d, a, x(10), 23, -1094730640);
    a = hh(a, b, c, d, x(13), 4, 681279174); d = hh(d, a, b, c, x(0), 11, -358537222);
    c = hh(c, d, a, b, x(3), 16, -722521979); b = hh(b, c, d, a, x(6), 23, 76029189);
    a = hh(a, b, c, d, x(9), 4, -640364487); d = hh(d, a, b, c, x(12), 11, -421815835);
    c = hh(c, d, a, b, x(15), 16, 530742520); b = hh(b, c, d, a, x(2), 23, -995338651);
    a = ii(a, b, c, d, x(0), 6, -198630844); d = ii(d, a, b, c, x(7), 10, 1126891415);
    c = ii(c, d, a, b, x(14), 15, -1416354905); b = ii(b, c, d, a, x(5), 21, -57434055);
    a = ii(a, b, c, d, x(12), 6, 1700485571); d = ii(d, a, b, c, x(3), 10, -1894986606);
    c = ii(c, d, a, b, x(10), 15, -1051523); b = ii(b, c, d, a, x(1), 21, -2054922799);
    a = ii(a, b, c, d, x(8), 6, 1873313359); d = ii(d, a, b, c, x(15), 10, -30611744);
    c = ii(c, d, a, b, x(6), 15, -1560198380); b = ii(b, c, d, a, x(13), 21, 1309151649);
    a = ii(a, b, c, d, x(4), 6, -145523070); d = ii(d, a, b, c, x(11), 10, -1120210379);
    c = ii(c, d, a, b, x(2), 15, 718787259); b = ii(b, c, d, a, x(9), 21, -343485551);
    a = add(a, oa); b = add(b, ob); c = add(c, oc); d = add(d, od);
  }
  const hex = (n) => {
    let s = '';
    for (let i = 0; i < 4; i++) s += ((n >> (i * 8)) & 0xff).toString(16).padStart(2, '0');
    return s;
  };
  return hex(a) + hex(b) + hex(c) + hex(d);
}

function faturaKalemleri(order) {
  const adet = Number(order.quantity) || 1;
  const toplam = Number(order.amount) || 0;       // TRY, KDV DAHİL varsayımı
  const kdvOran = 10;                             // TODO: medikal KDV oranını teyit
  const matrah = +(toplam / (1 + kdvOran / 100)).toFixed(2);
  const kdv = +(toplam - matrah).toFixed(2);
  const birimMatrah = adet > 0 ? +(matrah / adet).toFixed(2) : matrah;
  return {
    adet, kdvOran, matrah, kdv, toplam, birimMatrah,
    ad: `Hydrozid Kriyoterapi Cihazi (${order.package || '-'})`,
  };
}

// UBL-TR 1.2 — İrsaliye yerine geçen (irsaliyeli) SATIS e-Faturası
function ublFaturaXml(env, order, faturaNo, uuid) {
  const k = faturaKalemleri(order);
  const now = new Date();
  const tarih = now.toISOString().slice(0, 10);
  const saat = now.toISOString().slice(11, 19);
  const gonderenVkn = env.QNB_GONDERICI_VKN || '4016562048';
  const aliciVkn = env.QNB_ALICI_VKN || '4016562049';
  const unvan = env.SATICI_UNVAN || 'Batu Medikal';
  const vd = env.SATICI_VERGI_DAIRESI || 'Corum';

  // Not: bireysel/test alıcı için TCKN yerine test VKN (4016562049) kullanılıyor.
  return `<?xml version="1.0" encoding="UTF-8"?>
<Invoice xmlns="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2" xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2" xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:UBLVersionID>2.1</cbc:UBLVersionID>
  <cbc:CustomizationID>TR1.2</cbc:CustomizationID>
  <cbc:ProfileID>TICARIFATURA</cbc:ProfileID>
  <cbc:ID>${xmlEsc(faturaNo)}</cbc:ID>
  <cbc:UUID>${xmlEsc(uuid)}</cbc:UUID>
  <cbc:IssueDate>${tarih}</cbc:IssueDate>
  <cbc:IssueTime>${saat}</cbc:IssueTime>
  <cbc:InvoiceTypeCode>SATIS</cbc:InvoiceTypeCode>
  <cbc:Note>Irsaliye yerine gecer. Siparis No: ${xmlEsc(order.orderNo || order.invoiceId || '')}</cbc:Note>
  <cbc:Note>Odeme Hydrozid web sitesi uzerinden alinmistir.</cbc:Note>
  <cbc:DocumentCurrencyCode>${xmlEsc(order.currency || 'TRY')}</cbc:DocumentCurrencyCode>
  <cbc:LineCountNumeric>1</cbc:LineCountNumeric>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cac:PartyIdentification><cbc:ID schemeID="VKN">${xmlEsc(gonderenVkn)}</cbc:ID></cac:PartyIdentification>
      <cac:PartyName><cbc:Name>${xmlEsc(unvan)}</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>${xmlEsc(env.SATICI_ADRES || 'Merkez')}</cbc:StreetName>
        <cbc:BuildingNumber>${xmlEsc(env.SATICI_BINA_NO || '')}</cbc:BuildingNumber>
        <cbc:CitySubdivisionName>${xmlEsc(env.SATICI_ILCE || 'Merkez')}</cbc:CitySubdivisionName>
        <cbc:CityName>${xmlEsc(env.SATICI_IL || 'Çorum')}</cbc:CityName>
        <cbc:PostalZone>${xmlEsc(env.SATICI_POSTA_KODU || '')}</cbc:PostalZone>
        <cac:Country><cbc:Name>Türkiye</cbc:Name></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme><cac:TaxScheme><cbc:Name>${xmlEsc(vd)}</cbc:Name></cac:TaxScheme></cac:PartyTaxScheme>
      <cac:PartyLegalEntity><cbc:RegistrationName>${xmlEsc(unvan)}</cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cac:PartyIdentification><cbc:ID schemeID="VKN">${xmlEsc(aliciVkn)}</cbc:ID></cac:PartyIdentification>
      <cac:PartyName><cbc:Name>${xmlEsc(order.customerName || '-')}</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cbc:CityName>${xmlEsc(order.customerCity || '-')}</cbc:CityName>
        <cac:Country><cbc:Name>Turkiye</cbc:Name></cac:Country>
      </cac:PostalAddress>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="${xmlEsc(order.currency || 'TRY')}">${k.kdv.toFixed(2)}</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="${xmlEsc(order.currency || 'TRY')}">${k.matrah.toFixed(2)}</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="${xmlEsc(order.currency || 'TRY')}">${k.kdv.toFixed(2)}</cbc:TaxAmount>
      <cbc:Percent>${k.kdvOran}</cbc:Percent>
      <cac:TaxCategory><cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="${xmlEsc(order.currency || 'TRY')}">${k.matrah.toFixed(2)}</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="${xmlEsc(order.currency || 'TRY')}">${k.matrah.toFixed(2)}</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="${xmlEsc(order.currency || 'TRY')}">${k.toplam.toFixed(2)}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="${xmlEsc(order.currency || 'TRY')}">${k.toplam.toFixed(2)}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>
  <cac:InvoiceLine>
    <cbc:ID>1</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">${k.adet}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="${xmlEsc(order.currency || 'TRY')}">${k.matrah.toFixed(2)}</cbc:LineExtensionAmount>
    <cac:TaxTotal>
      <cbc:TaxAmount currencyID="${xmlEsc(order.currency || 'TRY')}">${k.kdv.toFixed(2)}</cbc:TaxAmount>
      <cac:TaxSubtotal>
        <cbc:TaxableAmount currencyID="${xmlEsc(order.currency || 'TRY')}">${k.matrah.toFixed(2)}</cbc:TaxableAmount>
        <cbc:TaxAmount currencyID="${xmlEsc(order.currency || 'TRY')}">${k.kdv.toFixed(2)}</cbc:TaxAmount>
        <cbc:Percent>${k.kdvOran}</cbc:Percent>
        <cac:TaxCategory><cac:TaxScheme><cbc:Name>KDV</cbc:Name><cbc:TaxTypeCode>0015</cbc:TaxTypeCode></cac:TaxScheme></cac:TaxCategory>
      </cac:TaxSubtotal>
    </cac:TaxTotal>
    <cac:Item><cbc:Name>${xmlEsc(k.ad)}</cbc:Name></cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="${xmlEsc(order.currency || 'TRY')}">${k.birimMatrah.toFixed(2)}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>
</Invoice>`;
}

// ── SOAP çağrıları ─────────────────────────────────────────────────────────────
async function wsLogin(env) {
  const body = `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:ser="http://service.csap.cs.com.tr/"><soapenv:Body><ser:wsLogin><userId>${xmlEsc(env.QNB_WS_KULLANICI)}</userId><password>${xmlEsc(env.QNB_WS_SIFRE)}</password><lang>tr</lang></ser:wsLogin></soapenv:Body></soapenv:Envelope>`;
  const res = await fetch(env.QNB_EFATURA_USER_WS, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '' },
    body,
  });
  const text = await res.text();
  if (res.status >= 400 || text.includes('faultstring')) {
    const f = (text.match(/<faultstring>(.*?)<\/faultstring>/) || [])[1] || `HTTP ${res.status}`;
    throw new Error(`wsLogin: ${f}`);
  }
  // CSAPSESSIONID cookie'sini topla (Worker: getSetCookie varsa onu kullan)
  let cookies = '';
  if (typeof res.headers.getSetCookie === 'function') cookies = res.headers.getSetCookie().join('; ');
  if (!cookies) cookies = res.headers.get('set-cookie') || '';
  const sid = (cookies.match(/CSAPSESSIONID=([^;]+)/) || [])[1];
  if (!sid) throw new Error('wsLogin: CSAPSESSIONID alinamadi');
  return `CSAPSESSIONID=${sid}`;
}

// UBL'i gzip'leyip base64'e çevir (Workers CompressionStream). QNB belgeIcerigi bunu bekler.
async function gzipBase64(str) {
  const cs = new CompressionStream('gzip');
  const writer = cs.writable.getWriter();
  writer.write(new TextEncoder().encode(str));
  writer.close();
  const buf = new Uint8Array(await new Response(cs.readable).arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i++) bin += String.fromCharCode(buf[i]);
  return btoa(bin);
}

async function belgeGonderExt(env, cookie, ublXml, faturaNo) {
  // DÜZELTİLMİŞ reçete (13 Tem): QNB `veri` alanında ham UBL değil, CS XML sarmalı bekler:
  //   <fatura><belgeFormati>UBL</belgeFormati><belgeIcerigi>base64(gzip(UBL))</belgeIcerigi></fatura>
  // (ham UBL gönderince async "unexpected element Invoice, expected <fatura>" hatası veriyordu.)
  const belgeIcerigi = await gzipBase64(ublXml);
  const faturaXml = `<fatura><belgeFormati>UBL</belgeFormati><belgeIcerigi>${belgeIcerigi}</belgeIcerigi></fatura>`;
  const veri = b64encode(faturaXml);
  const belgeHash = await md5Hex(faturaXml);
  const body = `<?xml version="1.0"?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:con="http://service.connector.uut.cs.com.tr/"><soapenv:Body><con:belgeGonderExt><parametreler><belgeTuru>FATURA</belgeTuru><erpKodu>${xmlEsc(env.QNB_ERP_KODU)}</erpKodu><vergiTcKimlikNo>${xmlEsc(env.QNB_GONDERICI_VKN)}</vergiTcKimlikNo><belgeNo>${xmlEsc(faturaNo)}</belgeNo><mimeType>application/xml</mimeType><belgeVersiyon>1.0</belgeVersiyon><belgeHash>${belgeHash}</belgeHash><veri>${veri}</veri></parametreler></con:belgeGonderExt></soapenv:Body></soapenv:Envelope>`;
  const res = await fetch(env.QNB_EFATURA_CONNECTOR_WS, {
    method: 'POST',
    headers: { 'Content-Type': 'text/xml; charset=utf-8', 'SOAPAction': '', 'Cookie': cookie },
    body,
  });
  const text = await res.text();
  console.log(`[fatura] belgeGonderExt → HTTP ${res.status}: ${text.slice(0, 400)}`);
  if (res.status >= 400 || text.includes('faultstring')) {
    const f = (text.match(/<faultstring>(.*?)<\/faultstring>/) || [])[1] || `HTTP ${res.status}`;
    return { ok: false, error: f, raw: text.slice(0, 500) };
  }
  const belgeOid = (text.match(/<belgeOid>(.*?)<\/belgeOid>/) || [])[1] || '';
  return { ok: true, belgeOid, raw: text.slice(0, 400) };
}

// ── Ana giriş ──────────────────────────────────────────────────────────────────
// dönüş: { ok, mock, faturaNo, uuid, ubl?, raw? } | { ok:false, error }
export async function qnbIrsaliyeliFaturaKes(env, order) {
  // ── ARKA UÇ GUARD (çift kontrol): eksik veriyle QNB'ye gitme ──
  const eksik = [];
  if (!order.customerEmail || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(order.customerEmail)) eksik.push('geçerli e-posta');
  if (!(Number(order.amount) > 0)) eksik.push('tutar');
  if (!order.customerName) eksik.push('ad');
  if (eksik.length) {
    const msg = `Fatura kesilmedi — eksik/geçersiz: ${eksik.join(', ')}. (Faturanın müşteriye ulaşması için e-posta zorunlu.)`;
    console.warn('[fatura] GUARD:', msg);
    return { ok: false, error: msg, guard: true };
  }

  const uuid = crypto.randomUUID();
  const yil = new Date().getFullYear();
  const faturaNo = `BTU${yil}${String(Date.now()).slice(-9)}`;

  const gercek = env.QNB_MOCK !== '1'
    && env.QNB_WS_KULLANICI && env.QNB_WS_SIFRE
    && env.QNB_EFATURA_USER_WS && env.QNB_EFATURA_CONNECTOR_WS;

  if (!gercek) {
    console.log(`[fatura] MOCK irsaliyeli fatura → ${faturaNo} (${env.SATICI_UNVAN || 'Batu Medikal'} → ${order.customerName}, ${order.amount} ${order.currency})`);
    return {
      ok: true, mock: true, faturaNo, uuid, ettn: uuid,
      ozet: faturaKalemleri(order),
    };
  }

  try {
    const ubl = ublFaturaXml(env, order, faturaNo, uuid);
    const cookie = await wsLogin(env);
    const sonuc = await belgeGonderExt(env, cookie, ubl, faturaNo);
    if (!sonuc.ok) return { ok: false, error: sonuc.error, faturaNo, uuid, raw: sonuc.raw };
    return { ok: true, mock: false, faturaNo, uuid, ettn: uuid, belgeOid: sonuc.belgeOid, raw: sonuc.raw };
  } catch (e) {
    console.error('[fatura] QNB hata:', e.message);
    return { ok: false, error: e.message, faturaNo, uuid };
  }
}
