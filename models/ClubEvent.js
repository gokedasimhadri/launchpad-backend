const mongoose = require('mongoose');

const clubEventSchema = new mongoose.Schema(
  {
    name: {
      type: String,
      required: [true, 'Club event name is required'],
      trim: true,
    },
    amount: {
      type: Number,
      required: [true, 'Amount is required'],
      min: [0, 'Amount cannot be negative'],
      default: 0,
    },
    registration: {
      type: String,
      enum: ['open', 'closed'],
      default: 'open',
      lowercase: true,
      trim: true,
    },
    slug_link: {
      type: String,
      required: [true, 'Slug link is required'],
      unique: true,
      trim: true,
      lowercase: true,
    },
    status: {
      type: String,
      enum: ['active', 'inactive'],
      default: 'active',
      lowercase: true,
      trim: true,
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ClubEvent', clubEventSchema);
