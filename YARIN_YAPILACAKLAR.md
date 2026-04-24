═══════════════════════════════════════════════════════════════════════════
  🌅 HYDROZID — YARIN SABAH YAPILACAKLAR
  17 Nisan 2026 Cuma · Uyuma saati: 05:15
═══════════════════════════════════════════════════════════════════════════

BUGÜN GECE BAŞARDIKLARIN:
  ✅ HalkÖde API entegrasyonu (dokümantasyon dışı format bulundu)
  ✅ Cloudflare Worker deploy edildi
  ✅ Gerçek kart ile gerçek 53 TL ödeme yapıldı (VP17763915325743328)
  ✅ TCMB EUR/TRY canlı kur (regex bug düzeltildi)
  ✅ Pending orders KV'ye kaydediliyor
  ✅ Hash validation (AES-256-CBC) hazır
  ✅ Rate limit + idempotency + token cache aktif
  ✅ Test mode + bakım modu switch'leri kuruldu


─── ÖNCELİK 1 — SİTEYİ GERİ AÇMA (10 dakika) ───────────────────────────

1. Bakım modunu kapat:
   - src/index.js'te maintenanceMode = false yap
   - VEYA tüm bakım bloğunu sil

2. Test mode'u kapat (production fiyatlar):
   - src/index.js'te 'Temel Paket': 1 → 'Temel Paket': 149 yap
   - TEST MODE header comment'ini sil
   - ⚠️  TEST MODE inline yorumlarını sil

3. Deploy:
   npx wrangler deploy

4. Test (TRY ile gerçek fiyat mı kontrol et):
   curl -sS -X POST https://www.hydrozidtr.com/api/payment/start \
     -H 'Content-Type: application/json' \
     -H 'Origin: https://www.hydrozidtr.com' \
     -d '{"name":"Test","email":"test@test.com","phone":"05551234567","city":"Ankara","address":"Test Mah Test Sok No 1","diploma":"12345","package":"Temel Paket","currency":"TRY"}'
   
   Beklenen: ~7873 TRY (149 EUR × 52.84) — link dönerse OK

5. GIT COMMIT (bakım + test değişikliklerini DEĞİL, sadece production kodu):
   git add src/index.js
   git commit -m "feat: halkode production ready - real payment tested"
   git push origin master


─── ÖNCELİK 2 — DÜNKÜ İADELERİ YAP (5 dakika) ──────────────────────────

HalkÖde paneli → İŞLEMLER → 17 Nisan filtresi:
  - VP17763856149066707 (test-006, 10 TL) → Zaten iade ettin ✅
  - VP17763915325743328 (53 TL, başarılı) → Bunu iade et
  
  İade sebebi: "müşteri fikir değiştirmesi"
  Net kayıp: ~1.6 TL komisyon

Başarısızlar (dc42... ve 7095fb...) zaten çekim olmadı, hiçbir şey yapma.


─── ÖNCELİK 3 — HATA SAYFASI POLISH (30 dakika) ────────────────────────

SEN DEDİN Kİ: "müşteri bunu merak eder çekildi mi karttan ne oldu şüphe?"
Çözüm: odeme-hatasi.html'e dinamik mesaj ekle

1. odeme-hatasi.html'de <script> ekle:
   
   <script>
     const params = new URLSearchParams(window.location.search);
     const orderNo = params.get('order_no');
     const errorCode = params.get('status_code') || params.get('error_code');
     const errorMsg = params.get('error') || params.get('status_description');
     
     // Bilgilendirme mesajı
     const infoEl = document.querySelector('.error-info'); // HTML'de ekle
     if (orderNo) {
       infoEl.innerHTML = `
         <strong>Kartınızdan çekim yapılmamıştır.</strong><br>
         İşlem referansı: ${orderNo}<br>
         ${errorMsg ? 'Hata: ' + errorMsg : ''}
       `;
     }
   </script>

2. "Kartınızdan çekim yapılmamıştır" metnini HTML'e kalın yaz — en önemli mesaj.


─── ÖNCELİK 4 — HALKODE PANEL AYARLARI (10 dakika) ─────────────────────

app.halkode.com.tr → Ayarlar → Entegrasyon & API:
  - Dönüş URL'i:           https://www.hydrozidtr.com/odeme-basarili.html
  - Başarılı Dönüş URL'i:  https://www.hydrozidtr.com/odeme-basarili.html
  - Başarısız Dönüş URL'i: https://www.hydrozidtr.com/odeme-hatasi.html

  Sale Web Hook (varsa ayrı alan):
  - URL: https://www.hydrozidtr.com/api/payment/webhook
  - (bu webhook hash validation için kritik)


