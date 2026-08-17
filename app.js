require('dotenv').config();
var createError = require('http-errors');
var mongoose = require('mongoose');
var express = require('express');
var path = require('path');
var cookieParser = require('cookie-parser');
var logger = require('morgan');
var cors = require('cors');

var indexRouter = require('./routes/index');
var usersRouter = require('./routes/users');

var app = express();

// Connect to MongoDB
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log('Successfully connected to MongoDB'))
.catch(err => console.error('MongoDB connection error:', err));
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
    const orientations = await Orientation.find().sort({ createdAt: -1 });
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
    const totalStudents = await Orientation.countDocuments();
    
    // Group by branch and count
    const branchStats = await Orientation.aggregate([
      { $group: { _id: "$branch", count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    // Format the branch stats for easier frontend usage
    const formattedBranchStats = branchStats.map(stat => ({
      name: stat._id,
      count: stat.count
    }));

    res.status(200).json({
      totalStudents,
      branchStats: formattedBranchStats
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
