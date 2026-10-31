const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

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
    role: {
      type: String,
      trim: true,
      default: '',
    },
    password: {
      type: String,
      trim: true,
      default: '',
    },
    teamType: {
      type: String,
      enum: ['per_head', 'per_team'],
      default: 'per_head',
      lowercase: true,
      trim: true,
    },
    personsCount: {
      type: Number,
      default: 1,
      min: [1, 'Persons count must be at least 1'],
    },
    minTeamSize: {
      type: Number,
      default: 1,
      min: [1, 'Minimum team size must be at least 1'],
    },
    maxTeamSize: {
      type: Number,
      default: 1,
      min: [1, 'Maximum team size must be at least 1'],
    },
  },
  { timestamps: true }
);

// Hash password before saving if modified or new
clubEventSchema.pre('save', function () {
  if (!this.isModified('password') || !this.password) {
    return;
  }

  // If already hashed with bcrypt, do not re-hash
  if (this.password.startsWith('$2a$') || this.password.startsWith('$2b$')) {
    return;
  }

  const salt = bcrypt.genSaltSync(10);
  this.password = bcrypt.hashSync(this.password, salt);
});

// Method to verify password
clubEventSchema.methods.comparePassword = function (candidatePassword) {
  if (!this.password || !candidatePassword) return false;
  // If stored password is plain text (legacy migration), check directly
  if (!this.password.startsWith('$2a$') && !this.password.startsWith('$2b$')) {
    return this.password === candidatePassword;
  }
  return bcrypt.compareSync(candidatePassword, this.password);
};

module.exports = mongoose.model('ClubEvent', clubEventSchema);
