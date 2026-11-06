const express = require('express');
const router = express.Router();
const ClubEvent = require('../models/ClubEvent');
const ClubEventRegistration = require('../models/ClubEventRegistration');
const ClubEventPayment = require('../models/ClubEventPayment');
const emailService = require('../services/emailService');

// Helper to sanitize slug
const sanitizeSlug = (slug) => {
  return String(slug || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

// GET /api/club-events/roles - List all unique event roles
router.get('/roles', async (req, res) => {
  try {
    const roles = await ClubEvent.distinct('role');
    const cleanRoles = roles
      .filter(r => r && typeof r === 'string' && r.trim().length > 0)
      .map(r => r.trim());

    // Deduplicate case-insensitively while preserving formatting
    const uniqueMap = new Map();
    cleanRoles.forEach(r => {
      const lower = r.toLowerCase();
      if (!uniqueMap.has(lower)) {
        uniqueMap.set(lower, r);
      }
    });

    res.status(200).json({ success: true, data: Array.from(uniqueMap.values()).sort() });
  } catch (error) {
    console.error('Error fetching roles:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch roles', error: error.message });
  }
});

// GET /api/club-events - List all events with optional filters (status, registration, search, role)
router.get('/', async (req, res) => {
  try {
    const { status, registration, search, role } = req.query;
    const query = {};

    // Filter by role if specified and not 'all' or 'dean'
    if (role && role !== 'all' && role.toLowerCase() !== 'dean') {
      query.role = new RegExp(`^${role.trim()}$`, 'i');
    }

    if (status && status !== 'all') {
      query.status = status.toLowerCase();
    }

    if (registration && registration !== 'all') {
      query.registration = registration.toLowerCase();
    }

    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$or = [{ name: searchRegex }, { slug_link: searchRegex }, { role: searchRegex }];
    }

    const events = await ClubEvent.find(query).sort({ createdAt: -1 });
    res.status(200).json({ success: true, count: events.length, data: events });
  } catch (error) {
    console.error('Error fetching club events:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch club events', error: error.message });
  }
});

// GET /api/club-events/registrations - List all registrations across all club events with filters and linked payment info
router.get('/registrations', async (req, res) => {
  try {
    const { eventId, search, status, branch, role } = req.query;
    const andClauses = [];

    let roleEventIds = [];
    let roleEventSlugs = [];

    // Role-based scoping for non-dean / specified role
    if (role && role !== 'all' && role.toLowerCase() !== 'dean') {
      const roleEvents = await ClubEvent.find({ role: new RegExp(`^${role.trim()}$`, 'i') }, '_id slug_link');
      roleEventIds = roleEvents.map(e => e._id.toString());
      roleEventSlugs = roleEvents.map(e => (e.slug_link || '').toLowerCase());

      andClauses.push({
        $or: [
          { eventId: { $in: roleEventIds } },
          { eventSlug: { $in: roleEventSlugs } }
        ]
      });
    }

    if (eventId && eventId !== 'all') {
      if (eventId.match(/^[0-9a-fA-F]{24}$/)) {
        andClauses.push({ eventId: eventId });
      } else {
        andClauses.push({ eventSlug: eventId.toLowerCase() });
      }
    }

    if (status && status !== 'all') {
      andClauses.push({ paymentStatus: status.toLowerCase() });
    }

    if (branch && branch !== 'all') {
      andClauses.push({ branch: new RegExp(`^${branch.trim()}$`, 'i') });
    }

    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      andClauses.push({
        $or: [
          { rNo: searchRegex },
          { name: searchRegex },
          { email: searchRegex },
          { phone: searchRegex },
          { eventName: searchRegex },
          { transactionId: searchRegex },
          { razorpayPaymentId: searchRegex },
          { razorpayOrderId: searchRegex },
        ]
      });
    }

    const query = andClauses.length > 0 ? { $and: andClauses } : {};
    const rawRegistrations = await ClubEventRegistration.find(query).sort({ createdAt: -1 }).lean();

    // Fetch payments to attach accurate payment information from 'clubeventrpayments'
    const eventIds = rawRegistrations.map(r => r.eventId).filter(Boolean);
    const rNos = rawRegistrations.map(r => r.rNo).filter(Boolean);
    const payments = await ClubEventPayment.find({
      eventId: { $in: eventIds },
      rNo: { $in: rNos }
    }).lean();

    // Map payments by eventId + rNo
    const paymentMap = new Map();
    payments.forEach(p => {
      const key = `${p.eventId ? p.eventId.toString() : ''}_${(p.rNo || '').toUpperCase()}`;
      // Keep the latest or paid one
      if (!paymentMap.has(key) || p.paymentStatus === 'paid') {
        paymentMap.set(key, p);
      }
    });

    // Merge payment details into each registration object
    const registrations = rawRegistrations.map(r => {
      const key = `${r.eventId ? r.eventId.toString() : ''}_${(r.rNo || '').toUpperCase()}`;
      const payment = paymentMap.get(key);
      if (payment) {
        return {
          ...r,
          paymentStatus: payment.paymentStatus === 'paid' ? 'paid' : r.paymentStatus,
          amountPaid: Math.floor(payment.amount !== undefined ? payment.amount : (r.amountPaid || 0)),
          razorpayPaymentId: payment.razorpayPaymentId || r.razorpayPaymentId || '',
          razorpayOrderId: payment.razorpayOrderId || r.razorpayOrderId || '',
          transactionId: payment.transactionId || payment.razorpayPaymentId || r.transactionId || '',
          paymentInfo: payment,
        };
      }
      return r;
    });

    // Compute stats across registrations and payments (scoped to role if applicable)
    let statsQuery = {};
    let paymentStatsQuery = { paymentStatus: 'paid' };

    if (roleEventIds.length > 0 || roleEventSlugs.length > 0) {
      statsQuery = {
        $or: [
          { eventId: { $in: roleEventIds } },
          { eventSlug: { $in: roleEventSlugs } }
        ]
      };
      paymentStatsQuery = {
        paymentStatus: 'paid',
        $or: [
          { eventId: { $in: roleEventIds } },
          { eventSlug: { $in: roleEventSlugs } }
        ]
      };
    }

    const allRegistrations = await ClubEventRegistration.find(statsQuery).lean();
    const allPayments = await ClubEventPayment.find(paymentStatsQuery).lean();

    const totalCount = allRegistrations.length;
    const paidCount = allRegistrations.filter(r => r.paymentStatus === 'paid').length;
    const pendingCount = allRegistrations.filter(r => r.paymentStatus === 'pending').length;
    const freeCount = allRegistrations.filter(r => r.paymentStatus === 'free').length;

    // Total revenue from separate 'clubeventrpayments' collection (with fallback to legacy paid amounts)
    let totalRevenue = allPayments.reduce((acc, p) => acc + Math.floor(Number(p.amount) || 0), 0);
    if (totalRevenue === 0) {
      totalRevenue = allRegistrations.reduce((acc, r) => acc + Math.floor(Number(r.amountPaid) || 0), 0);
    }

    res.status(200).json({
      success: true,
      count: registrations.length,
      data: registrations,
      stats: {
        total: totalCount,
        paid: paidCount,
        pending: pendingCount,
        free: freeCount,
        totalRevenue: totalRevenue,
      }
    });
  } catch (error) {
    console.error('Error fetching all registrations:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch registrations', error: error.message });
  }
});

// Helper to generate unique coupon code event-wise
const generateUniqueCouponCode = (eventName, rNo) => {
  const cleanName = (eventName || 'EVENT').replace(/[^a-zA-Z0-9\s]/g, '').trim();
  const words = cleanName.split(/\s+/).filter(Boolean);
  let prefix = '';
  if (words.length >= 2) {
    prefix = words.slice(0, 3).map(w => w[0].toUpperCase()).join('');
  } else if (words.length === 1 && words[0].length >= 3) {
    prefix = words[0].substring(0, 4).toUpperCase();
  } else {
    prefix = 'EVT';
  }
  const cleanRNo = (rNo || 'STU').replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  const randomSuffix = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `AU-${prefix}-${cleanRNo}-${randomSuffix}`;
};

