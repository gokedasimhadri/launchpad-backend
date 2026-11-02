const path = require('path');
const dotenv = require('dotenv');
const nodemailer = require('nodemailer');
const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');

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
      const doc = new PDFDocument({
        size: 'A4',
        margin: 40,
        compress: false,
        info: {
          Title: `Aditya University Event Pass - ${couponCode}`,
          Author: 'Aditya University',
          Subject: `${eventName} Admit Pass`,
        }
      });

      const buffers = [];
      doc.on('data', buffers.push.bind(buffers));
      doc.on('end', () => resolve(Buffer.concat(buffers)));
      doc.on('error', reject);

      const pageWidth = doc.page.width; // 595.28 for A4
      const cardX = 40;
      const cardY = 50;
      const cardWidth = pageWidth - 80; // 515.28
      const cardHeight = 440;

      // 1. Draw Ticket Card Container Outer Border
      doc.save();
      doc.roundedRect(cardX, cardY, cardWidth, cardHeight, 16)
         .lineWidth(1.5)
         .strokeColor('#CBD5E1')
         .fillColor('#FFFFFF')
         .fillAndStroke();
      doc.restore();

      // 2. Ticket Header Strip (Deep Navy #0F172A)
      doc.save();
      doc.roundedRect(cardX, cardY, cardWidth, 80, 16)
         .clip();
      doc.rect(cardX, cardY, cardWidth, 80)
         .fillColor('#0F172A')
         .fill();
      // Amber Gold Accent line at bottom of header
      doc.rect(cardX, cardY + 77, cardWidth, 3)
         .fillColor('#F59E0B')
         .fill();
      doc.restore();

      // University Title & Subtitle
      doc.fillColor('#F59E0B')
         .font('Helvetica-Bold')
         .fontSize(18)
         .text('ADITYA UNIVERSITY', cardX + 24, cardY + 22);

      doc.fillColor('#CBD5E1')
         .font('Helvetica')
         .fontSize(9.5)
         .text('OFFICIAL EVENT ENTRY & ATTENDANCE PASS', cardX + 24, cardY + 46);

      // Verified Badge on Top Right
      const badgeWidth = 140;
      const badgeX = cardX + cardWidth - badgeWidth - 24;
      const badgeY = cardY + 26;
      doc.save();
      doc.roundedRect(badgeX, badgeY, badgeWidth, 26, 13)
         .lineWidth(1)
         .strokeColor('#F59E0B')
         .fillColor('#1E293B')
         .fillAndStroke();
      doc.fillColor('#FBBF24')
         .font('Helvetica-Bold')
         .fontSize(8.5)
         .text('VERIFIED & PAID ENTRY', badgeX, badgeY + 8, { width: badgeWidth, align: 'center' });
      doc.restore();

      // 3. Event Title
      const contentY = cardY + 98;
      doc.fillColor('#0F172A')
         .font('Helvetica-Bold')
         .fontSize(20)
         .text(eventName, cardX + 24, contentY, { width: cardWidth - 48 });

      // 4. Details Box (Grey background with neat 2-column key-values)
      const detailsBoxY = contentY + 36;
      const detailsBoxHeight = 84;
      doc.save();
      doc.roundedRect(cardX + 24, detailsBoxY, cardWidth - 48, detailsBoxHeight, 10)
         .fillColor('#F8FAFC')
         .strokeColor('#E2E8F0')
         .lineWidth(1)
         .fillAndStroke();
      doc.restore();

      const col1X = cardX + 40;
      const col2X = cardX + (cardWidth / 2) + 10;
      const row1Y = detailsBoxY + 14;
      const row2Y = detailsBoxY + 48;

      // Col 1, Row 1: Participant Name
      doc.fillColor('#64748B').font('Helvetica-Bold').fontSize(8).text('PARTICIPANT NAME', col1X, row1Y);
      doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(12).text(studentName, col1X, row1Y + 12);

      // Col 2, Row 1: Roll Number
      doc.fillColor('#64748B').font('Helvetica-Bold').fontSize(8).text('ROLL NUMBER', col2X, row1Y);
      doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(12).text(rNo, col2X, row1Y + 12);

      // Col 1, Row 2: Branch
      doc.fillColor('#64748B').font('Helvetica-Bold').fontSize(8).text('BRANCH / DEPARTMENT', col1X, row2Y);
      doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(11).text(branch || 'General', col1X, row2Y + 12);

      // Col 2, Row 2: Role / Team
      const roleText = teamName ? `${teamName} (${isLeader ? 'Leader' : 'Member'})` : (isLeader ? 'Individual Participant' : 'Team Member');
      doc.fillColor('#64748B').font('Helvetica-Bold').fontSize(8).text('REGISTRATION ROLE', col2X, row2Y);
      doc.fillColor('#0F172A').font('Helvetica-Bold').fontSize(11).text(roleText, col2X, row2Y + 12);

      // 5. Coupon Voucher Strip (Light Blue background with dashed border)
      const couponStripY = detailsBoxY + detailsBoxHeight + 16;
      const couponStripHeight = 110;
      const couponStripWidth = cardWidth - 48;

      doc.save();
      doc.roundedRect(cardX + 24, couponStripY, couponStripWidth, couponStripHeight, 10)
         .fillColor('#EFF6FF')
         .strokeColor('#2563EB')
         .lineWidth(1.5)
         .dash(4, { space: 3 })
         .fillAndStroke();
      doc.restore();

      // Left Box: Coupon Details
      const couponInnerX = cardX + 40;
      doc.fillColor('#2563EB')
         .font('Helvetica-Bold')
         .fontSize(9)
         .text('OFFICIAL VERIFICATION COUPON CODE', couponInnerX, couponStripY + 16);

      // Large Coupon Code Monospace font
      doc.fillColor('#1D4ED8')
         .font('Courier-Bold')
         .fontSize(22)
         .text(couponCode, couponInnerX, couponStripY + 34, { characterSpacing: 1.5 });

      doc.fillColor('#475569')
         .font('Helvetica')
         .fontSize(9)
         .text('Present this code or scan QR for attendance.', couponInnerX, couponStripY + 68);

      doc.fillColor('#94A3B8')
         .font('Helvetica-Oblique')
         .fontSize(8)
         .text(`Strictly assigned to Roll No: ${rNo} | Non-transferable`, couponInnerX, couponStripY + 84);

      // Right Box: Embed QR Code
      if (qrBuffer) {
        const qrSize = 82;
        const qrX = cardX + 24 + couponStripWidth - qrSize - 16;
        const qrY = couponStripY + 10;

        // White background border for QR code
        doc.save();
        doc.roundedRect(qrX - 4, qrY - 4, qrSize + 8, qrSize + 8, 6)
           .fillColor('#FFFFFF')
           .strokeColor('#CBD5E1')
           .lineWidth(1)
           .fillAndStroke();
        doc.restore();

        doc.image(qrBuffer, qrX, qrY, { width: qrSize, height: qrSize });

        doc.fillColor('#64748B')
           .font('Helvetica-Bold')
           .fontSize(7)
           .text('SCAN FOR ATTENDANCE', qrX - 10, qrY + qrSize + 6, { width: qrSize + 20, align: 'center' });
      }

      // 6. Footer Strip
      const footerY = cardY + cardHeight - 34;
      doc.save();
      doc.rect(cardX, footerY, cardWidth, 34)
         .fillColor('#F8FAFC')
         .fill();
      doc.moveTo(cardX, footerY).lineTo(cardX + cardWidth, footerY).strokeColor('#E2E8F0').lineWidth(1).stroke();
      doc.restore();

      doc.fillColor('#64748B')
         .font('Helvetica')
         .fontSize(8.5)
         .text('Issued by Aditya University Technical & Cultural Events Council', cardX + 24, footerY + 12);

      doc.fillColor('#0F172A')
         .font('Helvetica-Bold')
         .fontSize(8.5)
         .text('OFFICIAL DIGITAL PASS', cardX + cardWidth - 160, footerY + 12, { width: 136, align: 'right' });

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
            Present this code or scan QR for attendance.
          </div>
        </div>
        <div class="qr-container">
          <img src="${qrDataUrl}" alt="QR Code" />
          <div style="font-size: 10px; color: #64748b; margin-top: 4px;">SCAN PASS</div>
        </div>
      </div>
    </div>
    <div class="ticket-footer">
      <div>Issued by Aditya University Technical & Cultural Events Council</div>
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

                    <!-- Embedded QR Code -->
                    <td style="width: 110px; text-align: center; vertical-align: middle; padding-left: 12px;">
                      <img src="cid:couponqrcode" alt="QR Code" width="100" height="100" style="display: block; margin: 0 auto; border-radius: 8px; border: 1px solid #cbd5e1; background-color: #ffffff; padding: 4px;" />
                      <span style="display: block; font-size: 9px; color: #64748b; font-weight: 700; margin-top: 4px; text-transform: uppercase;">SCAN FOR ATTENDANCE </span>
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

  // 1. Generate QR Code data URL & PNG Buffer
  const qrDataUrl = await QRCode.toDataURL(couponCode, {
    width: 250,
    margin: 1,
    color: {
      dark: '#0f172a',
      light: '#ffffff',
    },
  });

  const base64Data = qrDataUrl.replace(/^data:image\/png;base64,/, '');
  const qrBuffer = Buffer.from(base64Data, 'base64');

  // 2. Generate official PDF event pass attachment
  const pdfBuffer = await generateCouponPDFBuffer({
    studentName,
    rNo,
    branch,
    eventName,
    teamName,
    couponCode,
    isLeader,
    qrBuffer,
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
    qrDataUrl,
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
        filename: 'qr-code.png',
        content: qrBuffer,
        cid: 'couponqrcode', // Referenced in <img src="cid:couponqrcode" />
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