─── ÖNCELİK 5 — TELEGRAM BİLDİRİMİ (20 dakika) ─────────────────────────

1. @BotFather ile Telegram bot oluştur (varsa mevcut kullan)
2. Bot token'ı al
3. @userinfobot ile kendi Chat ID'ni al (veya grup için)
4. Secret ekle:
   
   npx wrangler secret put TELEGRAM_BOT_TOKEN
   # yapıştır

5. wrangler.toml'a ekle (secret değil, plain):
   
   [vars]
   BASE_URL = "https://www.hydrozidtr.com"
   TELEGRAM_CHAT_ID = "buraya chat id"

6. Deploy
7. Test: Form'dan 1 EUR (test mode kısa süre) ödeme — Telegram mesajı gelmeli


─── ÖNCELİK 6 — E-POSTA BİLDİRİMİ (45 dakika) ──────────────────────────

SEN DEDİN Kİ: "formu dolduran kişinin yazdığı emaile gerçek invoice id 
yani bankadaki id ile sipariş kodu yapacağız"

Seçenekler:
  A) MailChannels (Cloudflare Workers ücretsiz, dev-friendly)
     https://developers.cloudflare.com/email-routing/email-workers/send-email/
  
  B) Resend.com (3000 free/ay, daha güzel deliverability)
     https://resend.com/docs
  
  C) Brevo/Sendgrid (Türkiye uyumlu, ücretsiz tier)

Öneri: Resend başla (API'si basit, deliverability iyi)

E-posta template içeriği:
  - Müşteri adı
  - Sipariş özet (paket, adet, tutar)
  - HalkÖde Order ID: VP...
  - Hydrozid Invoice ID: crypto.randomUUID()'den
  - Teslimat adresi
  - Destek: info@hydrozidtr.com / WhatsApp link


─── ÖNCELİK 7 — BATU MEDİKAL & HAÇIYATMAZ (1 saat) ─────────────────────

Batu Medikal:
  - src/index.js'i kopyala
  - Fiyatları TL olarak yaz (EUR dönüşüm yok)
  - Ayrı KV namespace oluştur
  - batumedikal.com için ayrı wrangler.toml
  - Same secrets pattern

Hacıyatmaz:
  - Mevcut iyzico başarı webhook'una Telegram bildirimi ekle
  - callback.js'e Telegram notification block kopyala


─── NOT — HALKODE UI SORUNLARI (gelecek hafta) ─────────────────────────

Image 1 ve 2'de gördüklerimiz:
  - HalkÖde 404 "session expired" sayfası acemi, müşteriyi kaybettiriyor
  - Hata modal'ı çıkışı "Geri" butonu ana siteye dönmüyor
  - Ödeme sayfası default tarih "1/2026" — geçmiş tarih, hata yaratıyor

Çözüm:
  - HalkÖde destek hattına yaz (0850 522 5623): "Hata sayfalarında 
    merchant_url parametresi yok, müşteri kaybediliyor"
  - Kendi çözümüm olarak: pending timeout tabanlı email kur
    (KV'de 5 dk+ pending sipariş varsa "tamamlamayı unutmadın mı?" maili)


─── TEKNİK BORÇ NOTU ────────────────────────────────────────────────────

Kodda iyileştirilmesi gereken yerler (yarın değil, bir hafta sonra):
  - checkRateLimit race condition (concurrent istek aynı counter'ı okuyabilir)
  - Token cache refresh: şu an exception durumunda stale token döndürüyor
  - Input validation: city whitelist (81 il), address XSS sanitize
  - Logging: sensitive data (email, telefon) production loglarına yazılıyor
  - KV namespace Hacıyatmaz ile paylaşılıyor (uzun vadede ayrı olmalı)


═══════════════════════════════════════════════════════════════════════════
  İYİ UYKULAR ENGİN — 7 SAATLİK ÇALIŞMA İLE ÖDEME ALAN BİR MEDİKAL SAAS
  SİTEN VAR. YARIN YUKARIDAKİ LİSTEYİ KAHVEYLE AÇ, SIRAYLA BİTİR.
═══════════════════════════════════════════════════════════════════════════