// GET /api/club-events/coupons - List all paid students event-wise and guarantee unique coupon codes
router.get('/coupons', async (req, res) => {
  try {
    const { eventId, search, sentStatus, role } = req.query;
    const andClauses = [{ paymentStatus: 'paid' }];

    let roleEventIds = [];
    let roleEventSlugs = [];

    // Role-based scoping
    if (role && role !== 'all' && role.toLowerCase() !== 'dean') {
      const roleEvents = await ClubEvent.find({ role: new RegExp(`^${role.trim()}$`, 'i') }, '_id slug_link name');
      roleEventIds = roleEvents.map(e => e._id.toString());
      roleEventSlugs = roleEvents.map(e => (e.slug_link || '').toLowerCase());

      andClauses.push({
        $or: [
          { eventId: { $in: roleEventIds } },
          { eventSlug: { $in: roleEventSlugs } }
        ]
      });
    }

    if (eventId && eventId !== 'all') {
      if (eventId.match(/^[0-9a-fA-F]{24}$/)) {
        andClauses.push({ eventId: eventId });
      } else {
        andClauses.push({ eventSlug: eventId.toLowerCase() });
      }
    }

    const query = andClauses.length > 0 ? { $and: andClauses } : { paymentStatus: 'paid' };
    const registrations = await ClubEventRegistration.find(query).sort({ createdAt: -1 });

    // Ensure all paid members have unique coupon codes generated and persisted
    for (const reg of registrations) {
      let modified = false;
      if (Array.isArray(reg.teamMembers) && reg.teamMembers.length > 0) {
        for (const member of reg.teamMembers) {
          if (!member.couponCode) {
            member.couponCode = generateUniqueCouponCode(reg.eventName, member.rNo);
            member.couponSentStatus = member.couponSentStatus || 'pending';
            modified = true;
          }
        }
        if (!reg.couponCode && reg.teamMembers[0]) {
          reg.couponCode = reg.teamMembers[0].couponCode;
          modified = true;
        }
      } else {
        if (!reg.couponCode) {
          reg.couponCode = generateUniqueCouponCode(reg.eventName, reg.rNo);
          reg.couponSentStatus = reg.couponSentStatus || 'pending';
          modified = true;
        }
      }
      if (modified) {
        await reg.save();
      }
    }

    // Flatten into individual participant rows for event-wise viewing
    let flatList = [];
    registrations.forEach(reg => {
      if (Array.isArray(reg.teamMembers) && reg.teamMembers.length > 0) {
        reg.teamMembers.forEach(member => {
          flatList.push({
            id: `${reg._id}_${member._id || member.rNo}`,
            registrationId: reg._id.toString(),
            memberId: member._id ? member._id.toString() : null,
            eventId: reg.eventId ? reg.eventId.toString() : '',
            eventName: reg.eventName,
            eventSlug: reg.eventSlug,
            teamName: reg.teamName || '',
            teamType: reg.teamType || 'per_team',
            teamSize: reg.teamSize || reg.teamMembers.length,
            isLeader: Boolean(member.isLeader || member.rNo === reg.rNo),
            rNo: member.rNo,
            name: member.name,
            email: member.email || (member.rNo === reg.rNo ? reg.email : ''),
            phone: member.phone || (member.rNo === reg.rNo ? reg.phone : ''),
            branch: member.branch || reg.branch || 'N/A',
            gender: member.gender || reg.gender || '',
            bloodgroup: member.bloodgroup || '',
            paymentStatus: reg.paymentStatus,
            amountPaid: reg.amountPaid,
            transactionId: reg.transactionId || reg.razorpayPaymentId || '',
            couponCode: member.couponCode || '',
            couponSentAt: member.couponSentAt || null,
            couponSentStatus: member.couponSentStatus || 'pending',
            attendanceStatus: member.attendanceStatus || 'pending',
            attendedAt: member.attendedAt || null,
            attendanceMarkedBy: member.attendanceMarkedBy || '',
            registeredAt: reg.createdAt,
          });
        });
      } else {
        flatList.push({
          id: `${reg._id}_solo`,
          registrationId: reg._id.toString(),
          memberId: null,
          eventId: reg.eventId ? reg.eventId.toString() : '',
          eventName: reg.eventName,
          eventSlug: reg.eventSlug,
          teamName: '',
          teamType: 'per_head',
          teamSize: 1,
          isLeader: true,
          rNo: reg.rNo,
          name: reg.name,
          email: reg.email,
          phone: reg.phone,
          branch: reg.branch || 'N/A',
          gender: reg.gender || '',
          bloodgroup: reg.bloodgroup || '',
          paymentStatus: reg.paymentStatus,
          amountPaid: reg.amountPaid,
          transactionId: reg.transactionId || reg.razorpayPaymentId || '',
          couponCode: reg.couponCode || '',
          couponSentAt: reg.couponSentAt || null,
          couponSentStatus: reg.couponSentStatus || 'pending',
          attendanceStatus: reg.attendanceStatus || 'pending',
          attendedAt: reg.attendedAt || null,
          attendanceMarkedBy: reg.attendanceMarkedBy || '',
          registeredAt: reg.createdAt,
        });
      }
    });

    // Compute all events list for dropdown (scoped to role if applicable)
    let paidRegsQuery = { paymentStatus: 'paid' };
    if (roleEventIds.length > 0 || roleEventSlugs.length > 0) {
      paidRegsQuery = {
        paymentStatus: 'paid',
        $or: [
          { eventId: { $in: roleEventIds } },
          { eventSlug: { $in: roleEventSlugs } }
        ]
      };
    }
    const allPaidRegs = await ClubEventRegistration.find(paidRegsQuery).lean();
    const eventCountsMap = new Map();
    allPaidRegs.forEach(r => {
      const eId = r.eventId ? r.eventId.toString() : r.eventSlug;
      const count = Array.isArray(r.teamMembers) && r.teamMembers.length > 0 ? r.teamMembers.length : 1;
      if (!eventCountsMap.has(eId)) {
        eventCountsMap.set(eId, {
          eventId: eId,
          eventName: r.eventName,
          count: count
        });
      } else {
        const item = eventCountsMap.get(eId);
        item.count += count;
      }
    });
    const distinctEvents = Array.from(eventCountsMap.values());

    const totalCount = flatList.length;
    const sentCount = flatList.filter(item => item.couponSentStatus === 'sent').length;
    const pendingCount = totalCount - sentCount;

    // Filter by search query if provided
    if (search && search.trim()) {
      const q = search.trim().toLowerCase();
      flatList = flatList.filter(item => {
        return (
          (item.rNo && item.rNo.toLowerCase().includes(q)) ||
          (item.name && item.name.toLowerCase().includes(q)) ||
          (item.email && item.email.toLowerCase().includes(q)) ||
          (item.couponCode && item.couponCode.toLowerCase().includes(q)) ||
          (item.eventName && item.eventName.toLowerCase().includes(q)) ||
          (item.teamName && item.teamName.toLowerCase().includes(q)) ||
          (item.branch && item.branch.toLowerCase().includes(q))
        );
      });
    }

    // Filter by sentStatus
    if (sentStatus && sentStatus !== 'all') {
      if (sentStatus === 'sent') {
        flatList = flatList.filter(item => item.couponSentStatus === 'sent');
      } else if (sentStatus === 'pending') {
        flatList = flatList.filter(item => item.couponSentStatus !== 'sent');
      }
    }

    res.status(200).json({
      success: true,
      count: flatList.length,
      data: flatList,
      stats: {
        total: totalCount,
        sent: sentCount,
        pending: pendingCount,
      },
      events: distinctEvents
    });
  } catch (error) {
    console.error('Error fetching paid coupons:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch coupons', error: error.message });
  }
});

// POST /api/club-events/coupons/send-single - Send coupon email to a single paid team member
router.post('/coupons/send-single', async (req, res) => {
  try {
    const { registrationId, memberId, email, couponCode, studentName, eventName, rNo, branch, teamName, isLeader } = req.body;

    if (!email || !email.includes('@')) {
      return res.status(400).json({ success: false, message: 'A valid email address is required.' });
    }

    const reg = await ClubEventRegistration.findById(registrationId);
    if (!reg) {
      return res.status(404).json({ success: false, message: 'Registration not found' });
    }

    // Send email via emailService
    const emailResult = await emailService.sendCouponEmail({
      to: email,
      studentName: studentName || reg.name,
      rNo: rNo || reg.rNo,
      branch: branch || reg.branch,
      eventName: eventName || reg.eventName,
      teamName: teamName || reg.teamName,
      couponCode: couponCode || reg.couponCode,
      isLeader: Boolean(isLeader)
    });

    // Update sent status in DB
    const now = new Date();
    if (memberId && Array.isArray(reg.teamMembers)) {
      const sub = reg.teamMembers.id(memberId) || reg.teamMembers.find(m => m.rNo === rNo);
      if (sub) {
        sub.couponSentAt = now;
        sub.couponSentStatus = 'sent';
      }
    }
    if (reg.rNo === rNo || !memberId) {
      reg.couponSentAt = now;
      reg.couponSentStatus = 'sent';
    }
    await reg.save();

    res.status(200).json({
      success: true,
      message: `Coupon successfully emailed to ${email}!`,
      previewUrl: emailResult.previewUrl || null,
      isEthereal: emailResult.isEthereal || false,
      isMock: emailResult.isMock || false,
      sentAt: now
    });
  } catch (error) {
    console.error('Error sending single coupon email:', error);
    res.status(500).json({ success: false, message: error.message || 'Failed to send coupon email' });
  }
});

