const mongoose = require('mongoose');

const clubEventPaymentSchema = new mongoose.Schema(
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
    registrationId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'ClubEventRegistration',
      required: false,
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
      trim: true,
      default: 'N/A',
    },
    phone: {
      type: String,
      trim: true,
      default: 'N/A',
    },
    amount: {
      type: Number,
      required: true,
      default: 0,
    },
    currency: {
      type: String,
      default: 'INR',
    },
    razorpayOrderId: {
      type: String,
      trim: true,
    },
    razorpayPaymentId: {
      type: String,
      trim: true,
    },
    razorpaySignature: {
      type: String,
      trim: true,
    },
    transactionId: {
      type: String,
      trim: true,
    },
    paymentStatus: {
      type: String,
      enum: ['paid', 'pending', 'failed', 'refunded'],
      default: 'paid',
    },
    paymentMethod: {
      type: String,
      default: 'razorpay',
    },
  },
  { timestamps: true }
);

// Indexes for fast lookup
clubEventPaymentSchema.index({ eventId: 1, rNo: 1 });
clubEventPaymentSchema.index({ razorpayPaymentId: 1 });
clubEventPaymentSchema.index({ registrationId: 1 });

// Explicit collection name 'clubeventrpayments' as requested
module.exports = mongoose.model('ClubEventPayment', clubEventPaymentSchema, 'clubeventrpayments');
