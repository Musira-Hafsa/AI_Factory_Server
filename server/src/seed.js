import 'dotenv/config';
import mongoose from 'mongoose';
import { connectDB } from './config/db.js';
import { User } from './models/User.js';
import { Ticket } from './models/Ticket.js';
import { Counter } from './models/Counter.js';

const PASSWORD = 'Passw0rd!';

const USERS = [
  { name: 'Casey Customer', email: 'customer@demo.io', role: 'customer' },
  { name: 'Alex Agent', email: 'agent@demo.io', role: 'agent', categories: ['Technical', 'Account', 'General'] },
  { name: 'Bailey Billing', email: 'billing.agent@demo.io', role: 'agent', categories: ['Billing', 'Shipping'] },
  { name: 'Dana Admin', email: 'admin@demo.io', role: 'admin' },
];

const SAMPLE_TICKETS = [
  {
    subject: 'Charged twice for the same order',
    description:
      'I was charged twice for the same order (#48213) and need one payment refunded. My card shows two identical charges of $79.99 on the same day.',
    requestedCategory: 'Billing',
  },
  {
    subject: 'Cannot log in after password reset',
    description:
      'After resetting my password I get an "invalid credentials" error every time. I have tried three different browsers. This is blocking me from placing an order.',
    requestedCategory: 'Technical',
  },
  {
    subject: 'Where is my package?',
    description:
      'My order was supposed to arrive last Tuesday and the tracking has not updated in 5 days. Can you check with the courier?',
  },
  {
    subject: 'Feature request: dark mode',
    description:
      'Just a suggestion — it would be great if the dashboard had a dark mode. No rush, just feedback.',
    requestedCategory: 'Product',
  },
];

async function run() {
  await connectDB(process.env.MONGODB_URI);

  await Promise.all([
    User.deleteMany({ email: { $in: USERS.map((u) => u.email) } }),
    Ticket.deleteMany({}),
    Counter.deleteMany({ _id: 'ticket' }),
  ]);

  const created = {};
  for (const u of USERS) {
    const user = new User(u);
    await user.setPassword(PASSWORD);
    await user.save();
    created[u.email] = user;
  }

  const customer = created['customer@demo.io'];
  for (const t of SAMPLE_TICKETS) {
    const ticket = new Ticket({
      ...t,
      customer: customer._id,
      status: 'New',
      events: [{ type: 'created', message: `Ticket created by ${customer.name}`, by: customer._id, byName: customer.name }],
    });
    await ticket.save();
  }

  console.log('\nSeed complete.\n');
  console.table(
    USERS.map((u) => ({ role: u.role, email: u.email, password: PASSWORD }))
  );
  console.log(`\n${SAMPLE_TICKETS.length} sample tickets created for ${customer.email} (all "New", awaiting triage).\n`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error('[seed] failed:', err);
  process.exit(1);
});