// POST /api/club-events/coupons/bulk-send - Send coupon emails to all selected or all paid students
router.post('/coupons/bulk-send', async (req, res) => {
  try {
    const { items } = req.body;

    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'No students provided for bulk email sending.' });
    }

    let successCount = 0;
    let failedCount = 0;
    const results = [];

    for (const item of items) {
      try {
        if (!item.email || !item.email.includes('@')) {
          failedCount++;
          results.push({ rNo: item.rNo, name: item.name, success: false, error: 'Invalid or missing email' });
          continue;
        }

        const sendResult = await emailService.sendCouponEmail({
          to: item.email,
          studentName: item.name,
          rNo: item.rNo,
          branch: item.branch,
          eventName: item.eventName,
          teamName: item.teamName,
          couponCode: item.couponCode,
          isLeader: item.isLeader
        });

        // Update database
        const reg = await ClubEventRegistration.findById(item.registrationId);
        if (reg) {
          const now = new Date();
          if (item.memberId && Array.isArray(reg.teamMembers)) {
            const sub = reg.teamMembers.id(item.memberId) || reg.teamMembers.find(m => m.rNo === item.rNo);
            if (sub) {
              sub.couponSentAt = now;
              sub.couponSentStatus = 'sent';
            }
          }
          if (reg.rNo === item.rNo || !item.memberId) {
            reg.couponSentAt = now;
            reg.couponSentStatus = 'sent';
          }
          await reg.save();
        }

        successCount++;
        results.push({
          rNo: item.rNo,
          name: item.name,
          email: item.email,
          couponCode: item.couponCode,
          success: true,
          previewUrl: sendResult.previewUrl
        });

        // Polite delay between mail sends to avoid throttling (150ms)
        await new Promise(r => setTimeout(r, 150));
      } catch (itemErr) {
        console.error(`Bulk send error for ${item.rNo}:`, itemErr);
        failedCount++;
        results.push({ rNo: item.rNo, name: item.name, success: false, error: itemErr.message });
      }
    }

    res.status(200).json({
      success: true,
      message: `Bulk coupon email process completed! Sent: ${successCount}, Failed: ${failedCount}`,
      summary: { total: items.length, sent: successCount, failed: failedCount },
      results
    });
  } catch (error) {
    console.error('Error in bulk sending coupons:', error);
    res.status(500).json({ success: false, message: 'Failed to process bulk email sending', error: error.message });
  }
});

// POST /api/club-events/coupons/regenerate - Regenerate coupon code for a student
router.post('/coupons/regenerate', async (req, res) => {
  try {
    const { registrationId, memberId, rNo, eventName } = req.body;
    const reg = await ClubEventRegistration.findById(registrationId);
    if (!reg) {
      return res.status(404).json({ success: false, message: 'Registration not found' });
    }

    const newCode = generateUniqueCouponCode(eventName || reg.eventName, rNo || reg.rNo);

    if (memberId && Array.isArray(reg.teamMembers)) {
      const sub = reg.teamMembers.id(memberId) || reg.teamMembers.find(m => m.rNo === rNo);
      if (sub) {
        sub.couponCode = newCode;
        sub.couponSentStatus = 'pending';
      }
    }
    if (reg.rNo === rNo || !memberId) {
      reg.couponCode = newCode;
      reg.couponSentStatus = 'pending';
    }

    await reg.save();

    res.status(200).json({
      success: true,
      message: `New coupon code generated: ${newCode}`,
      couponCode: newCode
    });
  } catch (error) {
    console.error('Error regenerating coupon code:', error);
    res.status(500).json({ success: false, message: 'Failed to regenerate coupon code', error: error.message });
  }
});

