const mongoose = require('mongoose');

const orientationSchema = new mongoose.Schema({
  rNo: { type: String, required: true, unique: true },
  name: { type: String, required: true },
  location: { type: String, required: false },
  branch: { type: String, required: true },
  phone: { type: String, required: true },
  attendanceCount: { type: Number, required: true },
}, { timestamps: true });

module.exports = mongoose.model('Orientation', orientationSchema);
