const mongoose = require('mongoose');

const clubEventRegistrationSchema = new mongoose.Schema(
  {
    eventId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClubEvent',
      required: true,
    },
    eventName: {
      type: String,
      required: true,
      trim: true,
    },
    eventSlug: {
      type: String,
      required: true,
      trim: true,
    },
    rNo: {
      type: String,
      required: true,
      trim: true,
      uppercase: true,
    },
    name: {
      type: String,
      required: true,
      trim: true,
    },
    email: {
      type: String,
      trim: true,
      default: '',
    },
    branch: {
      type: String,
      required: true,
      trim: true,
    },
    phone: {
      type: String,
      trim: true,
      default: '',
    },
    gender: {
      type: String,
      trim: true,
      default: '',
    },
    bloodgroup: {
      type: String,
      trim: true,
      default: '',
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'paid', 'free', 'failed'],
      default: 'pending',
    },
    paymentId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClubEventPayment',
    },
    // Optional / legacy fields retained for backward-compatibility with existing documents
    amountPaid: {
      type: Number,
      default: 0,
    },
    transactionId: {
      type: String,
      trim: true,
    },
    razorpayOrderId: {
      type: String,
      trim: true,
    },
    razorpayPaymentId: {
      type: String,
      trim: true,
    },
  },
  { timestamps: true }
);

// Prevent duplicate registration for the same student in the same event
clubEventRegistrationSchema.index({ eventId: 1, rNo: 1 }, { unique: true });

// Explicit collection name 'clubeventregistrations'
module.exports = mongoose.model('ClubEventRegistration', clubEventRegistrationSchema, 'clubeventregistrations');
