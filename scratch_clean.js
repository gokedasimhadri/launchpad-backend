const mongoose = require('mongoose');
const path = require('path');
const dotenv = require('dotenv');

dotenv.config({ path: path.join(__dirname, '.env') });

const run = async () => {
  try {
    const mongoUri = process.env.MONGO_URI || 'mongodb://root:m%40y%40%408991@16.112.218.17.:27017,16.112.232.198:27017/launchpad?replicaSet=rs0&authSource=admin';
    await mongoose.connect(mongoUri);

    const ClubEventRegistration = require('./models/ClubEventRegistration');
    const ClubEventPayment = require('./models/ClubEventPayment');

    const regs = await ClubEventRegistration.find({ amountPaid: { $gt: 0 } });
    for (const r of regs) {
      if (r.amountPaid && r.amountPaid !== Math.floor(r.amountPaid)) {
        console.log(`Updating registration ${r.rNo}: ${r.amountPaid} -> ${Math.floor(r.amountPaid)}`);
        r.amountPaid = Math.floor(r.amountPaid);
        await r.save();
      }
    }

    const payments = await ClubEventPayment.find({ amount: { $gt: 0 } });
    for (const p of payments) {
      if (p.amount && p.amount !== Math.floor(p.amount)) {
        console.log(`Updating payment ${p.rNo}: ${p.amount} -> ${Math.floor(p.amount)}`);
        p.amount = Math.floor(p.amount);
        await p.save();
      }
    }

    console.log('Successfully updated all database records to net amount!');
  } catch (err) {
    console.error('Error updating amounts:', err);
  } finally {
    await mongoose.disconnect();
  }
};

run();
