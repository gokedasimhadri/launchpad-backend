const express = require('express');
const router = express.Router();
const ClubEvent = require('../models/ClubEvent');
const ClubEventRegistration = require('../models/ClubEventRegistration');
const ClubEventPayment = require('../models/ClubEventPayment');

// Helper to sanitize slug
const sanitizeSlug = (slug) => {
  return String(slug || '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9-_]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
};

// GET /api/club-events - List all events with optional filters
router.get('/', async (req, res) => {
  try {
    const { status, registration, search } = req.query;
    const query = {};

    if (status && status !== 'all') {
      query.status = status.toLowerCase();
    }

    if (registration && registration !== 'all') {
      query.registration = registration.toLowerCase();
    }

    if (search && search.trim()) {
      const searchRegex = new RegExp(search.trim(), 'i');
      query.$or = [{ name: searchRegex }, { slug_link: searchRegex }];
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
    const { eventId, search, status, branch } = req.query;
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

    if (branch && branch !== 'all') {
      query.branch = new RegExp(`^${branch.trim()}$`, 'i');
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

    const rawRegistrations = await ClubEventRegistration.find(query).sort({ createdAt: -1 }).lean();

    // Fetch payments to attach accurate payment information from 'clubeventrpayments'
    const eventIds = rawRegistrations.map(r => r.eventId);
    const rNos = rawRegistrations.map(r => r.rNo);
    const payments = await ClubEventPayment.find({
      eventId: { $in: eventIds },
      rNo: { $in: rNos }
    }).lean();

    // Map payments by eventId + rNo
    const paymentMap = new Map();
    payments.forEach(p => {
      const key = `${p.eventId.toString()}_${p.rNo.toUpperCase()}`;
      // Keep the latest or paid one
      if (!paymentMap.has(key) || p.paymentStatus === 'paid') {
        paymentMap.set(key, p);
      }
    });

    // Merge payment details into each registration object
    const registrations = rawRegistrations.map(r => {
      const key = `${r.eventId.toString()}_${r.rNo.toUpperCase()}`;
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

    // Compute stats across all registrations and payments
    const allRegistrations = await ClubEventRegistration.find({}).lean();
    const allPayments = await ClubEventPayment.find({ paymentStatus: 'paid' }).lean();

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
    const { name, amount, registration, slug_link, status, role, password } = req.body;

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

    const newEvent = new ClubEvent({
      name: name.trim(),
      amount: Number(amount),
      registration: validRegistration,
      slug_link: cleanSlug,
      status: validStatus,
      role: role ? role.trim() : '',
      password: password ? password.trim() : '',
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
    const { name, amount, registration, slug_link, status, role, password } = req.body;

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
      rNo: cleanRNo
    });

    if (!registration) {
      return res.status(200).json({ exists: false });
    }

    // Check payment in 'clubeventrpayments' collection
    const payment = await ClubEventPayment.findOne({
      eventId: event._id,
      rNo: cleanRNo,
      paymentStatus: 'paid'
    });

    const isPaid = registration.paymentStatus === 'paid' || Boolean(payment);
    const isFree = registration.paymentStatus === 'free' || Number(event.amount) === 0;

    if (isPaid || isFree) {
      return res.status(200).json({
        exists: true,
        isPaid: true,
        isFree: isFree,
        message: 'Student is already registered for this event.',
        registration: registration,
        payment: payment || null
      });
    }

    // Registered but payment is pending
    return res.status(200).json({
      exists: true,
      isPaid: false,
      isPendingPayment: true,
      message: 'Student is already registered, but payment is pending.',
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

    if (!studentData || !studentData.rNo?.trim() || !studentData.name?.trim() || !studentData.email?.trim() || !studentData.branch?.trim() || !studentData.gender?.trim() || !studentData.bloodgroup?.trim() || !studentData.phone?.trim()) {
      return res.status(400).json({ success: false, message: 'All fields (Roll number, Name, Email, Branch, Gender, Blood group, Phone number) are required.' });
    }

    const cleanRNo = studentData.rNo.toUpperCase().trim();

    // Check if student already registered in 'clubeventregistrations'
    const existing = await ClubEventRegistration.findOne({
      eventId: event._id,
      rNo: cleanRNo
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
    console.error('Error saving club event registration:', error);
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