// GET /api/club-events/coupons/download-pdf - Stream official PDF pass for download
router.get('/coupons/download-pdf', async (req, res) => {
  try {
    const { registrationId, memberId, rNo } = req.query;

    const reg = await ClubEventRegistration.findById(registrationId);
    if (!reg) {
      return res.status(404).send('Registration not found');
    }

    let target = null;
    let isLeader = true;
    if (memberId && Array.isArray(reg.teamMembers)) {
      target = reg.teamMembers.id(memberId) || reg.teamMembers.find(m => m.rNo === rNo);
      isLeader = Boolean(target && (target.isLeader || target.rNo === reg.rNo));
    }
    if (!target) {
      target = {
        name: reg.name,
        rNo: reg.rNo,
        branch: reg.branch,
        couponCode: reg.couponCode
      };
      isLeader = true;
    }

    const couponCode = target.couponCode || reg.couponCode || 'AU-PASS';

    const pdfBuffer = await emailService.generateCouponPDFBuffer({
      studentName: target.name,
      rNo: target.rNo,
      branch: target.branch || reg.branch,
      eventName: reg.eventName,
      teamName: reg.teamName,
      couponCode: couponCode,
      isLeader: isLeader
    });

    const cleanRNo = String(target.rNo || 'student').replace(/[^a-zA-Z0-9]/g, '');
    const cleanCoupon = String(couponCode).replace(/[^a-zA-Z0-9-]/g, '');

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="Aditya_Event_Pass_${cleanRNo}_${cleanCoupon}.pdf"`);
    res.send(pdfBuffer);
  } catch (error) {
    console.error('Error generating PDF pass:', error);
    res.status(500).send('Failed to generate PDF pass');
  }
});

// GET /api/club-events/coupons/smtp-status - Check SMTP status
router.get('/coupons/smtp-status', async (req, res) => {
  try {
    const status = await emailService.checkSmtpStatus();
    res.status(200).json({ success: true, ...status });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// POST /api/club-events/coupons/verify-scan - Scan pass (QR / PDF / Code) and mark attendance as present
router.post('/coupons/verify-scan', async (req, res) => {
  try {
    const { codeOrRollNo, eventId, markedBy } = req.body;

    if (!codeOrRollNo || !codeOrRollNo.trim()) {
      return res.status(400).json({ success: false, message: 'Please provide a valid coupon code or roll number to scan.' });
    }

    const cleanInput = codeOrRollNo.trim().toUpperCase();

    // Query: match couponCode or rNo in root or inside teamMembers
    const query = {
      paymentStatus: 'paid',
      $or: [
        { couponCode: cleanInput },
        { rNo: cleanInput },
        { 'teamMembers.couponCode': cleanInput },
        { 'teamMembers.rNo': cleanInput },
      ]
    };

    if (eventId && eventId !== 'all') {
      if (eventId.match(/^[0-9a-fA-F]{24}$/)) {
        query.eventId = eventId;
      } else {
        query.eventSlug = eventId.toLowerCase();
      }
    }

    const reg = await ClubEventRegistration.findOne(query);

    if (!reg) {
      // Check if an unpaid registration exists with this code/roll no
      const unpaidReg = await ClubEventRegistration.findOne({
        $or: [
          { couponCode: cleanInput },
          { rNo: cleanInput },
          { 'teamMembers.couponCode': cleanInput },
          { 'teamMembers.rNo': cleanInput },
        ]
      });

      if (unpaidReg) {
        return res.status(400).json({
          success: false,
          unpaid: true,
          message: `Registration found for "${unpaidReg.eventName}", but payment status is "${unpaidReg.paymentStatus}". Attendance requires a verified PAID registration.`
        });
      }

      return res.status(404).json({
        success: false,
        notFound: true,
        message: `No paid registration pass found matching "${cleanInput}". Verify the pass and try again.`
      });
    }

    // Identify the specific student / team member
    let targetMember = null;
    let isLeader = true;

    if (Array.isArray(reg.teamMembers) && reg.teamMembers.length > 0) {
      targetMember = reg.teamMembers.find(
        m => (m.couponCode && m.couponCode.toUpperCase() === cleanInput) ||
             (m.rNo && m.rNo.toUpperCase() === cleanInput)
      );
      if (targetMember) {
        isLeader = Boolean(targetMember.isLeader || targetMember.rNo === reg.rNo);
      }
    }

    // Solo fallback
    if (!targetMember) {
      targetMember = {
        name: reg.name,
        rNo: reg.rNo,
        email: reg.email,
        phone: reg.phone,
        branch: reg.branch,
        couponCode: reg.couponCode,
        attendanceStatus: reg.attendanceStatus || 'pending',
        attendedAt: reg.attendedAt,
        attendanceMarkedBy: reg.attendanceMarkedBy
      };
      isLeader = true;
    }

    const alreadyPresent = targetMember.attendanceStatus === 'present';
    const now = new Date();
    const markerName = markedBy || 'Attendance Scanner';

    if (!alreadyPresent) {
      // Update attendance status in subdocument
      if (Array.isArray(reg.teamMembers)) {
        const sub = reg.teamMembers.find(
          m => (m.couponCode && m.couponCode.toUpperCase() === cleanInput) ||
               (m.rNo && m.rNo.toUpperCase() === cleanInput)
        );
        if (sub) {
          sub.attendanceStatus = 'present';
          sub.attendedAt = now;
          sub.attendanceMarkedBy = markerName;
        }
      }

      // If leader or solo registration
      if (reg.rNo === targetMember.rNo || reg.couponCode === targetMember.couponCode || !reg.teamMembers?.length) {
        reg.attendanceStatus = 'present';
        reg.attendedAt = now;
        reg.attendanceMarkedBy = markerName;
      }

      await reg.save();
    }

    const studentInfo = {
      registrationId: reg._id.toString(),
      memberId: targetMember._id ? targetMember._id.toString() : null,
      name: targetMember.name || reg.name,
      rNo: targetMember.rNo || reg.rNo,
      branch: targetMember.branch || reg.branch || 'N/A',
      email: targetMember.email || (isLeader ? reg.email : ''),
      phone: targetMember.phone || (isLeader ? reg.phone : ''),
      eventName: reg.eventName,
      eventSlug: reg.eventSlug,
      teamName: reg.teamName || '',
      teamType: reg.teamType || 'per_team',
      isLeader: isLeader,
      couponCode: targetMember.couponCode || reg.couponCode,
      attendanceStatus: 'present',
      attendedAt: alreadyPresent ? targetMember.attendedAt : now,
      attendanceMarkedBy: alreadyPresent ? targetMember.attendanceMarkedBy : markerName,
      alreadyPresent: alreadyPresent
    };

    if (alreadyPresent) {
      return res.status(200).json({
        success: true,
        alreadyPresent: true,
        message: `Attendance was ALREADY marked for ${studentInfo.name} (${studentInfo.rNo}) at ${new Date(targetMember.attendedAt).toLocaleTimeString('en-IN')}`,
        student: studentInfo
      });
    }

    return res.status(200).json({
      success: true,
      alreadyPresent: false,
      message: `Verified! Attendance successfully marked as PRESENT for ${studentInfo.name} (${studentInfo.rNo}).`,
      student: studentInfo
    });
  } catch (error) {
    console.error('Error verifying attendance scan:', error);
    res.status(500).json({ success: false, message: 'Server error while verifying scan', error: error.message });
  }
});

// POST /api/club-events/coupons/toggle-attendance - Manually toggle attendance between present and pending
router.post('/coupons/toggle-attendance', async (req, res) => {
  try {
    const { registrationId, memberId, rNo, status } = req.body;
    const newStatus = status === 'present' ? 'present' : 'pending';

    const reg = await ClubEventRegistration.findById(registrationId);
    if (!reg) {
      return res.status(404).json({ success: false, message: 'Registration not found' });
    }

    const now = newStatus === 'present' ? new Date() : null;
    const marker = newStatus === 'present' ? 'Manual Coordinator' : '';

    if (memberId && Array.isArray(reg.teamMembers)) {
      const sub = reg.teamMembers.id(memberId) || reg.teamMembers.find(m => m.rNo === rNo);
      if (sub) {
        sub.attendanceStatus = newStatus;
        sub.attendedAt = now;
        sub.attendanceMarkedBy = marker;
      }
    }

    if (reg.rNo === rNo || !memberId) {
      reg.attendanceStatus = newStatus;
      reg.attendedAt = now;
      reg.attendanceMarkedBy = marker;
    }

    await reg.save();

    res.status(200).json({
      success: true,
      message: `Attendance status updated to ${newStatus.toUpperCase()}`,
      attendanceStatus: newStatus,
      attendedAt: now
    });
  } catch (error) {
    console.error('Error toggling attendance:', error);
    res.status(500).json({ success: false, message: 'Failed to update attendance', error: error.message });
  }
});

// GET /api/club-events/payments - List all payments from the separate 'clubeventrpayments' collection
router.get('/payments', async (req, res) => {
  try {
    const { eventId, search, status } = req.query;
    const query = {};

    if (eventId && eventId !== 'all') {
      if (eventId.match(/^[0-9a-fA-F]{24}$/)) {
        query.eventId = eventId;
      } else {
        query.eventSlug = eventId.toLowerCase();
      }
    }

    if (status && status !== 'all') {
      query.paymentStatus = status.toLowerCase();
    }

    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$or = [
        { rNo: searchRegex },
        { name: searchRegex },
        { email: searchRegex },
        { phone: searchRegex },
        { eventName: searchRegex },
        { transactionId: searchRegex },
        { razorpayPaymentId: searchRegex },
        { razorpayOrderId: searchRegex },
      ];
    }

    const payments = await ClubEventPayment.find(query).sort({ createdAt: -1 });
    res.status(200).json({ success: true, count: payments.length, data: payments });
  } catch (error) {
    console.error('Error fetching club event payments:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch payments', error: error.message });
  }
});

// GET /api/club-events/:id - Get a single event by ID or slug
router.get('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    let event;

    if (id.match(/^[0-9a-fA-F]{24}$/)) {
      event = await ClubEvent.findById(id);
    } else {
      event = await ClubEvent.findOne({ slug_link: id.toLowerCase() });
    }

    if (!event) {
      return res.status(404).json({ success: false, message: 'Club event not found' });
    }

    res.status(200).json({ success: true, data: event });
  } catch (error) {
    console.error('Error fetching club event:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch club event', error: error.message });
  }
});

// POST /api/club-events - Create a new event
router.post('/', async (req, res) => {
  try {
    const { name, amount, registration, slug_link, status, role, password, teamType, personsCount, minTeamSize, maxTeamSize } = req.body;

    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'Club event name is required' });
    }

    if (amount === undefined || amount === null || isNaN(Number(amount)) || Number(amount) < 0) {
      return res.status(400).json({ success: false, message: 'Valid amount is required (0 or greater)' });
    }

    const cleanSlug = sanitizeSlug(slug_link || name);
    if (!cleanSlug) {
      return res.status(400).json({ success: false, message: 'A valid slug_link is required' });
    }

    // Check duplicate slug
    const existing = await ClubEvent.findOne({ slug_link: cleanSlug });
    if (existing) {
      return res.status(409).json({
        success: false,
        message: `An event with slug "${cleanSlug}" already exists. Please choose another slug.`
      });
    }

    const validRegistration = registration && ['open', 'closed'].includes(registration.toLowerCase())
      ? registration.toLowerCase()
      : 'open';

    const validStatus = status && ['active', 'inactive'].includes(status.toLowerCase())
      ? status.toLowerCase()
      : 'active';

    const cleanTeamType = teamType === 'per_team' ? 'per_team' : 'per_head';
    let cleanPersonsCount = 1;

    if (cleanTeamType === 'per_team') {
      cleanPersonsCount = Math.max(1, parseInt(personsCount || maxTeamSize || minTeamSize, 10) || 2);
    }

    const newEvent = new ClubEvent({
      name: name.trim(),
      amount: Number(amount),
      registration: validRegistration,
      slug_link: cleanSlug,
      status: validStatus,
      role: role ? role.trim() : '',
      password: password ? password.trim() : '',
      teamType: cleanTeamType,
      personsCount: cleanPersonsCount,
      minTeamSize: cleanPersonsCount,
      maxTeamSize: cleanPersonsCount,
    });

    await newEvent.save();

    res.status(201).json({
      success: true,
      message: 'Club event created successfully',
      data: newEvent,
    });
  } catch (error) {
    console.error('Error creating club event:', error);
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'Slug link already in use. Please choose a unique slug.' });
    }
    res.status(500).json({ success: false, message: 'Failed to create club event', error: error.message });
  }
});

// PUT /api/club-events/:id - Update an existing event
router.put('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const { name, amount, registration, slug_link, status, role, password, teamType, personsCount, minTeamSize, maxTeamSize } = req.body;

    const event = await ClubEvent.findById(id);
    if (!event) {
      return res.status(404).json({ success: false, message: 'Club event not found' });
    }

    if (name !== undefined) {
      if (!name.trim()) {
        return res.status(400).json({ success: false, message: 'Club event name cannot be empty' });
      }
      event.name = name.trim();
    }

    if (amount !== undefined) {
      if (isNaN(Number(amount)) || Number(amount) < 0) {
        return res.status(400).json({ success: false, message: 'Valid amount is required (0 or greater)' });
      }
      event.amount = Number(amount);
    }

    if (registration !== undefined) {
      const reg = registration.toLowerCase();
      if (!['open', 'closed'].includes(reg)) {
        return res.status(400).json({ success: false, message: 'Registration must be either "open" or "closed"' });
      }
      event.registration = reg;
    }

    if (slug_link !== undefined) {
      const cleanSlug = sanitizeSlug(slug_link);
      if (!cleanSlug) {
        return res.status(400).json({ success: false, message: 'Valid slug_link is required' });
      }
      if (cleanSlug !== event.slug_link) {
        const existing = await ClubEvent.findOne({ slug_link: cleanSlug, _id: { $ne: id } });
        if (existing) {
          return res.status(409).json({
            success: false,
            message: `An event with slug "${cleanSlug}" already exists.`
          });
        }
        event.slug_link = cleanSlug;
      }
    }

    if (status !== undefined) {
      const stat = status.toLowerCase();
      if (!['active', 'inactive'].includes(stat)) {
        return res.status(400).json({ success: false, message: 'Status must be either "active" or "inactive"' });
      }
      event.status = stat;
    }

    if (role !== undefined) {
      event.role = role.trim();
    }

    if (password !== undefined) {
      event.password = password.trim();
    }

    if (teamType !== undefined) {
      const cleanTeamType = teamType === 'per_team' ? 'per_team' : 'per_head';
      event.teamType = cleanTeamType;
      if (cleanTeamType === 'per_team') {
        const count = personsCount !== undefined
          ? Math.max(1, parseInt(personsCount, 10) || 2)
          : (maxTeamSize !== undefined ? Math.max(1, parseInt(maxTeamSize, 10) || 2) : (event.personsCount || event.maxTeamSize || 2));
        event.personsCount = count;
        event.minTeamSize = count;
        event.maxTeamSize = count;
      } else {
        event.personsCount = 1;
        event.minTeamSize = 1;
        event.maxTeamSize = 1;
      }
    } else if (personsCount !== undefined) {
      const count = Math.max(1, parseInt(personsCount, 10) || 1);
      event.personsCount = count;
      event.minTeamSize = count;
      event.maxTeamSize = count;
    } else if (minTeamSize !== undefined || maxTeamSize !== undefined) {
      const minVal = minTeamSize !== undefined ? Math.max(1, parseInt(minTeamSize, 10) || 1) : (event.minTeamSize || 1);
      const maxVal = maxTeamSize !== undefined ? Math.max(minVal, parseInt(maxTeamSize, 10) || minVal) : Math.max(minVal, event.maxTeamSize || minVal);
      event.personsCount = maxVal;
      event.minTeamSize = minVal;
      event.maxTeamSize = maxVal;
    }

    await event.save();

    res.status(200).json({
      success: true,
      message: 'Club event updated successfully',
      data: event,
    });
  } catch (error) {
    console.error('Error updating club event:', error);
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'Slug link already in use. Please choose a unique slug.' });
    }
    res.status(500).json({ success: false, message: 'Failed to update club event', error: error.message });
  }
});

// DELETE /api/club-events/:id - Delete an event
router.delete('/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const deletedEvent = await ClubEvent.findByIdAndDelete(id);

    if (!deletedEvent) {
      return res.status(404).json({ success: false, message: 'Club event not found' });
    }

    res.status(200).json({
      success: true,
      message: `Club event "${deletedEvent.name}" deleted successfully`,
      data: deletedEvent,
    });
  } catch (error) {
    console.error('Error deleting club event:', error);
    res.status(500).json({ success: false, message: 'Failed to delete club event', error: error.message });
  }
});

// PATCH /api/club-events/:id/toggle-status - Quick status toggle
router.patch('/:id/toggle-status', async (req, res) => {
  try {
    const { id } = req.params;
    const event = await ClubEvent.findById(id);
    if (!event) {
      return res.status(404).json({ success: false, message: 'Club event not found' });
    }

    event.status = event.status === 'active' ? 'inactive' : 'active';
    await event.save();

    res.status(200).json({
      success: true,
      message: `Status updated to ${event.status}`,
      data: event,
    });
  } catch (error) {
    console.error('Error toggling status:', error);
    res.status(500).json({ success: false, message: 'Failed to toggle status', error: error.message });
  }
});

// PATCH /api/club-events/:id/toggle-registration - Quick registration toggle
router.patch('/:id/toggle-registration', async (req, res) => {
  try {
    const { id } = req.params;
    const event = await ClubEvent.findById(id);
    if (!event) {
      return res.status(404).json({ success: false, message: 'Club event not found' });
    }

    event.registration = event.registration === 'open' ? 'closed' : 'open';
    await event.save();

    res.status(200).json({
      success: true,
      message: `Registration updated to ${event.registration}`,
      data: event,
    });
  } catch (error) {
    console.error('Error toggling registration:', error);
    res.status(500).json({ success: false, message: 'Failed to toggle registration', error: error.message });
  }
});

// Helper to resolve event by ID or slug
const resolveEvent = async (idOrSlug) => {
  if (idOrSlug.match(/^[0-9a-fA-F]{24}$/)) {
    return await ClubEvent.findById(idOrSlug);
  }
  return await ClubEvent.findOne({ slug_link: idOrSlug.toLowerCase() });
};

// GET /api/club-events/:idOrSlug/check/:rNo - Check if student already registered for this event
router.get('/:idOrSlug/check/:rNo', async (req, res) => {
  try {
    const { idOrSlug, rNo } = req.params;
    const event = await resolveEvent(idOrSlug);

    if (!event) {
      return res.status(404).json({ success: false, message: 'Club event not found' });
    }

    const cleanRNo = rNo.toUpperCase().trim();
    const registration = await ClubEventRegistration.findOne({
      eventId: event._id,
      $or: [{ rNo: cleanRNo }, { 'teamMembers.rNo': cleanRNo }]
    });

    if (!registration) {
      return res.status(200).json({ exists: false });
    }

    // Check payment in 'clubeventrpayments' collection
    const payment = await ClubEventPayment.findOne({
      eventId: event._id,
      $or: [{ rNo: registration.rNo }, { rNo: cleanRNo }, { registrationId: registration._id }],
      paymentStatus: 'paid'
    });

    const isPaid = registration.paymentStatus === 'paid' || Boolean(payment);
    const isFree = registration.paymentStatus === 'free' || Number(event.amount) === 0;
    const isTeamMemberOnly = registration.teamType === 'per_team' && registration.rNo !== cleanRNo;

    if (isPaid || isFree) {
      return res.status(200).json({
        exists: true,
        isPaid: true,
        isFree: isFree,
        isTeamMemberOnly: isTeamMemberOnly,
        teamName: registration.teamName || '',
        leaderRNo: registration.rNo,
        message: isTeamMemberOnly
          ? `Roll number ${cleanRNo} is already registered for this event.`
          : 'Student is already registered for this event.',
        registration: registration,
        payment: payment || null
      });
    }

    // Registered but payment is pending
    return res.status(200).json({
      exists: true,
      isPaid: false,
      isPendingPayment: true,
      isTeamMemberOnly: isTeamMemberOnly,
      teamName: registration.teamName || '',
      leaderRNo: registration.rNo,
      message: isTeamMemberOnly
        ? `Roll number ${cleanRNo} is registered, but payment by team leader (${registration.rNo}) is pending.`
        : 'Student is already registered, but payment is pending.',
      registration: registration
    });
  } catch (error) {
    console.error('Error checking event registration:', error);
    res.status(500).json({ success: false, message: 'Failed to check registration status', error: error.message });
  }
});

// GET /api/club-events/:idOrSlug/registration/:rNo - Fetch registration details for payment page
router.get('/:idOrSlug/registration/:rNo', async (req, res) => {
  try {
    const { idOrSlug, rNo } = req.params;
    const event = await resolveEvent(idOrSlug);

    if (!event) {
      return res.status(404).json({ success: false, message: 'Club event not found' });
    }

    const cleanRNo = rNo.toUpperCase().trim();
    const registration = await ClubEventRegistration.findOne({
      eventId: event._id,
      rNo: cleanRNo
    });

    if (!registration) {
      return res.status(404).json({
        success: false,
        message: `No registration found for roll number ${cleanRNo} in this event.`
      });
    }

    // Check if payment already exists in 'clubeventrpayments'
    const payment = await ClubEventPayment.findOne({
      eventId: event._id,
      rNo: cleanRNo,
      paymentStatus: 'paid'
    });

    const isPaid = registration.paymentStatus === 'paid' || Boolean(payment);

    res.status(200).json({
      success: true,
      event: event,
      registration: registration,
      payment: payment || null,
      isPaid: isPaid,
      amount: event.amount
    });
  } catch (error) {
    console.error('Error fetching student registration:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch registration details', error: error.message });
  }
});

// POST /api/club-events/:idOrSlug/register - Step 1: STORE REGISTRATION DETAILS ONLY in 'clubeventregistrations'
router.post('/:idOrSlug/register', async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const { studentData } = req.body;

    const event = await resolveEvent(idOrSlug);

    if (!event) {
      return res.status(404).json({ success: false, message: 'Club event not found' });
    }

    if (event.registration === 'closed') {
      return res.status(400).json({ success: false, message: 'Registration for this event is currently closed.' });
    }

    if (event.status === 'inactive') {
      return res.status(400).json({ success: false, message: 'This event is currently inactive.' });
    }

    if (!studentData) {
      return res.status(400).json({ success: false, message: 'Registration details are required.' });
    }

    const isTeamEvent = event.teamType === 'per_team';

    // Handle Team Event Registration
    if (isTeamEvent) {
      const { teamMembers } = studentData;
      const teamName = (studentData.teamName || '').trim();

      if (!Array.isArray(teamMembers) || teamMembers.length === 0) {
        return res.status(400).json({ success: false, message: 'Team members list is required.' });
      }

      const minMembers = 1;
      const maxMembers = event.maxTeamSize || event.personsCount || 10;

      if (teamMembers.length < minMembers || teamMembers.length > maxMembers) {
        return res.status(400).json({
          success: false,
          message: `This event accepts between 1 and ${maxMembers} participants (received ${teamMembers.length}).`
        });
      }

      // Validate each member and check for duplicates within the submitted team
      const sanitizedMembers = [];
      const seenRolls = new Set();

      for (let i = 0; i < teamMembers.length; i++) {
        const m = teamMembers[i];
        const rNo = (m.rNo || '').toUpperCase().trim();
        const name = (m.name || '').trim();
        const email = (m.email || '').trim();
        const branch = (m.branch || '').trim();
        const phone = String(m.phone || '').trim();
        const gender = (m.gender || '').trim();
        const bloodgroup = (m.bloodgroup || '').trim();

        if (!rNo || !name || !email || !branch || !phone || !gender) {
          return res.status(400).json({
            success: false,
            message: `All fields (Roll number, Name, Email, Branch, Gender, Phone number) are required for Team Member ${i + 1} (${name || rNo || 'Unnamed'}).`
          });
        }

        if (seenRolls.has(rNo)) {
          return res.status(400).json({
            success: false,
            message: `Roll number ${rNo} is entered multiple times in this team.`
          });
        }
        seenRolls.add(rNo);

        sanitizedMembers.push({
          rNo,
          name,
          email,
          branch,
          phone,
          gender,
          bloodgroup,
          isLeader: i === 0,
        });
      }

      const allMemberRolls = Array.from(seenRolls);
      const leader = sanitizedMembers[0];

      // Check if leader or any member is already registered for this event
      const existingRegistrations = await ClubEventRegistration.find({
        eventId: event._id,
        $or: [
          { rNo: { $in: allMemberRolls } },
          { 'teamMembers.rNo': { $in: allMemberRolls } }
        ]
      });

      if (existingRegistrations && existingRegistrations.length > 0) {
        // If it's only the leader updating while payment is pending, allow update
        const isLeaderSelfUpdate = existingRegistrations.length === 1 &&
          existingRegistrations[0].rNo === leader.rNo &&
          existingRegistrations[0].paymentStatus === 'pending';

        if (isLeaderSelfUpdate) {
          const leaderReg = existingRegistrations[0];
          leaderReg.teamName = teamName.trim();
          leaderReg.teamSize = sanitizedMembers.length;
          leaderReg.teamMembers = sanitizedMembers;
          leaderReg.name = leader.name;
          leaderReg.email = leader.email;
          leaderReg.branch = leader.branch;
          leaderReg.phone = leader.phone;
          leaderReg.gender = leader.gender;
          leaderReg.bloodgroup = leader.bloodgroup;
          await leaderReg.save();

          return res.status(200).json({
            success: true,
            isExisting: true,
            isPendingPayment: true,
            message: 'Team registration details updated. Please proceed to payment.',
            data: leaderReg,
            eventAmount: event.amount
          });
        }

        // Identify which rolls clash
        const clashRolls = new Set();
        existingRegistrations.forEach(reg => {
          allMemberRolls.forEach(r => {
            if (reg.rNo === r || reg.teamMembers?.some(tm => tm.rNo === r)) {
              clashRolls.add(r);
            }
          });
        });

        return res.status(409).json({
          success: false,
          message: `The following student(s) are already registered for this event: ${Array.from(clashRolls).join(', ')}.`
        });
      }

      // Create new Team Registration
      const isFree = Number(event.amount) === 0;
      const registrationRecord = new ClubEventRegistration({
        eventId: event._id,
        eventName: event.name,
        eventSlug: event.slug_link,
        rNo: leader.rNo,
        name: leader.name,
        email: leader.email,
        branch: leader.branch,
        phone: leader.phone,
        gender: leader.gender,
        bloodgroup: leader.bloodgroup,
        teamType: 'per_team',
        teamName: teamName.trim(),
        teamSize: sanitizedMembers.length,
        teamMembers: sanitizedMembers,
        paymentStatus: isFree ? 'free' : 'pending',
      });

      await registrationRecord.save();

      return res.status(201).json({
        success: true,
        message: isFree
          ? `Team registration successfully completed for "${event.name}"!`
          : `Team registration details saved! Proceed to payment.`,
        data: registrationRecord,
        eventAmount: event.amount,
        isFree: isFree
      });
    }

    // Default: Per Head (Single Person) Registration
    if (!studentData.rNo?.trim() || !studentData.name?.trim() || !studentData.email?.trim() || !studentData.branch?.trim() || !studentData.gender?.trim() || !studentData.phone?.trim()) {
      return res.status(400).json({ success: false, message: 'All fields (Roll number, Name, Email, Branch, Gender, Phone number) are required.' });
    }

    const cleanRNo = studentData.rNo.toUpperCase().trim();

    // Check if student already registered in 'clubeventregistrations'
    const existing = await ClubEventRegistration.findOne({
      eventId: event._id,
      $or: [{ rNo: cleanRNo }, { 'teamMembers.rNo': cleanRNo }]
    });

    if (existing) {
      // If already paid, reject duplicate
      if (existing.paymentStatus === 'paid') {
        return res.status(409).json({
          success: false,
          isAlreadyPaid: true,
          message: `Roll number ${cleanRNo} has already completed registration and payment for "${event.name}".`
        });
      }

      // If pending, update any updated fields and return success to proceed to payment
      existing.name = studentData.name || existing.name;
      existing.email = studentData.email || existing.email;
      existing.branch = studentData.branch || existing.branch;
      existing.phone = studentData.phone || existing.phone;
      existing.gender = studentData.gender || existing.gender;
      existing.bloodgroup = studentData.bloodgroup || existing.bloodgroup;
      existing.teamType = 'per_head';
      existing.teamSize = 1;
      existing.teamMembers = [{
        rNo: cleanRNo,
        name: existing.name,
        email: existing.email,
        branch: existing.branch,
        phone: existing.phone,
        gender: existing.gender,
        bloodgroup: existing.bloodgroup,
        isLeader: true
      }];
      await existing.save();

      return res.status(200).json({
        success: true,
        isExisting: true,
        isPendingPayment: true,
        message: 'Registration details updated. Please proceed to payment.',
        data: existing,
        eventAmount: event.amount
      });
    }

    // New Registration: Save registration details ONLY in 'clubeventregistrations'
    const isFree = Number(event.amount) === 0;
    const registrationRecord = new ClubEventRegistration({
      eventId: event._id,
      eventName: event.name,
      eventSlug: event.slug_link,
      rNo: cleanRNo,
      name: studentData.name.trim(),
      email: studentData.email ? studentData.email.trim() : '',
      branch: studentData.branch ? studentData.branch.trim() : 'N/A',
      phone: studentData.phone ? String(studentData.phone).trim() : '',
      gender: studentData.gender ? studentData.gender.trim() : '',
      bloodgroup: studentData.bloodgroup ? studentData.bloodgroup.trim() : '',
      teamType: 'per_head',
      teamName: '',
      teamSize: 1,
      teamMembers: [{
        rNo: cleanRNo,
        name: studentData.name.trim(),
        email: studentData.email ? studentData.email.trim() : '',
        branch: studentData.branch ? studentData.branch.trim() : 'N/A',
        phone: studentData.phone ? String(studentData.phone).trim() : '',
        gender: studentData.gender ? studentData.gender.trim() : '',
        bloodgroup: studentData.bloodgroup ? studentData.bloodgroup.trim() : '',
        isLeader: true
      }],
      paymentStatus: isFree ? 'free' : 'pending',
    });

    await registrationRecord.save();

    res.status(201).json({
      success: true,
      message: isFree
        ? `Successfully registered for "${event.name}"!`
        : `Registration details saved! Proceed to payment.`,
      data: registrationRecord,
      eventAmount: event.amount,
      isFree: isFree
    });
  } catch (error) {
    console.error('Error saving event registration:', error);
    if (error.code === 11000) {
      return res.status(409).json({ success: false, message: 'Student is already registered for this event.' });
    }
    res.status(500).json({ success: false, message: 'Registration failed', error: error.message });
  }
});

// POST /api/club-events/:idOrSlug/create-order - Create Razorpay order with backend-verified event amount
router.post('/:idOrSlug/create-order', async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const { rNo } = req.body;

    const event = await resolveEvent(idOrSlug);

    if (!event) {
      return res.status(404).json({ success: false, message: 'Club event not found' });
    }

    if (event.registration === 'closed') {
      return res.status(400).json({ success: false, message: 'Registration for this event is currently closed.' });
    }

    if (event.status === 'inactive') {
      return res.status(400).json({ success: false, message: 'This event is currently inactive.' });
    }

    const eventAmount = Number(event.amount) || 0;
    if (eventAmount <= 0) {
      return res.status(400).json({ success: false, message: 'This event is free, no payment order needed.' });
    }

    const cleanRNo = rNo ? rNo.toUpperCase().trim() : 'STUDENT';

    const keyId = process.env.RAZORPAY_KEY_ID || 'YOUR_RAZORPAY_KEY_ID';

    // If using placeholder key or demo mode for development
    if (keyId === 'YOUR_RAZORPAY_KEY_ID') {
      const demoOrderId = `order_demo_${Date.now()}`;
      return res.status(200).json({
        success: true,
        orderId: demoOrderId,
        amount: Math.round(eventAmount * 100),
        currency: 'INR',
        keyId: keyId,
        isDemoMode: true
      });
    }

    const Razorpay = require('razorpay');
    const razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET,
    });

    const options = {
      amount: Math.round(eventAmount * 100), // amount in paise
      currency: 'INR',
      receipt: `club_${(event.slug_link || 'evt').substring(0, 15)}_${Date.now()}`.substring(0, 40),
      notes: {
        eventId: event._id.toString(),
        eventName: event.name,
        slug: event.slug_link,
        rollNo: cleanRNo
      }
    };

    const order = await razorpay.orders.create(options);
    res.status(200).json({
      success: true,
      orderId: order.id,
      amount: order.amount,
      currency: order.currency,
      keyId: keyId
    });
  } catch (error) {
    console.error('Error creating club event Razorpay order:', error);
    const demoOrderId = `order_fallback_${Date.now()}`;
    res.status(200).json({
      success: true,
      orderId: demoOrderId,
      amount: Math.round((event ? Number(event.amount) : 1) * 100),
      currency: 'INR',
      keyId: process.env.RAZORPAY_KEY_ID || 'YOUR_RAZORPAY_KEY_ID'
    });
  }
});

// POST /api/club-events/:idOrSlug/record-payment - Step 2: STORE PAYMENT IN SEPARATE 'clubeventrpayments' COLLECTION
router.post('/:idOrSlug/record-payment', async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const {
      rNo,
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      paymentMethod = 'razorpay'
    } = req.body;

    const event = await resolveEvent(idOrSlug);

    if (!event) {
      return res.status(404).json({ success: false, message: 'Club event not found' });
    }

    if (!rNo) {
      return res.status(400).json({ success: false, message: 'Roll number is required to record payment.' });
    }

    const cleanRNo = rNo.toUpperCase().trim();

    // Find student registration in 'clubeventregistrations'
    const registration = await ClubEventRegistration.findOne({
      eventId: event._id,
      rNo: cleanRNo
    });

    if (!registration) {
      return res.status(404).json({
        success: false,
        message: `Registration record not found for roll number ${cleanRNo}. Please register first.`
      });
    }

    const paymentTxnId = razorpay_payment_id || `txn_${Date.now()}`;

    // 1. Immediately store payment record in separate collection 'clubeventrpayments'
    const paymentRecord = new ClubEventPayment({
      eventId: event._id,
      eventName: event.name,
      eventSlug: event.slug_link,
      registrationId: registration._id,
      rNo: cleanRNo,
      name: registration.name,
      email: registration.email || '',
      branch: registration.branch,
      phone: registration.phone,
      amount: Number(event.amount) || 0,
      currency: 'INR',
      teamName: registration.teamName || '',
      teamSize: registration.teamSize || 1,
      razorpayOrderId: razorpay_order_id || null,
      razorpayPaymentId: paymentTxnId,
      razorpaySignature: razorpay_signature || null,
      transactionId: paymentTxnId,
      paymentStatus: 'paid',
      paymentMethod: paymentMethod,
    });

    await paymentRecord.save();

    // 2. Update registration in 'clubeventregistrations' to mark as paid
    registration.paymentStatus = 'paid';
    registration.paymentId = paymentRecord._id;
    registration.amountPaid = Number(event.amount) || 0;
    registration.razorpayPaymentId = paymentTxnId;
    registration.razorpayOrderId = razorpay_order_id || null;
    await registration.save();

    res.status(201).json({
      success: true,
      message: 'Payment recorded successfully into separate payments collection!',
      data: {
        payment: paymentRecord,
        registration: registration
      }
    });
  } catch (error) {
    console.error('Error recording club event payment:', error);
    res.status(500).json({ success: false, message: 'Failed to record payment', error: error.message });
  }
});

// Helper to query Razorpay REST API for a single payment ID
const fetchRazorpayPayment = async (paymentId) => {
  const keyId = process.env.RAZORPAY_KEY_ID || 'YOUR_RAZORPAY_KEY_ID';
  const keySecret = process.env.RAZORPAY_KEY_SECRET || '';
  if (!keyId || keyId === 'YOUR_RAZORPAY_KEY_ID') return null;

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  try {
    const res = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { 'Authorization': `Basic ${auth}` }
    });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.error('Error fetching Razorpay payment:', e);
    return null;
  }
};

// Helper to query Razorpay REST API payments list
const fetchRazorpayPaymentsList = async (count = 100) => {
  const keyId = process.env.RAZORPAY_KEY_ID || 'YOUR_RAZORPAY_KEY_ID';
  const keySecret = process.env.RAZORPAY_KEY_SECRET || '';
  if (!keyId || keyId === 'YOUR_RAZORPAY_KEY_ID') return [];

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  try {
    const res = await fetch(`https://api.razorpay.com/v1/payments?count=${count}`, {
      headers: { 'Authorization': `Basic ${auth}` }
    });
    if (!res.ok) return [];
    const data = await res.json();
    return data.items || [];
  } catch (e) {
    console.error('Error fetching Razorpay payments list:', e);
    return [];
  }
};

