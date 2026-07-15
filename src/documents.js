function asciiSafe(value) {
  return String(value ?? '')
    .replace(/&/g, ' ve ')
    .replace(/[şŞ]/g, 's')
    .replace(/[ğĞ]/g, 'g')
    .replace(/[ıİ]/g, 'i')
    .replace(/[öÖ]/g, 'o')
    .replace(/[üÜ]/g, 'u')
    .replace(/[çÇ]/g, 'c')
    .replace(/[^A-Za-z0-9À-ÿ \-_.:,/()+'%]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function escapePdfText(text) {
  return asciiSafe(text)
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function buildBarcodePattern(code) {
  const seed = Array.from(String(code || 'HYDROZID')).reduce((acc, ch) => ((acc * 31) + ch.charCodeAt(0)) >>> 0, 7);
  let state = seed || 7;
  const bits = [];
  for (let i = 0; i < 90; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    bits.push((state >>> 30) & 1);
  }
  return bits;
}

export function buildBarcodeSvg(code, opts = {}) {
  const text = asciiSafe(code || 'HYDROZID');
  const width = Number(opts.width || 760);
  const height = Number(opts.height || 190);
  const bits = buildBarcodePattern(text);
  const barWidth = 4;
  const gap = 2;
  const barsWidth = bits.length * (barWidth + gap);
  const startX = Math.max(18, Math.floor((width - barsWidth) / 2));
  const top = 28;
  const bottom = 112;

  let bars = '';
  for (let i = 0; i < bits.length; i++) {
    if (!bits[i]) continue;
    const x = startX + i * (barWidth + gap);
    const h = bottom - (i % 4) * 6;
    bars += `<rect x="${x}" y="${top}" width="${barWidth}" height="${h}" rx="1" fill="#0F172A"/>`;
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Kargo barkodu ${text}">
  <rect width="100%" height="100%" rx="18" fill="#ffffff"/>
  <rect x="16" y="16" width="${width - 32}" height="${height - 32}" rx="14" fill="#F8FAFC" stroke="#CBD5E1"/>
  <text x="${width / 2}" y="22" text-anchor="middle" font-family="Arial, sans-serif" font-size="12" fill="#64748B">KARGO BARKODU</text>
  ${bars}
  <line x1="28" y1="${bottom + 8}" x2="${width - 28}" y2="${bottom + 8}" stroke="#CBD5E1" stroke-width="1"/>
  <text x="${width / 2}" y="${bottom + 34}" text-anchor="middle" font-family="Arial, sans-serif" font-size="16" font-weight="700" fill="#0F172A">${text}</text>
  <text x="${width / 2}" y="${bottom + 56}" text-anchor="middle" font-family="Arial, sans-serif" font-size="11" fill="#64748B">Hydrozid kargo takip kodu</text>
</svg>`;
}

function pdfLine(lines, x, y, size = 11) {
  return `BT /F1 ${size} Tf ${x} ${y} Td (${escapePdfText(lines)}) Tj ET\n`;
}

function pdfLines(lines, x, y, size = 11, leading = 15) {
  const safe = Array.isArray(lines) ? lines : [lines];
  let out = `BT /F1 ${size} Tf ${x} ${y} Td\n`;
  for (let i = 0; i < safe.length; i++) {
    out += `(${escapePdfText(safe[i])}) Tj\n`;
    if (i < safe.length - 1) out += `0 -${leading} Td\n`;
  }
  out += 'ET\n';
  return out;
}

function drawBarcodeCommands(code, x, y, w, h) {
  const bits = buildBarcodePattern(code);
  const barWidth = 2.5;
  const gap = 1.2;
  let out = '';
  for (let i = 0; i < bits.length; i++) {
    if (!bits[i]) continue;
    const bx = x + i * (barWidth + gap);
    const bh = h - ((i % 5) * 2);
    out += `${bx.toFixed(2)} ${y.toFixed(2)} ${barWidth.toFixed(2)} ${bh.toFixed(2)} re f\n`;
  }
  return out;
}

function addTextRow(lines, left, right, y) {
  return lines + `BT /F1 10 Tf ${left} ${y} Td (${escapePdfText(right)}) Tj ET\n`;
}

export function buildInvoicePdf(order, invoiceId, meta = {}) {
  const w = 595.28; // A4
  const h = 841.89;
  const left = 44;
  const right = 551;
  const top = 792;
  const code = order.kargoBarcode || order.orderNo || invoiceId || 'HYDROZID';
  const today = new Date().toLocaleDateString('tr-TR');
  const kargoFirma = asciiSafe(order.kargoHandler || meta.kargoFirma || 'KARGONOMI');
  const status = order.kargoBarcode ? 'Hazirlanıyor' : (order.kargoError ? 'Beklemede' : 'Olusuyor');
  const amount = Number(order.amount || 0).toLocaleString('tr-TR');

  let body = '';
  body += '0 0 0 rg\n';
  body += `BT /F1 18 Tf ${left} ${top} Td (${escapePdfText('HYDROZID FATURA OZETI')}) Tj ET\n`;
  body += pdfLines([
    `Siparis No: ${order.orderNo || invoiceId || '-'}`,
    `Fatura No: ${order.faturaNo || '-'}`,
    `Tarih: ${today}`,
  ], left, top - 26, 11, 14);

  body += `0.90 0.94 0.98 rg ${left} ${top - 78} 507 48 re f\n`;
  body += '0 0 0 rg\n';
  body += pdfLines([
    `Ad Soyad: ${order.customerName || '-'}`,
    `E-posta: ${order.customerEmail || '-'}`,
    `Telefon: ${order.customerPhone || '-'}`,
  ], left + 10, top - 95, 10, 13);

  body += `0.94 0.96 0.99 rg ${left} ${top - 150} 507 56 re f\n`;
  body += '0 0 0 rg\n';
  body += pdfLines([
    `Adres: ${order.customerAddress || '-'}`,
    `Sehir / Ilce: ${[order.customerCity, order.customerTown].filter(Boolean).join(' / ') || '-'}`,
    `Urun: Hydrozid ${order.package || '-'}`,
    `Adet: ${order.quantity || 1}   Tutar: ${amount} ${order.currency || 'TRY'}`,
  ], left + 10, top - 168, 10, 12);

  body += `0.94 0.98 0.96 rg ${left} ${top - 228} 507 60 re f\n`;
  body += '0 0 0 rg\n';
  body += pdfLines([
    `Kargo Firmasi: ${kargoFirma}`,
    `Kargo Durumu: ${status}`,
    `Kargo Takip: ${order.kargoBarcode || '-'}`,
    `Kargo Notu: ${order.kargoError || 'Cikista takip kodu olusunca aktif olur'}`,
  ], left + 10, top - 247, 10, 12);

  body += `0.10 0.13 0.22 rg ${left} ${top - 335} 507 108 re S\n`;
  body += '0 0 0 rg\n';
  body += pdfLines([
    'Batu Medikal / Hydrozid Turkiye',
    'MERSIS: 4016506204800017',
    'WhatsApp: +90 553 475 9032',
    'E-posta: bilgi@hydrozidtr.com',
  ], left + 12, top - 350, 10, 12);
  body += `BT /F1 9 Tf ${left + 12} ${top - 405} Td (Kargo / fatura PDF otomatik olusturuldu.) Tj ET\n`;

  body += `0.96 0.97 0.99 rg ${left} 165 507 130 re f\n`;
  body += '0 0 0 rg\n';
  body += `0 0 0 rg\n0.7 w\n`;
  body += `BT /F1 10 Tf ${left + 16} 276 Td (KARGO BARKODU) Tj ET\n`;
  body += drawBarcodeCommands(code, left + 16, 188, 460, 64);
  body += `BT /F1 12 Tf ${left + 16} 176 Td (${escapePdfText(code)}) Tj ET\n`;

  const objects = [];
  const add = (str) => { objects.push(str); return objects.length; };
  const fontNum = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const contentStream = `<< /Length ${body.length} >>\nstream\n${body}endstream`;
  const contentNum = add(contentStream);
  const pageNum = add(`<< /Type /Page /Parent 4 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`);
  const pagesNum = add(`<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>`);
  const catalogNum = add(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets[i + 1] = pdf.length;
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;

  return new TextEncoder().encode(pdf);
}

export function buildShippingCostPdf(order, invoiceId, meta = {}) {
  const w = 595.28;
  const h = 841.89;
  const left = 44;
  const top = 792;
  const cost = Number(order.kargoMasraf || meta.kargoMasraf || 0);
  const kargoFirma = asciiSafe(order.kargoFirma || order.kargoHandler || meta.kargoFirma || 'KARGO');
  const code = order.kargoBarcode || order.orderNo || invoiceId || 'HYDROZID';
  const lines = [
    'HYDROZID KARGO MASRAF OZETI',
    `Siparis No: ${order.orderNo || invoiceId || '-'}`,
    `Fatura No: ${order.faturaNo || '-'}`,
    `Kargo Firmasi: ${kargoFirma}`,
    `Kargo Barkod: ${order.kargoBarcode || '-'}`,
    `Masraf: ${cost.toLocaleString('tr-TR')} TRY`,
    `Musteri: ${order.customerName || '-'}`,
    `Adres: ${asciiSafe([order.customerCity, order.customerTown, order.customerAddress].filter(Boolean).join(' / ')) || '-'}`,
    `Urun: Hydrozid ${order.package || '-'} (${order.quantity || 1} adet)`,
  ];

  let body = '';
  body += `BT /F1 18 Tf ${left} ${top} Td (${escapePdfText(lines[0])}) Tj ET\n`;
  body += pdfLines(lines.slice(1, 4), left, top - 28, 11, 14);
  body += `BT /F1 10 Tf ${left} ${top - 116} Td (${escapePdfText(lines[4])}) Tj ET\n`;
  body += `BT /F1 10 Tf ${left} ${top - 136} Td (${escapePdfText(lines[5])}) Tj ET\n`;
  body += `BT /F1 10 Tf ${left} ${top - 156} Td (${escapePdfText(lines[6])}) Tj ET\n`;
  body += pdfLines([lines[7], lines[8]], left, top - 186, 10, 13);
  body += `0.95 0.97 0.99 rg ${left} 180 507 110 re f\n`;
  body += '0 0 0 rg\n';
  body += `BT /F1 10 Tf ${left + 12} 270 Td (Kargo takip kodu) Tj ET\n`;
  body += drawBarcodeCommands(code, left + 16, 200, 460, 56);
  body += `BT /F1 11 Tf ${left + 16} 188 Td (${escapePdfText(code)}) Tj ET\n`;

  const objects = [];
  const add = (str) => { objects.push(str); return objects.length; };
  const fontNum = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const contentStream = `<< /Length ${body.length} >>\nstream\n${body}endstream`;
  const contentNum = add(contentStream);
  const pageNum = add(`<< /Type /Page /Parent 4 0 R /MediaBox [0 0 ${w} ${h}] /Resources << /Font << /F1 ${fontNum} 0 R >> >> /Contents ${contentNum} 0 R >>`);
  const pagesNum = add(`<< /Type /Pages /Kids [${pageNum} 0 R] /Count 1 >>`);
  const catalogNum = add(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`);

  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  for (let i = 0; i < objects.length; i++) {
    offsets[i + 1] = pdf.length;
    pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
  }
  const xrefStart = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF`;
  return new TextEncoder().encode(pdf);
}
