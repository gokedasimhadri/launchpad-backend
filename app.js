const path = require('path');
const dotenv = require('dotenv');
dotenv.config();
if (!process.env.MONGO_URI) {
  dotenv.config({ path: path.join(__dirname, 'env') });
}

var createError = require('http-errors');
var mongoose = require('mongoose');
var express = require('express');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var cors = require('cors');

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');
var clubEventsRouter = require('./routes/clubEvents');

var app = express();

// Connect to MongoDB
if (!process.env.MONGO_URI) {
  console.error('MongoDB connection error: MONGO_URI environment variable is not defined.');
} else {
  mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Successfully connected to MongoDB'))
    .catch(err => console.error('MongoDB connection error:', err));
}
// view engine setup
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'jade');

app.use(cors());
app.use(logger('dev'));
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));

app.use('/', indexRouter);
app.use('/users', usersRouter);
app.use('/api/club-events', clubEventsRouter);

// Import Model
const Orientation = require('./models/Orientation');
const Razorpay = require('razorpay');
const crypto = require('crypto');

// Initialize Razorpay SDK
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'YOUR_RAZORPAY_KEY_ID',
  key_secret: process.env.RAZORPAY_KEY_SECRET || 'YOUR_RAZORPAY_KEY_SECRET'
});

// API Route for getting Razorpay Config
app.get('/api/payment/config', (req, res) => {
  res.status(200).json({
    keyId: process.env.RAZORPAY_KEY_ID || 'YOUR_RAZORPAY_KEY_ID',
    feeAmount: Number(process.env.ORIENTATION_FEE) || 100
  });
});

// API Route to Create Razorpay Order
app.post('/api/payment/create-order', async (req, res) => {
  try {
    const { amount, rNo, slug, eventId } = req.body;
    let feeAmount = 0;

    // If for a club event, ALWAYS verify and check amount from database
    if (slug || eventId) {
      const ClubEvent = require('./models/ClubEvent');
      const query = eventId ? { _id: eventId } : { slug_link: String(slug).toLowerCase() };
      const cEvent = await ClubEvent.findOne(query);
      if (cEvent) {
        feeAmount = Number(cEvent.amount) || 0;
      }
    }

    if (!feeAmount) {
      feeAmount = amount || Number(process.env.ORIENTATION_FEE) || 100;
    }
    const keyId = process.env.RAZORPAY_KEY_ID || 'YOUR_RAZORPAY_KEY_ID';

    // If using placeholder key, return fallback demo order for development testing
    if (keyId === 'YOUR_RAZORPAY_KEY_ID') {
      const demoOrderId = `order_demo_${Date.now()}`;
      return res.status(200).json({
        success: true,
        orderId: demoOrderId,
        amount: Math.round(feeAmount * 100),
        currency: 'INR',
        keyId: keyId,
        isDemoMode: true
      });
    }

    // Amount in paise (1 INR = 100 paise)
    const options = {
      amount: Math.round(feeAmount * 100),
      currency: 'INR',
      receipt: `receipt_${(rNo || 'student').replace(/[^a-zA-Z0-9]/g, '')}_${Date.now()}`.substring(0, 40),
      notes: {
        rollNo: rNo || 'N/A',
        purpose: 'Orientation Student Enrollment'
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
    console.error('Error creating Razorpay order:', error);
    // Fallback if Razorpay API fails due to unverified keys
    const demoOrderId = `order_fallback_${Date.now()}`;
    res.status(200).json({
      success: true,
      orderId: demoOrderId,
      amount: Math.round((amount || 100) * 100),
      currency: 'INR',
      keyId: process.env.RAZORPAY_KEY_ID || 'YOUR_RAZORPAY_KEY_ID',
      isDemoMode: true
    });
  }
});


// API Route to Verify Razorpay Payment and Save Orientation Record
app.post('/api/payment/verify-payment', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      studentData
    } = req.body;

    // Verify HMAC signature if secret is provided and valid
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (keySecret && keySecret !== 'YOUR_RAZORPAY_KEY_SECRET') {
      const generatedSignature = crypto
        .createHmac('sha256', keySecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');

      if (generatedSignature !== razorpay_signature) {
        return res.status(400).json({ success: false, message: 'Invalid payment signature verification failed.' });
      }
    }

    // Check duplicate student roll number
    if (studentData && studentData.rNo) {
      const existingEntry = await Orientation.findOne({ rNo: studentData.rNo.toUpperCase() });
      if (existingEntry) {
        return res.status(409).json({ success: false, message: 'This roll number has already been registered.' });
      }
    }

    // Save student orientation data with payment details
    const amountPaid = Number(process.env.ORIENTATION_FEE) || 100;
    const newOrientation = new Orientation({
      rNo: studentData.rNo.toUpperCase(),
      name: studentData.name,
      branch: studentData.branch,
      phone: studentData.phone,
      attendanceCount: parseInt(studentData.attendanceCount, 10) || 1,
      razorpayOrderId: razorpay_order_id || `order_demo_${Date.now()}`,
      razorpayPaymentId: razorpay_payment_id || `pay_demo_${Date.now()}`,
      paymentStatus: 'paid',
      amountPaid: amountPaid
    });

    await newOrientation.save();

    res.status(201).json({
      success: true,
      message: 'Payment verified and registration completed successfully!',
      data: newOrientation
    });
  } catch (error) {
    console.error('Error verifying payment:', error);
    res.status(500).json({ success: false, message: 'Failed to process payment registration', error: error.message });
  }
});

