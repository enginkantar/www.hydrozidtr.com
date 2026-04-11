# Design System — hydrozidtr.com (Hydrozid Kriyocerrahi)

*Oluşturulma: 2026-04-06*
*Referans şablon: tasarim-b.html*

---

## Ürün Bağlamı

- **Ne:** Hydrozid® FDA onaylı norfluran (HFA 134a) kriyocerrahi cihazı
- **Kime:** Dermatologlar, pratisyen hekimler, jinekologlar, podiyatristler
- **Segment:** B2B medikal cihaz, 149 EUR / 4 paket katmanı, WhatsApp + email dönüşüm
- **Domain:** hydrozidtr.com (hydrozid.com.tr — büyük olursa alınacak)
- **Distribütör:** dev-med.com üzerinden, Çorum bayisi

---

## Estetik Yön

- **Yön:** Dark Cryo Premium
- **Dekorasyon:** Intentional — neon sweep animasyonlar, buz mavisi glow efektler, shimmer
- **Ruh hali:** "Klinik kesinlik. Soğuk güven." Lazer odaklı B2B, premium teknoloji hissi.
- **Referans:** Cybersecurity ürün siteleri (dark + neon accent) × medikal kesinlik

**Kategori normundan kasıtlı sapmalar:**
1. Medikal kategoride herkes beyaz/açık tema kullanır — biz dark. Doktor ekranında görkemli görünür.
2. Neon cyan accent (#00D4FF) — sıvı nitrojen + buz = doğrudan ürün metaforu, kategoride kimse yapmıyor
3. Animasyonlar bilinçli olarak "tech" hissi veriyor — FDA onaylı ama sıkıcı değil

---

## Tipografi

- **Display/Hero:** `Rubik` (800 weight) — kesin, modern, otoriter
- **Body:** `Nunito Sans` (400/500/600) — okunabilirlik öncelikli, uzun teknik metinler için
- **UI/Etiketler:** Nunito Sans 600
- **Teknik Spec / Fiyat:** Nunito Sans 700 + tabular-nums
- **Yükleme:** Google Fonts CDN
  ```html
  <link href="https://fonts.googleapis.com/css2?family=Rubik:wght@400;500;700;800;900&family=Nunito+Sans:wght@400;500;600;700&display=swap" rel="stylesheet">
  ```

**Not:** Yuwell (oksijenimheryerde.com) ile aynı font stack — iki site arasında operatör tutarlılığı

**Boyut skalası:**
| Rol | Boyut | Weight |
|-----|-------|--------|
| Hero H1 | 3rem / 48px | 800 |
| H2 Section | 2.2rem / 35.2px | 700 |
| H3 | 1.5rem / 24px | 700 |
| Body | 1rem / 16px | 400 |
| Body-lg | 1.125rem / 18px | 400 |
| Label/Tag | 0.8rem / 12.8px | 600 |
| Small / Caption | 0.75rem / 12px | 500 |

---

## Renk Sistemi

**Yaklaşım:** Restrained + Expressive — dark nötr zemin, cyan sadece anlam taşıyan noktalarda

### CSS Custom Properties

```css
:root {
  /* Brand */
  --color-bg-page: #070B14;        /* Ana arka plan — koyu lacivert */
  --color-bg-surface: #0D1628;     /* Kart yüzeyi */
  --color-bg-elevated: #152035;    /* Hover kart, dropdown */
  --color-bg-overlay: rgba(7,11,20,0.85); /* Modal overlay */

  /* Accent — Kriyoterapi Mavisi */
  --color-accent: #00D4FF;         /* Birincil neon cyan */
  --color-accent-mid: #0099CC;     /* İkincil cyan — buton, link */
  --color-accent-glow: rgba(0,212,255,0.15); /* Glow efekti */
  --color-accent-subtle: rgba(0,212,255,0.08);

  /* Text */
  --color-text-primary: #FFFFFF;
  --color-text-secondary: #94A3B8; /* Muted — slate-400 */
  --color-text-muted: #64748B;     /* Caption, placeholder */
  --color-text-accent: #00D4FF;    /* Link, highlight */

  /* Semantic */
  --color-success: #10B981;        /* CE/FDA onay göstergeleri */
  --color-warning: #F59E0B;
  --color-error: #EF4444;
  --color-info: #00D4FF;           /* info = accent — tutarlılık */

  /* Border */
  --color-border: rgba(0,212,255,0.15);
  --color-border-strong: rgba(0,212,255,0.35);
  --color-border-subtle: rgba(255,255,255,0.06);

  /* Shadow / Glow */
  --shadow-sm: 0 1px 3px rgba(0,0,0,0.4);
  --shadow-md: 0 4px 16px rgba(0,0,0,0.5);
  --shadow-lg: 0 8px 32px rgba(0,0,0,0.6);
  --glow-sm: 0 0 8px rgba(0,212,255,0.3);
  --glow-md: 0 0 20px rgba(0,212,255,0.4);
  --glow-lg: 0 0 40px rgba(0,212,255,0.25);
}
```

### Renk Kullanım Kuralları

- **#00D4FF (Cyan):** Sadece birincil CTA, aktif state, icon vurgu, section divider glow
- **#0099CC:** İkincil buton, link rengi
- **Cyan asla:** Büyük arka plan alanı olarak kullanılmaz (glow-only)
- **Beyaz metin:** Tüm ana içerik
- **Slate-400 (#94A3B8):** Yardımcı metin, teknik detay
- **Kartlar:** `#0D1628` zemin + `rgba(0,212,255,0.15)` border

---

## Boşluk Sistemi

**Temel birim:** 8px (B2B — professional density, fazla hava değil)

```css
--space-xs:  4px
--space-sm:  8px
--space-md:  16px
--space-lg:  24px
--space-xl:  32px
--space-2xl: 48px
--space-3xl: 64px
--space-4xl: 96px
```

**Touch targetlar:** Minimum 44×44px (doktor — Apple HIG standard, B2C kadar geniş değil)

---

## Layout

- **Yaklaşım:** Grid-disciplined + Editorial hero
- **Max içerik genişliği:** 1100px
- **Breakpoints:** 375 / 768 / 1024 / 1280
- **Border Radius Skalası:**
  ```
  sm:  4px   (input, badge)
  md:  8px   (buton, kart)
  lg:  12px  (büyük kart)
  xl:  16px  (hero panel)
  full: 999px (pill)
  ```

---

## Animasyon Sistemi

**Yaklaşım:** Intentional — her animasyon ürün semantiğini (soğuk, kesin, teknolojik) taşır

**Easing:**
```css
--ease-out: cubic-bezier(0.16, 1, 0.3, 1);
--ease-in: cubic-bezier(0.4, 0, 1, 1);
--ease-cryo: cubic-bezier(0.25, 0.46, 0.45, 0.94); /* Özel — yavaş başlar, hızlı tamamlar */
```

**Süre:**
```css
--duration-micro: 80ms
--duration-short: 200ms
--duration-medium: 300ms
--duration-long: 500ms
```

**Mevcut animasyonlar (tasarim-b.html'den):**
| İsim | Süre | Amaç |
|------|------|-------|
| `neonSweep` | 2.5s | Buton üzerinde ışık geçişi — CTA dikkat çekici |
| `shimmerSlide` | 3s | Nav logo shimmer — premium his |
| `glitchTop` / `glitchBot` | 0.8s | Trust pill glitch — teknolojik karakter |
| `device-float` | 3s ease-in-out | Ürün görseli yüzme |
| `fadeSlideUp` | 0.5s | Element giriş |

**`prefers-reduced-motion`:**
```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    transition-duration: 0.01ms !important;
  }
}
```

---

## Bileşen Standartları

### Birincil CTA Butonu
```css
background: transparent;
border: 1.5px solid var(--color-accent);
color: var(--color-accent);
padding: 12px 28px;
border-radius: 8px;
font: 600 0.95rem Nunito Sans;
position: relative;
overflow: hidden;
/* neonSweep animasyonu eklenir */

&:hover {
  background: var(--color-accent-subtle);
  box-shadow: var(--glow-sm);
}
```

### Dolgu CTA (Birincil aksiyonlar)
```css
background: var(--color-accent-mid);  /* #0099CC */
color: #FFFFFF;
```

### Kart
```css
background: var(--color-bg-surface);  /* #0D1628 */
border: 1px solid var(--color-border);
border-radius: 12px;
padding: 24px;
transition: border-color 200ms, box-shadow 200ms;

&:hover {
  border-color: var(--color-border-strong);
  box-shadow: var(--glow-sm);
}
```

### Trust/Sertifika Badge
```css
background: rgba(0,212,255,0.08);
border: 1px solid rgba(0,212,255,0.25);
border-radius: 999px;
padding: 4px 12px;
color: var(--color-accent);
font: 600 0.8rem Nunito Sans;
/* glitch animasyonu opsiyonel */
```

---

## Kararlar Günlüğü

| Tarih | Karar | Gerekçe |
|-------|-------|---------|
| 2026-04-06 | Dark tema — korundu | Medikal kategoride herkes açık tema, biz dark. Doktor ekranında görkemli. |
| 2026-04-06 | #00D4FF cyan accent | Sıvı nitrojen + buz = ürün metaforu. Kategori normunu kırar. |
| 2026-04-06 | Rubik + Nunito Sans — korundu | Yuwell (oksijenimheryerde.com) ile aynı font — iki proje arasında operatör tutarlılığı |
| 2026-04-06 | neonSweep buton animasyonu | CTA dikkat çekiciliği + teknolojik karakter. Dekoratif değil, ürün semantiği taşıyor. |
| 2026-04-06 | prefers-reduced-motion desteği eklendi | Erişilebilirlik — WCAG 2.1 AA uyumu |
| 2026-04-06 | Fiyat: 149 EUR, 4 paket | Bireysel / Klinik / Hastane katmanları — concept7 şablonunda 4 tier mevcut |