// POST /api/club-events/verify-razorpay-sync - Verify payment with Razorpay & update database
router.post('/verify-razorpay-sync', async (req, res) => {
  try {
    const { registrationId, rNo, razorpayPaymentId } = req.body;

    let registration;
    if (registrationId) {
      registration = await ClubEventRegistration.findById(registrationId);
    } else if (rNo) {
      registration = await ClubEventRegistration.findOne({ rNo: rNo.toUpperCase().trim() });
    }

    if (!registration) {
      return res.status(404).json({ success: false, message: 'Registration record not found.' });
    }

    const event = await ClubEvent.findById(registration.eventId);
    const cleanRNo = registration.rNo.toUpperCase().trim();

    let paymentData = null;

    // 1. If explicit Razorpay Payment ID provided
    if (razorpayPaymentId && razorpayPaymentId.trim()) {
      paymentData = await fetchRazorpayPayment(razorpayPaymentId.trim());
    }

    // 2. If registration has razorpayOrderId, fetch payments for order
    if (!paymentData && registration.razorpayOrderId) {
      const keyId = process.env.RAZORPAY_KEY_ID;
      const keySecret = process.env.RAZORPAY_KEY_SECRET;
      if (keyId && keySecret && keyId !== 'YOUR_RAZORPAY_KEY_ID') {
        const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
        try {
          const orderRes = await fetch(`https://api.razorpay.com/v1/orders/${encodeURIComponent(registration.razorpayOrderId)}/payments`, {
            headers: { 'Authorization': `Basic ${auth}` }
          });
          if (orderRes.ok) {
            const orderPayments = await orderRes.json();
            if (orderPayments.items && orderPayments.items.length > 0) {
              paymentData = orderPayments.items.find(p => p.status === 'captured' || p.status === 'authorized') || orderPayments.items[0];
            }
          }
        } catch (oErr) {
          console.warn('Order payments fetch error:', oErr);
        }
      }
    }

    // 3. Search recent Razorpay payments matching roll number in notes
    if (!paymentData) {
      const allPayments = await fetchRazorpayPaymentsList(100);
      paymentData = allPayments.find(p => {
        const notesRoll = p.notes && (p.notes.rollNo || p.notes.rNo);
        return (p.status === 'captured' || p.status === 'authorized') &&
          notesRoll && String(notesRoll).toUpperCase().trim() === cleanRNo;
      });
    }

    if (!paymentData) {
      return res.status(404).json({
        success: false,
        message: `No captured Razorpay transaction found for roll number ${cleanRNo}. Please enter payment ID manually.`
      });
    }

    if (paymentData.status !== 'captured' && paymentData.status !== 'authorized') {
      return res.status(400).json({
        success: false,
        message: `Razorpay transaction ${paymentData.id} status is "${paymentData.status}", not captured.`
      });
    }

    const paidAmount = (event && Number(event.amount) > 0)
      ? Number(event.amount)
      : Math.floor(Number(paymentData.amount) / 100);
    const txnId = paymentData.id;

    // Check if payment document exists in 'clubeventrpayments'
    let paymentRecord = await ClubEventPayment.findOne({
      $or: [
        { razorpayPaymentId: txnId },
        { transactionId: txnId },
        { eventId: registration.eventId, rNo: cleanRNo, paymentStatus: 'paid' }
      ]
    });

    if (!paymentRecord) {
      paymentRecord = new ClubEventPayment({
        eventId: registration.eventId,
        eventName: registration.eventName,
        eventSlug: registration.eventSlug,
        registrationId: registration._id,
        rNo: cleanRNo,
        name: registration.name,
        email: registration.email || paymentData.email || '',
        branch: registration.branch,
        phone: registration.phone || paymentData.contact || 'N/A',
        amount: paidAmount,
        currency: paymentData.currency || 'INR',
        razorpayOrderId: paymentData.order_id || registration.razorpayOrderId || null,
        razorpayPaymentId: txnId,
        razorpaySignature: 'verified_via_razorpay_api',
        transactionId: txnId,
        paymentStatus: 'paid',
        paymentMethod: paymentData.method || 'razorpay',
      });
      await paymentRecord.save();
    }

    // Update registration document
    registration.paymentStatus = 'paid';
    registration.paymentId = paymentRecord._id;
    registration.amountPaid = paidAmount;
    registration.razorpayPaymentId = txnId;
    if (paymentData.order_id) {
      registration.razorpayOrderId = paymentData.order_id;
    }
    await registration.save();

    res.status(200).json({
      success: true,
      message: `Successfully verified and recorded Razorpay payment (${txnId})!`,
      data: {
        registration,
        payment: paymentRecord,
        razorpayDetails: paymentData
      }
    });
  } catch (error) {
    console.error('Error verifying Razorpay sync:', error);
    res.status(500).json({ success: false, message: 'Verification error', error: error.message });
  }
});

