/**
 * Standard Code 128 (Subset B) Barcode Utility for PDFKit and Server-Side Rendering
 * ISO/IEC 15417 specification compliant.
 */

const CODE128_PATTERNS = [
  '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
  '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
  '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
  '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
  '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
  '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
  '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
  '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
  '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
  '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
  '114131', '311141', '411131', '211412', '211214', '211232', '2331112'
];

/**
 * Calculates Code 128 (Subset B) modules and bars for a text.
 */
function generateCode128Bars(text, quietZoneModules = 12) {
  const clean = String(text || '').trim();
  const START_B = 104;
  const STOP = 106;

  const codes = [START_B];
  let checksum = START_B;

  for (let i = 0; i < clean.length; i++) {
    const val = clean.charCodeAt(i) - 32;
    const safeVal = val >= 0 && val <= 95 ? val : 0;
    codes.push(safeVal);
    checksum += safeVal * (i + 1);
  }

  codes.push(checksum % 103);
  codes.push(STOP);

  const bars = [];
  let currentX = quietZoneModules;

  for (let sIdx = 0; sIdx < codes.length; sIdx++) {
    const p = CODE128_PATTERNS[codes[sIdx]];
    if (!p) continue;
    for (let j = 0; j < p.length; j++) {
      const w = parseInt(p[j], 10);
      const isBar = j % 2 === 0;
      if (isBar) {
        bars.push({ x: currentX, width: w });
      }
      currentX += w;
    }
  }

  const totalModules = currentX + quietZoneModules;
  return { totalModules, bars };
}

/**
 * Draws a sharp, vector Code 128 barcode directly into a PDFKit document.
 * @param {PDFDocument} doc - Active PDFKit document instance.
 * @param {string} text - The code to encode.
 * @param {number} x - Top left X coordinate.
 * @param {number} y - Top left Y coordinate.
 * @param {number} width - Total container width.
 * @param {number} height - Total container height.
 * @param {object} options - Customization options.
 */
function drawCode128OnPdf(doc, text, x, y, width, height, options = {}) {
  const {
    showText = true,
    textColor = '#0F172A',
    borderColor = '#CBD5E1',
    bgColor = '#FFFFFF',
    quietZoneModules = 6
  } = options;

  const { totalModules, bars } = generateCode128Bars(text, quietZoneModules);
  if (!bars || bars.length === 0) return;

  doc.save();

  // 1. Crisp white background box with soft border
  doc.roundedRect(x, y, width, height, 6)
    .fillColor(bgColor)
    .strokeColor(borderColor)
    .lineWidth(1)
    .fillAndStroke();

  // 2. Compute exact vector scaling across the full width
  const textSpace = showText ? 14 : 0;
  const paddingX = 8;
  const availableWidth = width - (paddingX * 2);
  const scale = availableWidth / totalModules;

  const startX = x + paddingX;
  const barY = y + 7;
  const barHeight = height - 14 - textSpace;

  // 3. Draw black vector rectangles (100% vector sharpness)
  doc.fillColor('#000000');
  for (const bar of bars) {
    doc.rect(startX + (bar.x * scale), barY, bar.width * scale, barHeight).fill();
  }

  // 4. Draw human-readable monospace text below bars
  if (showText) {
    doc.fillColor(textColor)
      .font('Courier-Bold')
      .fontSize(9.5)
      .text(text, x, y + height - 12, {
        width: width,
        align: 'center',
        characterSpacing: 1.5
      });
  }

  doc.restore();
}

/**
 * Generates an SVG string of the barcode.
 */
function generateCode128SvgString(text, options = {}) {
  const { height = 70, showText = true } = options;
  const { totalModules, bars } = generateCode128Bars(text, 12);
  const textSpace = showText ? 16 : 0;
  const totalSvgHeight = height + textSpace;

  let rects = '';
  for (const bar of bars) {
    rects += `<rect x="${bar.x}" y="0" width="${bar.width}" height="${height}" fill="#000000" shape-rendering="crispEdges" />`;
  }

  let textSvg = '';
  if (showText) {
    textSvg = `<text x="${totalModules / 2}" y="${height + 12}" text-anchor="middle" font-family="'Courier New', Courier, monospace" font-size="10" font-weight="700" fill="#0F172A" letter-spacing="1.5px">${text}</text>`;
  }

  return `<svg viewBox="0 0 ${totalModules} ${totalSvgHeight}" preserveAspectRatio="xMidYMid meet" xmlns="http://www.w3.org/2000/svg" style="background:#FFFFFF;display:block;width:100%;height:100%;"><rect width="100%" height="100%" fill="#FFFFFF"/>${rects}${textSvg}</svg>`;
}

/**
 * Generates a base64 Data URL for embedding in HTML emails or images.
 */
function generateCode128DataUrl(text, options = {}) {
  const svg = generateCode128SvgString(text, options);
  const base64 = Buffer.from(svg).toString('base64');
  return `data:image/svg+xml;base64,${base64}`;
}

/**
 * Generates a razor-sharp PNG Buffer of the Code 128 barcode.
 * Universally supported by all email clients (Gmail, Outlook, Yahoo, Apple Mail).
 */
function generateCode128PngBuffer(text, options = {}) {
  const { PNG } = require('pngjs');
  const { moduleWidth = 2, height = 76, quietZoneModules = 12 } = options;
  const { totalModules, bars } = generateCode128Bars(text, quietZoneModules);

  const width = totalModules * moduleWidth;
  const png = new PNG({ width, height });

  // 1. Fill entire image with solid white
  png.data.fill(255);

  // 2. Render solid pitch-black vertical bars
  for (const bar of bars) {
    const startX = bar.x * moduleWidth;
    const barW = bar.width * moduleWidth;

    for (let y = 0; y < height; y++) {
      for (let x = startX; x < startX + barW; x++) {
        const idx = (width * y + x) << 2;
        png.data[idx] = 0;       // R
        png.data[idx + 1] = 0;   // G
        png.data[idx + 2] = 0;   // B
        png.data[idx + 3] = 255; // Alpha
      }
    }
  }

  return PNG.sync.write(png);
}

module.exports = {
  generateCode128Bars,
  drawCode128OnPdf,
  generateCode128SvgString,
  generateCode128DataUrl,
  generateCode128PngBuffer
};
