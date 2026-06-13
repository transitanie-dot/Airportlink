import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const app = express();
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const corsOptions = {
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Stripe-Signature']
};

app.use(cors(corsOptions));
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }));

app.use((req, res, next) => {
  if (req.originalUrl === '/api/stripe-webhook') return next();
  express.json()(req, res, next);
});

app.get('/', (req, res) => {
  res.send('Backend is running');
});

app.post('/api/create-checkout-session', async (req, res) => {
  const { amount, currency, booking } = req.body;

  if (!amount || !currency || !booking) {
    return res.status(400).json({ error: 'Missing amount, currency or booking' });
  }

  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [
        {
          price_data: {
            currency: currency.toLowerCase(),
            product_data: {
              name: `Transfer: ${booking.pickup} to ${booking.dropoff}`,
              description: `${booking.passengers} passengers, ${booking.distance}`
            },
            unit_amount: amount
          },
          quantity: 1
        }
      ],
      success_url: 'https://www.airportlink.app/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://www.theepictours.com/calculator?cancel=true',
      customer_email: booking.email,
      metadata: {
        fullName: booking.fullName || '',
        email: booking.email || '',
        phone: booking.phone || '',
        pickup: booking.pickup || '',
        dropoff: booking.dropoff || '',
        date: booking.date || '',
        time: booking.time || '',
        passengers: String(booking.passengers || ''),
        distance: booking.distance || '',
        duration: booking.duration || '',
        notes: booking.notes || '',
        price: String(amount),
        currency: currency.toLowerCase()
      }
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const md = session.metadata || {};

    const { error } = await supabase.from('bookings').insert({
      stripe_session_id: session.id,
      email: md.email,
      full_name: md.fullName,
      phone: md.phone,
      pickup: md.pickup,
      dropoff: md.dropoff,
      date: md.date,
      time: md.time,
      passengers: md.passengers,
      distance: md.distance,
      duration: md.duration,
      notes: md.notes,
      price: md.price,
      currency: md.currency,
      payment_status: 'paid'
    });

    if (error) {
      return res.status(500).send(`Supabase error: ${error.message}`);
    }
  }

  res.json({ received: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on ${PORT}`));