// Webhook endpoint to receive payment.captured events directly from Razorpay servers
app.post('/api/webhooks/razorpay', async (req, res) => {
  try {
    const eventPayload = req.body;
    if (eventPayload && eventPayload.event === 'payment.captured' && eventPayload.payload?.payment?.entity) {
      const paymentEntity = eventPayload.payload.payment.entity;
      const notes = paymentEntity.notes || {};
      const rNo = (notes.rollNo || notes.rNo || '').toUpperCase().trim();
      const eventId = notes.eventId;

      if (rNo) {
        const ClubEventRegistration = require('./models/ClubEventRegistration');
        const ClubEventPayment = require('./models/ClubEventPayment');

        let registration;
        if (eventId) {
          registration = await ClubEventRegistration.findOne({ eventId, rNo });
        } else {
          registration = await ClubEventRegistration.findOne({ rNo, paymentStatus: 'pending' });
        }

        if (registration) {
          const txnId = paymentEntity.id;
          const paidAmount = Number(paymentEntity.amount) / 100 || 0;

          let paymentRecord = await ClubEventPayment.findOne({ razorpayPaymentId: txnId });
          if (!paymentRecord) {
            paymentRecord = new ClubEventPayment({
              eventId: registration.eventId,
              eventName: registration.eventName,
              eventSlug: registration.eventSlug,
              registrationId: registration._id,
              rNo: rNo,
              name: registration.name,
              email: registration.email || paymentEntity.email || '',
              branch: registration.branch,
              phone: registration.phone || paymentEntity.contact || '',
              amount: paidAmount,
              currency: paymentEntity.currency || 'INR',
              razorpayOrderId: paymentEntity.order_id || null,
              razorpayPaymentId: txnId,
              razorpaySignature: 'razorpay_webhook_event',
              transactionId: txnId,
              paymentStatus: 'paid',
              paymentMethod: paymentEntity.method || 'razorpay',
            });
            await paymentRecord.save();
          }

          registration.paymentStatus = 'paid';
          registration.paymentId = paymentRecord._id;
          registration.amountPaid = paidAmount;
          registration.razorpayPaymentId = txnId;
          if (paymentEntity.order_id) registration.razorpayOrderId = paymentEntity.order_id;
          await registration.save();

          console.log(`[Webhook] Reconciled payment ${txnId} for roll number ${rNo}`);
        }
      }
    }
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('Error handling Razorpay webhook:', err);
    res.status(200).json({ status: 'error', message: err.message });
  }
});



// ==================== 2 RUPEES PAYMENT ENDPOINTS ====================

