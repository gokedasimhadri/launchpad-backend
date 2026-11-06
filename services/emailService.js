const path = require('path');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');
const { drawCode128OnPdf, generateCode128DataUrl, generateCode128SvgString, generateCode128PngBuffer } = require('../utils/barcodeGenerator');

/**
 * Creates and configures the Nodemailer transporter.
 */
let cachedTransporter = null;
let lastUser = null;
let lastPass = null;
let isEtherealAccount = false;

const getTransporter = async () => {
  // Reload dotenv to pick up any freshly modified EMAIL_USER and EMAIL_PASS
  dotenv.config({ path: path.join(__dirname, '../.env') });

  const user = (process.env.EMAIL_USER || process.env.SMTP_USER || '').trim();
  const pass = (process.env.EMAIL_PASS || process.env.SMTP_PASS || '').trim();
  let host = (process.env.EMAIL_HOST || process.env.SMTP_HOST || '').trim();
  let port = parseInt(process.env.EMAIL_PORT || process.env.SMTP_PORT || '587', 10);
  const secure = process.env.EMAIL_SECURE === 'true' || process.env.SMTP_SECURE === 'true' || port === 465;

  // Auto-detect host based on email domain if not specified
  if (!host) {
    if (user.includes('adityauniversity.in') || user.includes('aditya.ac.in') || user.includes('outlook') || user.includes('office365')) {
      host = 'smtp.office365.com';
      port = 587;
    } else if (user.endsWith('@gmail.com')) {
      host = 'smtp.gmail.com';
      port = 587;
    } else {
      host = 'smtp.office365.com';
      port = 587;
    }
  }

  // If credentials have changed or newly added, invalidate cache
  if (user !== lastUser || pass !== lastPass) {
    cachedTransporter = null;
    lastUser = user;
    lastPass = pass;
  }

  // If real credentials are provided in .env
  if (user && pass) {
    if (!cachedTransporter || isEtherealAccount) {
      if (host.includes('office365') || host.includes('outlook') || user.includes('adityauniversity.in') || user.includes('aditya.ac.in')) {
        cachedTransporter = nodemailer.createTransport({
          host: 'smtp.office365.com',
          port: 587,
          secure: false,
          auth: { user, pass },
          tls: {
            ciphers: 'SSLv3',
            rejectUnauthorized: false,
          },
        });
      } else if (user.endsWith('@gmail.com') || (process.env.EMAIL_SERVICE || '').toLowerCase() === 'gmail') {
        cachedTransporter = nodemailer.createTransport({
          service: 'gmail',
          auth: { user, pass },
          tls: { rejectUnauthorized: false },
        });
      } else {
        cachedTransporter = nodemailer.createTransport({
          host,
          port,
          secure,
          auth: { user, pass },
          tls: { rejectUnauthorized: false },
        });
      }
      isEtherealAccount = false;
      console.log(`[EmailService] Transporter configured for account: ${user} via ${host}:${port}`);
    }
    return cachedTransporter;
  }

  // Fallback to cached test transporter if available
  if (cachedTransporter && isEtherealAccount) {
    return cachedTransporter;
  }

  // Create ethereal test account for simulation / preview
  try {
    const testAccount = await nodemailer.createTestAccount();
    cachedTransporter = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: {
        user: testAccount.user,
        pass: testAccount.pass,
      },
    });
    isEtherealAccount = true;
    console.log('[EmailService] Created Ethereal test account:', testAccount.user);
    return cachedTransporter;
  } catch (err) {
    console.warn('[EmailService] Ethereal account creation failed, using mock mode:', err.message);
    return null;
  }
};

/**
 * Generates an official, beautifully designed PDF event pass buffer.
 */
