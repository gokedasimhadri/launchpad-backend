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

// Import Model
const Orientation = require('./models/Orientation');

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
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (username === 'dean' && password === 'Aditya@123') {
    return res.status(200).json({ success: true, message: 'Login successful' });
  }
  return res.status(401).json({ success: false, message: 'Invalid username or password' });
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
app.use(function(req, res, next) {
  next(createError(404));
});

// error handler
app.use(function(err, req, res, next) {
  // set locals, only providing error in development
  res.locals.message = err.message;
  res.locals.error = req.app.get('env') === 'development' ? err : {};

  // render the error page
  res.status(err.status || 500);
  res.render('error');
});

module.exports = app;
