import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is required');
if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL is required');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is required');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Stripe-Signature']
}));

app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

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
              description: `${booking.passengers} passengers, ${booking.distance_km ?? booking.distance ?? ''} km, ${booking.duration_minutes ?? booking.duration ?? ''} min`
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
        email: booking.email || '',
        full_name: booking.full_name || booking.fullName || '',
        pickup: booking.pickup || '',
        dropoff: booking.dropoff || '',
        booking_date: booking.booking_date || booking.date || '',
        passengers: String(booking.passengers || ''),
        price: String(booking.price || amount || ''),
        distance_km: String(booking.distance_km || booking.distance || ''),
        duration_minutes: String(booking.duration_minutes || booking.duration || ''),
        status: 'paid'
      },
      payment_intent_data: {
        metadata: {
          email: booking.email || '',
          pickup: booking.pickup || '',
          dropoff: booking.dropoff || ''
        }
      }
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const md = session.metadata || {};

    const bookingRow = {
      user_id: null,
      pickup: md.pickup || null,
      dropoff: md.dropoff || null,
      booking_date: md.booking_date || null,
      passengers: md.passengers ? parseInt(md.passengers, 10) : null,
      price: md.price ? Number(md.price) : null,
      distance_km: md.distance_km ? Number(md.distance_km) : null,
      duration_minutes: md.duration_minutes ? parseInt(md.duration_minutes, 10) : null,
      status: md.status || 'paid',
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: session.payment_intent || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      email: md.email || null
    };

    const { error } = await supabase.from('bookings').insert(bookingRow);

    if (error) {
      console.error('Supabase insert error:', error);
      return res.status(500).send(`Supabase error: ${error.message}`);
    }
  }

  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