// API Route for getting Razorpay Config (2 Rupees Page)
app.get('/api/payment/config-2', (req, res) => {
  res.status(200).json({
    keyId: process.env.RAZORPAY_KEY_ID || 'YOUR_RAZORPAY_KEY_ID',
    feeAmount: Number(process.env.ORIENTATION_FEE_2) || 2
  });
});

// API Route to Create Razorpay Order (2 Rupees Page)
app.post('/api/payment/create-order-2', async (req, res) => {
  try {
    const { amount, rNo } = req.body;
    const feeAmount = amount || Number(process.env.ORIENTATION_FEE_2) || 2;
    const keyId = process.env.RAZORPAY_KEY_ID || 'YOUR_RAZORPAY_KEY_ID';

    // If using placeholder key, return fallback demo order for development testing
    if (keyId === 'YOUR_RAZORPAY_KEY_ID') {
      const demoOrderId = `order_demo_${Date.now()}`;
      return res.status(200).json({
        success: true,
        orderId: demoOrderId,
        amount: Math.round(feeAmount * 100),
        currency: 'INR',
        keyId: keyId,
        isDemoMode: true
      });
    }

    // Amount in paise (1 INR = 100 paise)
    const options = {
      amount: Math.round(feeAmount * 100),
      currency: 'INR',
      receipt: `receipt_${(rNo || 'student').replace(/[^a-zA-Z0-9]/g, '')}_${Date.now()}`.substring(0, 40),
      notes: {
        rollNo: rNo || 'N/A',
        purpose: 'Orientation Student Enrollment'
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
    console.error('Error creating Razorpay order:', error);
    // Fallback if Razorpay API fails due to unverified keys
    const demoOrderId = `order_fallback_${Date.now()}`;
    res.status(200).json({
      success: true,
      orderId: demoOrderId,
      amount: Math.round((amount || Number(process.env.ORIENTATION_FEE_2) || 2) * 100),
      currency: 'INR',
      keyId: process.env.RAZORPAY_KEY_ID || 'YOUR_RAZORPAY_KEY_ID',
      isDemoMode: true
    });
  }
});

// API Route to Verify Razorpay Payment and Save Orientation Record (2 Rupees Page)
app.post('/api/payment/verify-payment-2', async (req, res) => {
  try {
    const {
      razorpay_order_id,
      razorpay_payment_id,
      razorpay_signature,
      studentData
    } = req.body;

    // Verify HMAC signature if secret is provided and valid
    const keySecret = process.env.RAZORPAY_KEY_SECRET;

    if (keySecret && keySecret !== 'YOUR_RAZORPAY_KEY_SECRET') {
      const generatedSignature = crypto
        .createHmac('sha256', keySecret)
        .update(`${razorpay_order_id}|${razorpay_payment_id}`)
        .digest('hex');

      if (generatedSignature !== razorpay_signature) {
        return res.status(400).json({ success: false, message: 'Invalid payment signature verification failed.' });
      }
    }

    // Check duplicate student roll number
    if (studentData && studentData.rNo) {
      const existingEntry = await Orientation.findOne({ rNo: studentData.rNo.toUpperCase() });
      if (existingEntry) {
        return res.status(409).json({ success: false, message: 'This roll number has already been registered.' });
      }
    }

    // Save student orientation data with payment details
    const amountPaid = Number(process.env.ORIENTATION_FEE_2) || 2;
    const newOrientation = new Orientation({
      rNo: studentData.rNo.toUpperCase(),
      name: studentData.name,
      branch: studentData.branch,
      phone: studentData.phone,
      attendanceCount: parseInt(studentData.attendanceCount, 10) || 1,
      razorpayOrderId: razorpay_order_id || `order_demo_${Date.now()}`,
      razorpayPaymentId: razorpay_payment_id || `pay_demo_${Date.now()}`,
      paymentStatus: 'paid',
      amountPaid: amountPaid
    });

    await newOrientation.save();

    res.status(201).json({
      success: true,
      message: 'Payment verified and registration completed successfully!',
      data: newOrientation
    });
  } catch (error) {
    console.error('Error verifying payment (2 Rupees):', error);
    res.status(500).json({ success: false, message: 'Failed to process payment registration', error: error.message });
  }
});


// API Route for submitting orientation data

app.post('/api/orientation', async (req, res) => {
  try {
    const existingEntry = await Orientation.findOne({ rNo: req.body.rNo });
    if (existingEntry) {
      return res.status(409).json({ message: 'This roll number has already been submitted.' });
    }

    const newOrientation = new Orientation(req.body);
    await newOrientation.save();
    res.status(201).json({ message: 'Orientation data saved successfully!', data: newOrientation });
  } catch (error) {
    console.error('Error saving data:', error);
    res.status(500).json({ message: 'Failed to save data', error: error.message });
  }
});

// API Route for checking if orientation data exists
app.get('/api/orientation/check/:rNo', async (req, res) => {
  try {
    const existingEntry = await Orientation.findOne({ rNo: req.params.rNo.toUpperCase() });
    if (existingEntry) {
      return res.status(200).json({ exists: true });
    }
    return res.status(200).json({ exists: false });
  } catch (error) {
    console.error('Error checking duplicate:', error);
    res.status(500).json({ message: 'Failed to check data', error: error.message });
  }
});

// API Route for fetching student data from Aditya API with API key
app.get('/api/student/:rNo', async (req, res) => {
  try {
    const { rNo } = req.params;
    const apiKey = process.env.STUDENT_API_KEY || process.env.VITE_STUDENT_API_KEY || '';
    const studentApiUrl = process.env.STUDENT_API_URL || 'https://info.aec.edu.in/adityaapi/api/studentdata';

    const headers = {};
    if (apiKey) {
      headers['X-API-Key'] = apiKey;
    }

    const response = await fetch(`${studentApiUrl}/${encodeURIComponent(rNo.toUpperCase().trim())}`, {
      headers
    });

    const data = await response.json();
    return res.status(response.status).json(data);
  } catch (error) {
    console.error('Error proxying student data:', error);
    return res.status(500).json({ message: 'Failed to fetch student data', error: error.message });
  }
});

// API Route for fetching all orientation data
app.get('/api/orientation', async (req, res) => {
  try {
    const { date } = req.query;
    let matchQuery = {};

    if (date) {
      const targetDate = new Date(date);
      const startOfDay = new Date(targetDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(targetDate);
      endOfDay.setHours(23, 59, 59, 999);

      matchQuery = {
        createdAt: { $gte: startOfDay, $lte: endOfDay }
      };
    }

    const orientations = await Orientation.find(matchQuery).sort({ createdAt: -1 });
    res.status(200).json(orientations);
  } catch (error) {
    console.error('Error fetching data:', error);
    res.status(500).json({ message: 'Failed to fetch data', error: error.message });
  }
});

// API Route for Login
app.post('/api/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const cleanUser = (username || '').trim();
    const cleanPass = (password || '').trim();

    // 1. Admin login (Dean)
    if (cleanUser === 'dean' && cleanPass === 'Aditya@123') {
      return res.status(200).json({
        success: true,
        message: 'Login successful',
        role: 'admin',
        username: 'dean',
        allowedPages: ['dashboard', 'students', 'club-events', 'registrations']
      });
    }

    // 2. Club Event Manager role login
    const ClubEvent = require('./models/ClubEvent');
    if (cleanUser && cleanPass) {
      const clubEvent = await ClubEvent.findOne({
        role: new RegExp(`^${cleanUser}$`, 'i')
      });

      if (clubEvent && clubEvent.comparePassword(cleanPass)) {
        if (clubEvent.status === 'inactive') {
          return res.status(403).json({
            success: false,
            message: `The account for event "${clubEvent.name}" is currently inactive.`
          });
        }

        // Auto-migrate legacy plain text password to bcrypt hash on login
        if (!clubEvent.password.startsWith('$2a$') && !clubEvent.password.startsWith('$2b$')) {
          clubEvent.password = cleanPass;
          await clubEvent.save();
        }

        return res.status(200).json({
          success: true,
          message: `Logged in as ${clubEvent.role || clubEvent.name}`,
          role: 'club_manager',
          username: clubEvent.role,
          clubEventId: clubEvent._id,
          clubEventSlug: clubEvent.slug_link,
          clubEventName: clubEvent.name,
          allowedPages: ['club-events', 'registrations']
        });
      }
    }

    return res.status(401).json({ success: false, message: 'Invalid role/username or password' });
  } catch (err) {
    console.error('Login error:', err);
    return res.status(500).json({ success: false, message: 'Server error during login' });
  }
});

// API Route for Statistics
app.get('/api/statistics', async (req, res) => {
  try {
    const { date } = req.query;
    let matchStage = {};
    let targetDate = new Date();

    if (date) {
      targetDate = new Date(date);
      const startOfDay = new Date(targetDate);
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date(targetDate);
      endOfDay.setHours(23, 59, 59, 999);

      matchStage = {
        createdAt: { $gte: startOfDay, $lte: endOfDay }
      };
    }

    const basePipeline = Object.keys(matchStage).length > 0 ? [{ $match: matchStage }] : [];

    const totalStudents = await Orientation.countDocuments(matchStage);

    const totalAttendedAgg = await Orientation.aggregate([
      ...basePipeline,
      { $group: { _id: null, totalAttended: { $sum: "$attendanceCount" } } }
    ]);
    const totalAttended = totalAttendedAgg.length > 0 ? totalAttendedAgg[0].totalAttended : 0;

    // Group by branch and count
    const branchStats = await Orientation.aggregate([
      ...basePipeline,
      { $group: { _id: "$branch", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // Format the branch stats for easier frontend usage
    const formattedBranchStats = branchStats.map(stat => ({
      name: stat._id,
      count: stat.count
    }));

    // Group by day of week for weekly chart
    const daysMap = { 1: 'Sun', 2: 'Mon', 3: 'Tue', 4: 'Wed', 5: 'Thu', 6: 'Fri', 7: 'Sat' };
    const dayOrder = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

    const weeklyStats = await Orientation.aggregate([
      ...basePipeline,
      {
        $group: {
          _id: { $dayOfWeek: "$createdAt" },
          count: { $sum: 1 }
        }
      }
    ]);

    const weeklyMap = {};
    weeklyStats.forEach(item => {
      const dayName = daysMap[item._id];
      if (dayName) weeklyMap[dayName] = item.count;
    });

    const weeklyData = dayOrder.map(day => ({
      name: day,
      attendance: weeklyMap[day] || 0
    }));

    // Group by hour for today's hourly chart (or target date)
    const startOfTargetDay = new Date(targetDate);
    startOfTargetDay.setHours(0, 0, 0, 0);
    const endOfTargetDay = new Date(targetDate);
    endOfTargetDay.setHours(23, 59, 59, 999);

    const hourlyStats = await Orientation.aggregate([
      {
        $match: {
          createdAt: { $gte: startOfTargetDay, $lte: endOfTargetDay }
        }
      },
      {
        $group: {
          _id: { $hour: "$createdAt" },
          count: { $sum: 1 }
        }
      }
    ]);

    const slots = [
      { label: '9 AM', hours: [7, 8, 9, 10] },
      { label: '11 AM', hours: [11, 12] },
      { label: '1 PM', hours: [13, 14] },
      { label: '3 PM', hours: [15, 16] },
      { label: '5 PM', hours: [17, 18] },
      { label: '7 PM', hours: [19, 20] },
      { label: '9 PM', hours: [21, 22, 23] }
    ];

    const hourlyMap = {};
    hourlyStats.forEach(item => {
      const hour = item._id;
      const slot = slots.find(s => s.hours.includes(hour));
      if (slot) {
        hourlyMap[slot.label] = (hourlyMap[slot.label] || 0) + item.count;
      }
    });

    const hourlyData = slots.map(slot => ({
      name: slot.label,
      attendance: hourlyMap[slot.label] || 0
    }));

    res.status(200).json({
      totalStudents,
      totalAttended,
      branchStats: formattedBranchStats,
      weeklyData,
      hourlyData
    });
  } catch (error) {
    console.error('Error fetching statistics:', error);
    res.status(500).json({ message: 'Failed to fetch statistics', error: error.message });
  }
});

// catch 404 and forward to error handler
app.use(function (req, res, next) {
  next(createError(404));
});

// error handler
app.use(function (err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
