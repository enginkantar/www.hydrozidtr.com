═══════════════════════════════════════════════════════════════════════════
  🎯 YARIN YAPILACAK — SKILL ÜRET
  "cloudflare-payment-site" skill'i (Engin'in isteği, 17 Nisan gecesi)
═══════════════════════════════════════════════════════════════════════════

ENGİN NE DEDİ:
"claude code bu odeme sistemini ve cli dan girilerek claudflare islerini
vs hepsini kendine bir skill yapsin ben soyleyince o skilli kullansin
hydrozid onun icin bir ornek proje olsun ama currency opsiyonel olsun"

YORUM:
Hydrozid'de bu gece ürettiğimiz pattern (Cloudflare Worker + HalkÖde +
KV + wrangler CLI + secret management + test mode switch + TCMB kuru)
aslında **tekrar kullanılabilir bir template**. Engin bunu Batu Medikal
ve sonraki sitelerde kullanacak. Yani şu anda kafasında olan her şeyi
bir skill'e dönüştürürsek, yeni site kurmak 1 saatten kısa sürer.


───────────────────────────────────────────────────────────────────────────

SKILL ADI:  cloudflare-payment-site
KONUM:      ~/.claude/skills/cloudflare-payment-site/
                veya proje lokal: .gstack/skills/cloudflare-payment-site/

SKILL.md İÇERİĞİ (Claude Code kendine yazacak):

───────────────────────────────────────────────────────────────────────────

name: cloudflare-payment-site

description: |
  Cloudflare Worker + HalkÖde ödeme entegrasyonu kurmak için skill.
  Static HTML site + serverless backend + KV + ödeme provider entegrasyonu.
  Opsiyonel: TCMB döviz kuru dönüşümü (EUR→TRY).
  
  Trigger örnekleri:
    - "Batu Medikal için aynı ödeme altyapısını kur"
    - "Yeni bir satış sitesine HalkÖde ekle"
    - "X sitesine ödeme altyapısı gerekiyor"
    - "cloudflare-payment-site ile kur"

when_to_use:
  - Kullanıcı Cloudflare Workers + HalkÖde + KV pattern ile yeni site kurmak istiyor
  - Mevcut bir static HTML site'a ödeme backend'i eklenecek
  - Hydrozid/Batu Medikal/Hacıyatmaz benzeri bir landing page
  - Tek dosya backend, static asset hibrit

when_not_to_use:
  - Kullanıcı iyzico / başka bir provider istiyorsa
  - Kullanıcı React/Next.js SPA istiyorsa (bu skill static HTML için)
  - Kullanıcı kendi VPS/sunucu kullanıyorsa

───────────────────────────────────────────────────────────────────────────

SKILL İÇERİĞİ:

1. TEMPLATE DOSYALAR:
   - wrangler.toml.template (değişkenleri {{PLACEHOLDER}} olarak)
   - src/index.js.template (modüler, currency opsiyonel)
   - functions/api/payment/webhook.js.template
   - .gitignore (node_modules, .wrangler, .env)
   - README.md (setup instructions)
   - YARIN_YAPILACAKLAR.md placeholder

2. SETUP SCRIPT (scripts/setup.sh):
   - Proje adını sorar
   - Domain sorar
   - HalkÖde credentials sorar (gizli input)
   - Paket fiyatlarını sorar (liste formatında)
   - Currency mode sorar: "TRY only" / "EUR→TRY" / "TRY+USD" / none
   - Telegram isteyip istemediğini sorar
   - Tüm dosyaları oluşturur, placeholder'ları doldurur
   - wrangler.toml'u üretir
   - npx wrangler secret put komutlarını teker teker çalıştırır
   - npx wrangler deploy çalıştırır
   - curl test yapar
   - Başarılıysa git init + ilk commit (opsiyonel)

3. SKILL KOMUTLARI (Claude Code slash commands):
   
   /payment-site-init [project-name] [domain]
     → Yeni proje kurulumu başlatır, setup.sh çalıştırır
   
   /payment-site-deploy
     → npx wrangler deploy + endpoint test
   
   /payment-site-secrets
     → wrangler secret put wizardı (APP_ID, APP_SECRET, MERCHANT_KEY)
   
   /payment-site-test [amount]
     → Test mode aktive et, 1 EUR düşür, deploy, curl test
   
   /payment-site-production
     → Test mode kapat, production fiyatlara dön, deploy
   
   /payment-site-maintenance [on/off]
     → Bakım modu aç/kapat (gece uyurken koruma)
   
   /payment-site-refund [invoice-id]
     → HalkÖde panel linki ver + iade hatırlatma

4. VARYASYONLAR (Engin'in dediği "currency opsiyonel"):
   
   A) TRY-only (Batu Medikal tipi):
      - TCMB fetch yok
      - PACKAGE_PRICES_TRY direkt
      - getEurTryRate fonksiyonu kaldırılır
   
   B) EUR→TRY (Hydrozid tipi):
      - TCMB canlı fetch
      - Currency toggle form'da
      - Server-side dönüşüm
   
   C) USD→TRY (export tipi):
      - TCMB USD rate
      - Aynı pattern
   
   D) Multi-currency (ileri):
      - TCMB'den birden fazla kur
      - User currency selection

───────────────────────────────────────────────────────────────────────────

SKILL'İN BİLECEĞİ "LESSONS LEARNED" (en değerli kısım):

Bu gece öğrendiklerimiz — yeni siteyi kurarken Claude Code otomatik bilecek:

1. HalkÖde invoice formatı gotcha'ları:
   - invoice_description (description DEĞİL)
   - total NUMBER olmalı (string değil)
   - bill_* prefix (billing_* değil)
   - bill_country: "TURKEY" (TR değil)
   - items'da id yok, description ZORUNLU
   - status_code: 100 = success, 12 = invalid format

2. Cloudflare Worker vs Pages ikilemi:
   - wrangler.toml'da pages_build_output_dir varsa Pages mode
   - Yoksa Worker mode
   - functions/ klasörü sadece Pages mode'da çalışır
   - Worker mode'da tek dosya src/index.js + ASSETS binding

3. TCMB regex bug:
   - [\d,]+ YANLIŞ (virgül Türkçe ondalık ama TCMB nokta kullanıyor)
   - [\d.,]+ DOĞRU
   - TCMB 15:30'da günlük tek sefer güncelleniyor

4. Enpara default tarih bug:
   - HalkÖde kart formu default 1/2026 gösteriyor
   - Kullanıcı seçmezse "tarih hatalı" reddi
   - odeme-hatasi.html'de uyarı yazısı olmalı

5. Başarısız ödeme akışı:
   - HalkÖde 404 sayfası kullanıcıyı kaybediyor
   - cancel_url her zaman tetiklenmiyor
   - "Kartınızdan çekim yapılmamıştır" mesajı kritik

6. Test mode pattern:
   - Paket fiyatlarını 1/2/3 EUR yap
   - Dosya başına büyük uyarı comment
   - Git commit YAPMA, sadece wrangler deploy
   - Test bitince git checkout ile geri al
   - BAKIM MODU flag'i uyku saatleri için

7. KV namespace paylaşımı:
   - Aynı ID birden fazla projede kullanılabilir
   - Ama rate limit key'leri project-scoped olmalı (rl:hydrozid:... gibi)
   - Token cache'leri provider-scoped olmalı (token:halkode, token:iyzico)

8. Cloudflare Worker secret'leri:
   - npx wrangler secret put KEY_NAME
   - Stdin'den password input (güvenli)
   - Dashboard UI'da sadece "SET/NOT SET" gözükür, değer görünmez
   - wrangler.toml'a ASLA koyma

9. Production'a deploy checklist:
   - Test mode kapalı mı?
   - Bakım modu kapalı mı?
   - HalkÖde panelde dönüş URL'leri set mi?
   - Sale web hook URL set mi?
   - Telegram secret'leri var mı?
   - Cloudflare logs enabled mı?

───────────────────────────────────────────────────────────────────────────

HYDROZID'İ ÖRNEK PROJE OLARAK LINK ET:

Skill README.md'ye şunu yaz:
  "Reference implementation: /Users/enginjantar/development/HYDROZID-TR/www.hydrozidtr.com"
  
Bu sayede Claude Code yeni site kurarken Hydrozid'i örnek olarak okuyabilir.

───────────────────────────────────────────────────────────────────────────

ENGİN'İN KULLANIM SENARYOSU (yarın veya sonraki gün):

$ cd ~/development
$ mkdir BATU-MEDIKAL-ODEME
$ cd BATU-MEDIKAL-ODEME
$ claude
> cloudflare-payment-site ile Batu Medikal için ödeme altyapısı kur. 
  Currency TRY-only olsun. Ürünler: varis çorabı (varyasyonları
  fiyatlarıyla birlikte).

Claude Code otomatik:
  1. setup.sh çalıştırır
  2. Ürün bilgisi sorar
  3. HalkÖde credentials'ı sorar
  4. wrangler.toml üretir
  5. index.js üretir (TRY-only varyant)
  6. Secret'leri ekler
  7. Deploy eder
  8. Test curl'ü atar
  9. Başarılıysa: "site hazır, form testi yapabilirsin"


═══════════════════════════════════════════════════════════════════════════

SKILL YAZIMI İÇİN YARIN CLAUDE CODE KOMUTU:

claude "cloudflare-payment-site adında yeni bir skill oluştur.

KONUM: ~/.claude/skills/cloudflare-payment-site/

REFERANS: 
- Bu projeyi örnek al: /Users/enginjantar/development/HYDROZID-TR/www.hydrozidtr.com
- Skill brief'i oku: YARIN_SKILL_BRIEF.md (bu dosya)

YAPILACAKLAR:
1. Skill klasörü oluştur
2. SKILL.md yaz (yukarıdaki brief'e göre)
3. templates/ altına wrangler.toml, src/index.js, webhook.js template'lerini yaz
4. scripts/setup.sh yaz (interaktif setup)
5. README.md yaz (Engin için insan okunur dokümantasyon)
6. Lessons learned'i SKILL.md'ye embed et (önemli!)
7. 4 varyasyon pattern'ini destekle: TRY-only, EUR→TRY, USD→TRY, multi-currency
8. Claude Code slash commands ekle: /payment-site-init, /payment-site-deploy, 
   /payment-site-test, /payment-site-production, /payment-site-maintenance

KISITLAR:
- Engin'in API key'lerini ASLA template'lere koyma
- Tüm credential'lar wrangler secret put ile
- Hydrozid'in mevcut dosyalarını DEĞİŞTİRME (sadece referans)
- Git commit YAPMA, push YAPMA

BİTİNCE:
Bana de ki: 'Skill hazır. /payment-site-init ile test edebilirsin.'"

═══════════════════════════════════════════════════════════════════════════
