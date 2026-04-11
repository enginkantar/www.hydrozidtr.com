# Hydrozid Türkiye — Proje Bağlamı (GStack /learn)

*Oluşturulma: 2026-03-31*

---

## Proje Kimliği

**Site:** www.hydrozid.com.tr
**Ürün:** Hydrozid® FDA onaylı kriyocerrahi cihazı — norfluran (HFA 134a)
**Hedef kitle:** Dermatologlar, pratisyen hekimler, jinekologlar, podiyatristler
**Pazar:** Türkiye distribütörü
**Orijinal:** hydrozid.com (Avrupa)

---

## Teknoloji Stack

- **Mimari:** Tek sayfa statik HTML (tasarim-b.html)
- **CSS:** Vanilla CSS (custom design system, dark premium theme)
- **JS:** Vanilla JS + YouTube IFrame API
- **Hosting:** [belirlenecek — Cloudflare Pages veya Netlify önerilir]
- **Assets:** /assets/ klasöründe (product image, indication images, logo)

**ANA DOSYA:** `tasarim-b.html` — tüm site bu tek dosya

---

## Tasarım Sistemi

**Stil:** Dark Cryo Premium (Tasarım B seçildi)
- Arka plan: `#070B14` (koyu lacivert)
- Aksan: `#00D4FF` (buz mavisi/cyan)
- İkincil: `#0099CC`
- Metin: `#FFFFFF` / `#94A3B8`
- Font: Rubik (heading) + Nunito Sans (body)

**Animasyonlar:**
- neonSweep: Buton üzerinde ışık geçişi
- shimmerSlide: Nav logo shimmer efekti
- glitchTop/glitchBot: Trust pill glitch efekti
- device-float: Ürün görseli yüzme animasyonu
- fadeSlideUp: Sayfa elementleri giriş animasyonu

---

## Ürün Bilgisi

**Endikasyonlar (FDA onaylı):**
- Siğil: Verruca vulgaris, plantaris, plana (Düz Siğil)
- Et beni (Acrochordon)
- Güneş lekesi / Lentigo
- Seboreik keratoz
- Aktinik keratoz (premalign)
- Molluscum contagiosum

**Kontrendikasyon:** Nasır/Kallus — kullanılmaz

**Teknik özellikler:**
- Aktif madde: Norfluran (HFA 134a)
- FDA 510(k) Cleared
- CE Belgeli
- Raf ömrü: 3 yıl
- Uygulama süresi: ~30 saniye
- Sıvı nitrojen gerektirmez

---

## Fiyatlandırma (Türkiye Distribütör)

| Tier | Adet | Fiyat/adet | KDV |
|------|------|-----------|-----|
| Tekli | 1 | 149 EUR | Dahil |
| İkili | 2 | 139 EUR | Dahil |
| Klinik Paketi | 5-10 | 130 EUR | Dahil |
| Kurumsal | 10+ | 125 EUR | Dahil |

**NOT:** Site üzerinde işlem fiyatı yok (kredi kartı maliyeti bilinmiyor).

---

## Dosya Yapısı

```
www.hydrozid.com.tr/
├── tasarim-b.html        — ANA SAYFA (tüm site)
├── tasarim-a.html        — Alternatif tasarım (arşiv)
├── tasarim-c.html        — Alternatif tasarım (arşiv)
├── secim.html            — Tasarım seçim sayfası (arşiv)
├── robots.txt            — AI bot izinleri
├── sitemap.xml           — Search engine sitemap
├── CLAUDE.md             — Bu dosya
├── seo-analiz/
│   └── faz1-rapor.md     — FAZ 1 SEO analiz raporu
└── assets/
    ├── hydrozid-product-nobg.png  — Ürün görseli (bg removed)
    ├── logo-tic-3.png             — ETBİS/Ticaret Bakanlığı logosu
    ├── ind-plantar-sigil.png      — Endikasyon görselleri (x8)
    ├── ind-seboreik-keratoz.png
    ├── ind-molluscum.png
    ├── ind-aktinik-keratoz.png
    ├── ind-et-beni.png
    ├── ind-gunes-lekesi.png
    ├── ind-sigil-vulgaris.png
    └── ind-duz-sigil.png
```

---

## SEO Durumu

**Yapılanlar (tasarim-b.html'de mevcut):**
- Meta title: keyword-rich (siğil/et beni/güneş lekesi)
- Meta description: fiyat anchor + endikasyonlar
- Open Graph + Twitter Card
- JSON-LD: Organization, WebSite, MedicalDevice (4 Offer), HowTo, FAQPage
- robots.txt: AI botlara Allow (GPTBot, ClaudeBot, PerplexityBot, Google-Extended)
- İndikasyon görselleri: yerel assets klasöründe
- sitemap.xml: oluşturuldu

**Eksikler:**
- Ayrı sayfa yok (tek HTML — SEO için subpage'ler eklenebilir)
- Blog yok
- Türkçe medikal içerik yok

---

## İletişim

- Email: info@hydrozid.com.tr
- WhatsApp: +90 553 475 9032

---

## GStack Komut Rehberi (Bu Proje İçin)

```
/review          — tasarim-b.html değişikliklerini incele
/design-review   — dark premium tema tutarlılığı
/qa https://www.hydrozid.com.tr  — production testi
/cso             — güvenlik denetimi
/browse tasarim-b.html           — yerel test
```

---

## Önemli Kurallar

1. **TASARIMI BOZMA** — Dark premium #070B14 + cyan #00D4FF paleti korunacak
2. `tasarim-b.html` tek dosya — tüm CSS/JS inline
3. neonSweep keyframe zaten var — tekrar ekleme
4. ETBİS badge: hero-bottom-row'da, nasır disclaimer ile aynı satırda
5. Badge-pill "FDA Onaylı Kriyocerrahi Teknolojisi" specialty-pills altında olacak
6. Endikasyon görselleri local assets/ klasöründen gelir (hotlink koruması var)
7. Satın Al butonları: neonSweep animasyonlu, koyu bg + cyan border