// POST /api/club-events/sync-all-pending - Reconcile all pending registrations with Razorpay
router.post('/sync-all-pending', async (req, res) => {
  try {
    const pendingRegistrations = await ClubEventRegistration.find({ paymentStatus: 'pending' });
    if (pendingRegistrations.length === 0) {
      return res.status(200).json({ success: true, message: 'No pending registrations to sync.', syncedCount: 0 });
    }

    const allPayments = await fetchRazorpayPaymentsList(100);
    let syncedCount = 0;
    const syncedRecords = [];

    for (const registration of pendingRegistrations) {
      const cleanRNo = registration.rNo.toUpperCase().trim();
      const match = allPayments.find(p => {
        const notesRoll = p.notes && (p.notes.rollNo || p.notes.rNo);
        return (p.status === 'captured' || p.status === 'authorized') &&
          notesRoll && String(notesRoll).toUpperCase().trim() === cleanRNo;
      });

      if (match) {
        const paidAmount = (registration && Number(registration.amountPaid) > 0)
          ? Number(registration.amountPaid)
          : Math.floor(Number(match.amount) / 100);
        const txnId = match.id;

        let paymentRecord = await ClubEventPayment.findOne({
          $or: [{ razorpayPaymentId: txnId }, { transactionId: txnId }]
        });

        if (!paymentRecord) {
          paymentRecord = new ClubEventPayment({
            eventId: registration.eventId,
            eventName: registration.eventName,
            eventSlug: registration.eventSlug,
            registrationId: registration._id,
            rNo: cleanRNo,
            name: registration.name,
            email: registration.email || match.email || '',
            branch: registration.branch,
            phone: registration.phone || match.contact || 'N/A',
            amount: paidAmount,
            currency: match.currency || 'INR',
            razorpayOrderId: match.order_id || registration.razorpayOrderId || null,
            razorpayPaymentId: txnId,
            razorpaySignature: 'verified_via_razorpay_api',
            transactionId: txnId,
            paymentStatus: 'paid',
            paymentMethod: match.method || 'razorpay',
          });
          await paymentRecord.save();
        }

        registration.paymentStatus = 'paid';
        registration.paymentId = paymentRecord._id;
        registration.amountPaid = paidAmount;
        registration.razorpayPaymentId = txnId;
        if (match.order_id) registration.razorpayOrderId = match.order_id;
        await registration.save();

        syncedCount++;
        syncedRecords.push({ rNo: cleanRNo, txnId });
      }
    }

    res.status(200).json({
      success: true,
      message: `Successfully synchronized ${syncedCount} payment(s) from Razorpay!`,
      syncedCount,
      syncedRecords
    });
  } catch (error) {
    console.error('Error syncing all pending payments:', error);
    res.status(500).json({ success: false, message: 'Sync error', error: error.message });
  }
});

// GET /api/club-events/:idOrSlug/registrations - List registrations for a specific event
router.get('/:idOrSlug/registrations', async (req, res) => {
  try {
    const { idOrSlug } = req.params;
    const event = await resolveEvent(idOrSlug);

    if (!event) {
      return res.status(404).json({ success: false, message: 'Club event not found' });
    }

    const registrations = await ClubEventRegistration.find({ eventId: event._id }).sort({ createdAt: -1 });
    res.status(200).json({ success: true, count: registrations.length, data: registrations });
  } catch (error) {
    console.error('Error fetching registrations:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch registrations', error: error.message });
  }
});

module.exports = router;