const generateCouponPDFBuffer = async ({ studentName, rNo, branch, eventName, teamName, couponCode, isLeader, qrBuffer }) => {
  return new Promise((resolve, reject) => {
    try {
      const fs = require('fs');
      const doc = new PDFDocument({
        size: 'A4',
        margin: 36,
        compress: false,
        info: {
          Title: `Aditya University Event Pass - ${couponCode}`,
          Author: 'Aditya University',
          Subject: `${eventName} Official Admit Pass`,
        }
      });

      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const pageWidth = doc.page.width; // 595.28 for A4
      const cardWidth = 510;
      const cardX = (pageWidth - cardWidth) / 2; // 42.64 (centered)
      const cardStartY = 38;

      const cleanEventName = String(eventName || 'Aditya University Event').trim();
      const cleanStudentName = String(studentName || 'Student').trim();
      const cleanRNo = String(rNo || '').trim().toUpperCase();
      const cleanBranch = String(branch || 'General').trim();
      const roleText = teamName
        ? `${teamName} (${isLeader ? 'Leader' : 'Member'})`
        : (isLeader ? 'Individual Participant' : 'Team Member');

      // Dynamically calculate event title height
      doc.font('Helvetica-Bold').fontSize(16);
      const eventTitleH = Math.max(22, doc.heightOfString(cleanEventName, { width: cardWidth - 48 }));

      const headerHeight = 72;
      const detailsBoxHeight = 78;
      const couponStripHeight = 114;
      const footerHeight = 32;
      const cardHeight = headerHeight + 16 + eventTitleH + 12 + detailsBoxHeight + 14 + couponStripHeight + footerHeight;

      // 1. Draw Outer Card Container
      doc.save();
      doc.roundedRect(cardX, cardStartY, cardWidth, cardHeight, 14)
        .lineWidth(1.5)
        .strokeColor('#CBD5E1')
        .fillColor('#FFFFFF')
        .fillAndStroke();
      doc.restore();

      // 2. Ticket Header Strip (Deep Navy #0B1329)
      doc.save();
      doc.roundedRect(cardX, cardStartY, cardWidth, headerHeight, 14).clip();
      doc.rect(cardX, cardStartY, cardWidth, headerHeight).fillColor('#0B1329').fill();
      doc.rect(cardX, cardStartY + headerHeight - 3.5, cardWidth, 3.5).fillColor('#F59E0B').fill();
      doc.restore();

      // Logo or University Name
      const logoPath = path.join(__dirname, '../public/images/logo.png');
      if (fs.existsSync(logoPath)) {
        try {
          doc.image(logoPath, cardX + 18, cardStartY + 14, { height: 42 });
        } catch {
          doc.fillColor('#F59E0B').font('Helvetica-Bold').fontSize(16).text('ADITYA UNIVERSITY', cardX + 22, cardStartY + 20);
          doc.fillColor('#CBD5E1').font('Helvetica').fontSize(9).text('OFFICIAL EVENT PASS', cardX + 22, cardStartY + 42);
        }
      } else {
        doc.fillColor('#F59E0B').font('Helvetica-Bold').fontSize(16).text('ADITYA UNIVERSITY', cardX + 22, cardStartY + 20);
        doc.fillColor('#CBD5E1').font('Helvetica').fontSize(9).text('OFFICIAL EVENT PASS', cardX + 22, cardStartY + 42);
      }

      // Verified Badge Top Right
      const badgeW = 126;
      const badgeH = 24;
      const badgeX = cardX + cardWidth - badgeW - 18;
      const badgeY = cardStartY + 23;
      doc.save();
      doc.roundedRect(badgeX, badgeY, badgeW, badgeH, 12)
        .lineWidth(1)
        .strokeColor('#F59E0B')
        .fillColor('#1E293B')
        .fillAndStroke();
      doc.fillColor('#FBBF24').font('Helvetica-Bold').fontSize(8).text('VERIFIED & PAID', badgeX, badgeY + 7, { width: badgeW, align: 'center' });
      doc.restore();

      // 3. Event Title
      const titleY = cardStartY + headerHeight + 14;
      doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(16).text(cleanEventName, cardX + 24, titleY, { width: cardWidth - 48, lineGap: 2 });

      // 4. Details Box
      const detailsY = titleY + eventTitleH + 12;
      doc.save();
      doc.roundedRect(cardX + 20, detailsY, cardWidth - 40, detailsBoxHeight, 8)
        .fillColor('#F8FAFC')
        .strokeColor('#E2E8F0')
        .lineWidth(1)
        .fillAndStroke();
      doc.restore();

      const col1X = cardX + 32;
      const col2X = cardX + (cardWidth / 2) + 10;
      const row1Y = detailsY + 11;
      const row2Y = detailsY + 44;
      const colWidth = (cardWidth / 2) - 30;

      // Col 1, Row 1: Participant Name
      doc.fillColor('#64748B').font('Helvetica-Bold').fontSize(7.5).text('PARTICIPANT NAME', col1X, row1Y);
      doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(11).text(cleanStudentName, col1X, row1Y + 10, { width: colWidth, ellipsis: true });

      // Col 2, Row 1: Roll Number
      doc.fillColor('#64748B').font('Helvetica-Bold').fontSize(7.5).text('ROLL NUMBER', col2X, row1Y);
      doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(11).text(cleanRNo, col2X, row1Y + 10, { width: colWidth, ellipsis: true });

      // Col 1, Row 2: Branch
      doc.fillColor('#64748B').font('Helvetica-Bold').fontSize(7.5).text('BRANCH / DEPARTMENT', col1X, row2Y);
      doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(10).text(cleanBranch, col1X, row2Y + 10, { width: colWidth, ellipsis: true });

      // Col 2, Row 2: Role / Team
      doc.fillColor('#64748B').font('Helvetica-Bold').fontSize(7.5).text('REGISTRATION ROLE', col2X, row2Y);
      doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(10).text(roleText, col2X, row2Y + 10, { width: colWidth, ellipsis: true });

      // 5. Official Barcode & Coupon Strip
      const couponY = detailsY + detailsBoxHeight + 14;
      doc.save();
      doc.roundedRect(cardX + 20, couponY, cardWidth - 40, couponStripHeight, 8)
        .fillColor('#EFF6FF')
        .strokeColor('#2563EB')
        .lineWidth(1.2)
        .dash(4, { space: 3 })
        .fillAndStroke();
      doc.restore();

      const cInnerX = cardX + 32;
      const cInnerW = cardWidth - 64;

      // Header row inside coupon strip
      doc.fillColor('#2563EB').font('Helvetica-Bold').fontSize(8).text('OFFICIAL VERIFICATION BARCODE PASS', cInnerX, couponY + 11);
      doc.fillColor('#1D4ED8').font('Courier-Bold').fontSize(14).text(couponCode, cardX + cardWidth - 260, couponY + 9, { width: 228, align: 'right', characterSpacing: 1.5 });

      // Embed Vector Code 128 Barcode directly onto the PDF
      const barcodeBoxH = 50;
      const barcodeBoxY = couponY + 27;
      drawCode128OnPdf(doc, couponCode, cInnerX, barcodeBoxY, cInnerW, barcodeBoxH, {
        showText: false,
        bgColor: '#FFFFFF',
        borderColor: '#CBD5E1'
      });

      // Barcode Footer Note
      doc.fillColor('#334155').font('Helvetica-Bold').fontSize(7.5).text('⚡ Scan barcode for attendance verification.', cInnerX, couponY + 83);
      doc.fillColor('#64748B').font('Helvetica-Oblique').fontSize(7).text(`Roll No: ${cleanRNo} • Single Entry • CODE-128`, cardX + cardWidth - 240, couponY + 83, { width: 208, align: 'right' });
      doc.fillColor('#94A3B8').font('Helvetica').fontSize(6.8).text('Keep this barcode pass ready on mobile screen or printed A4 sheet for gate scanner.', cInnerX, couponY + 95);

      // 6. Card Footer
      const fY = cardStartY + cardHeight - footerHeight;
      doc.save();
      doc.rect(cardX, fY, cardWidth, footerHeight).fillColor('#F8FAFC').fill();
      doc.moveTo(cardX, fY).lineTo(cardX + cardWidth, fY).strokeColor('#E2E8F0').lineWidth(1).stroke();
      doc.restore();

      doc.fillColor('#64748B').font('Helvetica').fontSize(8).text('Issued by Aditya University.', cardX + 20, fY + 11);
      doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(8).text('OFFICIAL DIGITAL PASS', cardX + cardWidth - 160, fY + 11, { width: 140, align: 'right' });

      // 7. Attendee Instructions Box (Directly on A4 sheet)
      const instY = cardStartY + cardHeight + 22;
      doc.save();
      doc.roundedRect(cardX, instY, cardWidth, 110, 8)
        .fillColor('#FAFAFA')
        .strokeColor('#E2E8F0')
        .lineWidth(1)
        .fillAndStroke();
      doc.restore();

      doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(9).text('IMPORTANT INSTRUCTIONS FOR ATTENDEES', cardX + 16, instY + 12);

      const instructions = [
        '1. Present this digital pass on your smartphone or a physical printout at the event venue entrance.',
        '2. Carrying your official Aditya University Student ID Card is mandatory for verification.',
        '3. The unique BAR code will be scanned by event coordinators to record your attendance.',
        '4. This pass is strictly non-transferable and valid only for the registered participant.'
      ];

      let lineY = instY + 29;
      instructions.forEach(inst => {
        doc.fillColor('#475569').font('Helvetica').fontSize(8).text(inst, cardX + 16, lineY, { width: cardWidth - 32 });
        lineY += 17;
      });

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
};

/**
 * Generates an HTML coupon pass attachment for the email
 */
const generatePrintableCouponHTML = ({ studentName, rNo, branch, eventName, teamName, couponCode, isLeader, qrDataUrl }) => {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>Event Pass - ${eventName} - ${couponCode}</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
      background: #f1f5f9;
      color: #0f172a;
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      padding: 24px;
    }
    .ticket-card {
      background: #ffffff;
      width: 100%;
      max-width: 680px;
      border-radius: 20px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.12);
      overflow: hidden;
      border: 1px solid #e2e8f0;
      position: relative;
    }
    .ticket-header {
      background: linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%);
      color: #ffffff;
      padding: 28px 32px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 3px solid #f59e0b;
    }
    .ticket-header .univ-title {
      font-size: 20px;
      font-weight: 800;
      letter-spacing: 1px;
      color: #f59e0b;
      text-transform: uppercase;
    }
    .ticket-header .event-badge {
      background: rgba(245, 158, 11, 0.2);
      border: 1px solid #f59e0b;
      color: #fbbf24;
      padding: 6px 14px;
      border-radius: 30px;
      font-size: 12px;
      font-weight: 700;
      text-transform: uppercase;
    }
    .ticket-body {
      padding: 32px;
    }
    .event-title {
      font-size: 26px;
      font-weight: 800;
      color: #0f172a;
      margin-bottom: 20px;
      line-height: 1.2;
    }
    .details-grid {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 16px;
      margin-bottom: 28px;
      background: #f8fafc;
      padding: 20px;
      border-radius: 12px;
      border: 1px solid #e2e8f0;
    }
    .detail-item .label {
      font-size: 11px;
      text-transform: uppercase;
      color: #64748b;
      font-weight: 700;
      letter-spacing: 0.5px;
      margin-bottom: 4px;
    }
    .detail-item .value {
      font-size: 15px;
      font-weight: 700;
      color: #1e293b;
    }
    .coupon-box {
      border: 2px dashed #3b82f6;
      background: #eff6ff;
      border-radius: 14px;
      padding: 20px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 24px;
    }
    .coupon-info .hint {
      font-size: 12px;
      color: #3b82f6;
      font-weight: 700;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      margin-bottom: 6px;
    }
    .coupon-code {
      font-family: 'Courier New', Courier, monospace;
      font-size: 24px;
      font-weight: 900;
      color: #1d4ed8;
      letter-spacing: 2px;
    }
    .qr-container {
      text-align: center;
    }
    .qr-container img {
      width: 100px;
      height: 100px;
      border-radius: 8px;
      border: 1px solid #cbd5e1;
      background: #ffffff;
      padding: 4px;
    }
    .ticket-footer {
      background: #f8fafc;
      padding: 16px 32px;
      border-top: 1px solid #e2e8f0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      font-size: 12px;
      color: #64748b;
    }
    .print-btn {
      background: #1e3a8a;
      color: white;
      border: none;
      padding: 10px 20px;
      border-radius: 8px;
      font-weight: 700;
      cursor: pointer;
    }
    @media print {
      body { background: white; padding: 0; }
      .ticket-card { box-shadow: none; border: 1px solid #000; }
      .print-btn { display: none; }
    }
  </style>
</head>
<body>
  <div class="ticket-card">
    <div class="ticket-header">
      <div>
        <div class="univ-title">Aditya University</div>
        <div style="font-size: 13px; opacity: 0.85;">Official Event Entry & Coupon Pass</div>
      </div>
      <div class="event-badge">Verified Paid Entry</div>
    </div>
    <div class="ticket-body">
      <div class="event-title">${eventName}</div>
      <div class="details-grid">
        <div class="detail-item">
          <div class="label">Participant Name</div>
          <div class="value">${studentName}</div>
        </div>
        <div class="detail-item">
          <div class="label">Roll Number</div>
          <div class="value">${rNo}</div>
        </div>
        <div class="detail-item">
          <div class="label">Branch / Department</div>
          <div class="value">${branch || 'General'}</div>
        </div>
        <div class="detail-item">
          <div class="label">Registration Role</div>
          <div class="value">${teamName ? `Team: ${teamName} (${isLeader ? 'Leader' : 'Member'})` : (isLeader ? 'Individual Participant' : 'Team Member')}</div>
        </div>
      </div>

      <div class="coupon-box">
        <div class="coupon-info">
          <div class="hint">Official Verification Coupon Code</div>
          <div class="coupon-code">${couponCode}</div>
          <div style="font-size: 12px; color: #475569; margin-top: 6px;">
            Present this barcode or pass code for gate attendance.
          </div>
        </div>
        <div class="qr-container" style="min-width: 180px;">
          <div style="background: #ffffff; padding: 6px; border-radius: 8px; border: 1px solid #cbd5e1;">
            ${generateCode128SvgString(couponCode, { height: 48, showText: false })}
          </div>
          <div style="font-size: 10px; color: #64748b; font-weight: 700; margin-top: 4px;">SCAN BARCODE</div>
        </div>
      </div>
    </div>
    <div class="ticket-footer">
      <div>Issued by Aditya University.</div>
      <button class="print-btn" onclick="window.print()">Print Pass</button>
    </div>
  </div>
</body>
</html>`;
};

/**
 * Builds the responsive HTML body for the email
 */
const buildEmailHTML = ({ studentName, rNo, branch, eventName, teamName, couponCode, isLeader, qrDataUrl }) => {
  return `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Your Event Coupon Pass - ${eventName}</title>
</head>
<body style="margin: 0; padding: 0; background-color: #f1f5f9; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; color: #1e293b;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background-color: #f1f5f9; padding: 24px 12px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width: 620px; background-color: #ffffff; border-radius: 16px; overflow: hidden; box-shadow: 0 10px 25px rgba(0,0,0,0.08); border: 1px solid #e2e8f0;">
          
          <!-- Header Banner -->
          <tr>
            <td style="background: linear-gradient(135deg, #0f172a 0%, #1e3a8a 100%); padding: 32px 28px; text-align: center; border-bottom: 4px solid #f59e0b;">
              <h1 style="margin: 0; font-size: 22px; font-weight: 800; color: #f59e0b; letter-spacing: 1.5px; text-transform: uppercase;">
                ADITYA UNIVERSITY
              </h1>
              <p style="margin: 6px 0 0 0; color: #e2e8f0; font-size: 13px; letter-spacing: 0.5px;">
                STUDENT ACTIVITIES & TECHNICAL EVENTS COUNCIL
              </p>
            </td>
          </tr>

          <!-- Welcome & Status Message -->
          <tr>
            <td style="padding: 28px 28px 16px 28px;">
              <div style="display: inline-block; background-color: #ecfdf5; border: 1px solid #10b981; color: #047857; padding: 4px 12px; border-radius: 20px; font-size: 12px; font-weight: 700; text-transform: uppercase; margin-bottom: 16px;">
                &#10003; Payment Verified & Confirmed
              </div>
              <h2 style="margin: 0 0 10px 0; font-size: 20px; color: #0f172a;">
                Hello, ${studentName}!
              </h2>
              <p style="margin: 0; font-size: 14px; line-height: 1.6; color: #475569;">
                Congratulations! You are officially registered for <strong style="color: #1e293b;">${eventName}</strong>. Your unique digital coupon code and event entry pass are generated and ready below.
              </p>
            </td>
          </tr>

          <!-- Digital Coupon Ticket Card -->
          <tr>
            <td style="padding: 8px 28px 24px 28px;">
              <div style="background: linear-gradient(135deg, #f8fafc 0%, #eff6ff 100%); border: 2px dashed #2563eb; border-radius: 14px; padding: 22px; text-align: left; position: relative;">
                
                <table width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="vertical-align: top;">
                      <div style="font-size: 11px; font-weight: 700; color: #2563eb; text-transform: uppercase; letter-spacing: 0.8px;">
                        OFFICIAL PARTICIPANT COUPON
                      </div>
                      <div style="font-size: 18px; font-weight: 800; color: #0f172a; margin: 4px 0 12px 0;">
                        ${eventName}
                      </div>

                      <table width="100%" style="font-size: 13px; color: #334155; margin-bottom: 14px;">
                        <tr>
                          <td style="padding: 3px 0; font-weight: 600; color: #64748b; width: 100px;">Roll No:</td>
                          <td style="padding: 3px 0; font-weight: 700; color: #0f172a;">${rNo}</td>
                        </tr>
                        <tr>
                          <td style="padding: 3px 0; font-weight: 600; color: #64748b;">Branch:</td>
                          <td style="padding: 3px 0; font-weight: 700; color: #0f172a;">${branch || 'General'}</td>
                        </tr>
                        ${teamName ? `
                        <tr>
                          <td style="padding: 3px 0; font-weight: 600; color: #64748b;">Team:</td>
                          <td style="padding: 3px 0; font-weight: 700; color: #0f172a;">${teamName} (${isLeader ? 'Leader' : 'Member'})</td>
                        </tr>
                        ` : ''}
                      </table>

                      <!-- Coupon Code Box -->
                      <div style="background-color: #1e293b; border-radius: 8px; padding: 10px 16px; display: inline-block;">
                        <span style="font-size: 10px; color: #94a3b8; display: block; font-weight: 700; letter-spacing: 0.5px;">YOUR COUPON CODE</span>
                        <span style="font-family: 'Courier New', Courier, monospace; font-size: 20px; font-weight: 900; color: #f59e0b; letter-spacing: 2px;">
                          ${couponCode}
                        </span>
                      </div>
                    </td>

                    <!-- Embedded Barcode -->
                    <td style="width: 200px; text-align: center; vertical-align: middle; padding-left: 12px;">
                      <div style="background-color: #ffffff; border: 1.5px solid #cbd5e1; border-radius: 8px; padding: 8px 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.04);">
                        <img src="cid:couponbarcode" alt="Event Barcode ${couponCode}" width="180" height="52" style="display: block; margin: 0 auto; width: 180px; height: 52px; border: 0;" />
                        <span style="display: block; font-size: 8.5px; color: #475569; font-weight: 700; margin-top: 4px; letter-spacing: 0.5px;">⚡ SCAN BARCODE AT GATE (CODE-128)</span>
                      </div>
                    </td>
                  </tr>
                </table>

              </div>
            </td>
          </tr>

          <!-- Download / Instructions Note -->
          <tr>
            <td style="padding: 0 28px 24px 28px;">
              <div style="background-color: #f8fafc; border-left: 4px solid #3b82f6; border-radius: 6px; padding: 12px 16px; font-size: 13px; color: #475569; line-height: 1.5;">
                <strong style="color: #1e293b;">Important Instructions:</strong>
                <ul style="margin: 6px 0 0 0; padding-left: 18px;">
                  <li>We have attached your official downloadable <strong>Event Pass PDF file</strong> with this email. Save or open it to print anytime.</li>
                  <li>This coupon is non-transferable and strictly assigned to Roll No: <strong>${rNo}</strong>.</li>
                </ul>
              </div>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="background-color: #f1f5f9; padding: 20px 28px; text-align: center; border-top: 1px solid #e2e8f0; font-size: 12px; color: #64748b;">
              <p style="margin: 0 0 6px 0; font-weight: 600;">
                Aditya University &bull; Surampalem, Kakinada District, AP, India
              </p>
              <p style="margin: 0; font-size: 11px; color: #94a3b8;">
                This is an automated system email generated for confirmed registrations.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>
  `;
};

/**
 * Sends a single coupon email to a student with PDF pass attachment
 */
const sendCouponEmail = async ({
  to,
  studentName,
  rNo,
  branch,
  eventName,
  teamName,
  couponCode,
  isLeader = false,
}) => {
  if (!to || !to.includes('@')) {
    throw new Error(`Invalid or missing email address: ${to}`);
  }

  // 1. Generate crisp Code 128 Barcode PNG Buffer (Compatible with all email clients including Gmail)
  const barcodeBuffer = generateCode128PngBuffer(couponCode, { height: 60, moduleWidth: 2 });

  // 2. Generate official PDF event pass attachment (with vector barcode)
  const pdfBuffer = await generateCouponPDFBuffer({
    studentName,
    rNo,
    branch,
    eventName,
    teamName,
    couponCode,
    isLeader,
  });

  // 3. Build email body
  const emailHtml = buildEmailHTML({
    studentName,
    rNo,
    branch,
    eventName,
    teamName,
    couponCode,
    isLeader,
  });

  const cleanRNo = String(rNo || 'student').replace(/[^a-zA-Z0-9]/g, '');
  const cleanCoupon = String(couponCode).replace(/[^a-zA-Z0-9-]/g, '');

  const user = (process.env.EMAIL_USER || process.env.SMTP_USER || '').trim();
  const fromName = process.env.EMAIL_FROM_NAME || process.env.SMTP_FROM_NAME || 'Aditya University Events';
  const fromEmail = (process.env.EMAIL_FROM || user || 'no-reply@adityauniversity.in').trim();

  const mailOptions = {
    from: `"${fromName}" <${fromEmail}>`,
    to: to.trim(),
    subject: `🎟️ Your Event Coupon Pass: ${couponCode} - ${eventName} | Aditya University`,
    html: emailHtml,
    attachments: [
      {
        filename: 'barcode.png',
        content: barcodeBuffer,
        cid: 'couponbarcode', // Matches <img src="cid:couponbarcode" />
        contentType: 'image/png',
      },
      {
        filename: `Aditya_Event_Pass_${cleanRNo}_${cleanCoupon}.pdf`,
        content: pdfBuffer,
        contentType: 'application/pdf',
      },
    ],
  };

  const transporter = await getTransporter();

  // If in mock mode (no transporter could be created)
  if (!transporter) {
    console.log(`[EmailService MOCK] Simulated sending coupon email to: ${to} (Coupon: ${couponCode})`);
    return {
      success: true,
      messageId: `mock_${Date.now()}_${cleanRNo}`,
      isMock: true,
      previewUrl: null,
    };
  }

  // Send email
  const info = await transporter.sendMail(mailOptions);
  const previewUrl = nodemailer.getTestMessageUrl ? nodemailer.getTestMessageUrl(info) : null;

  if (previewUrl) {
    console.log(`[EmailService] Preview URL for ${to}: ${previewUrl}`);
  }

  return {
    success: true,
    messageId: info.messageId,
    previewUrl: previewUrl || null,
    isEthereal: isEtherealAccount,
  };
};

/**
 * Check SMTP status and configuration
 */
const checkSmtpStatus = async () => {
  dotenv.config({ path: path.join(__dirname, '../.env') });
  const user = (process.env.EMAIL_USER || process.env.SMTP_USER || '').trim();
  const pass = (process.env.EMAIL_PASS || process.env.SMTP_PASS || '').trim();
  const host = (process.env.EMAIL_HOST || process.env.SMTP_HOST || 'smtp.gmail.com').trim();
  const isConfigured = Boolean(user && pass);

  return {
    isConfigured,
    host,
    user: user ? `${user.substring(0, 3)}***@${user.split('@')[1] || ''}` : 'Not set (Simulation Mode)',
    fromEmail: process.env.EMAIL_USER || user || 'no-reply@adityauniversity.in'
  };
};

module.exports = {
  sendCouponEmail,
  checkSmtpStatus,
  generatePrintableCouponHTML,
  generateCouponPDFBuffer,
};
