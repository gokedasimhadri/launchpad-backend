const mongoose = require('mongoose');
const dotenv = require('dotenv');
const bcrypt = require('bcryptjs');

dotenv.config();

const ClubEvent = require('./models/ClubEvent');

const mongoUri = process.env.MONGO_URI || 'mongodb://16.112.218.17:27017,16.112.244.171:27017/launchpad?replicaSet=rs0';

async function migrate() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(mongoUri);
    console.log('Connected to MongoDB.');

    const events = await ClubEvent.find({});
    console.log(`Found ${events.length} club events.`);

    for (const evt of events) {
      if (evt.password && !evt.password.startsWith('$2a$') && !evt.password.startsWith('$2b$')) {
        console.log(`Hashing plain text password for event "${evt.name}" (role: ${evt.role})...`);
        const salt = bcrypt.genSaltSync(10);
        evt.password = bcrypt.hashSync(evt.password, salt);
        await evt.save();
        console.log(`Hashed successfully: ${evt.password}`);
      } else {
        console.log(`Event "${evt.name}" already has hashed/empty password.`);
      }
    }
  } catch (err) {
    console.error('Migration error:', err);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected.');
  }
}

migrate();
