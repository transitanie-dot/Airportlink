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

  const phoneCode = booking.phone_code || booking.phoneCode || '';
  const phoneNumber = booking.phone_number || booking.phoneNumber || '';
  const fullPhone = phoneCode || phoneNumber ? `+${phoneCode}${phoneNumber ? ` ${phoneNumber}` : ''}`.trim() : '';

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
        phone_code: phoneCode,
        phone_number: phoneNumber,
        phone: fullPhone,
        notes: booking.notes || '',
        pickup: booking.pickup || '',
        dropoff: booking.dropoff || '',
        booking_date: booking.booking_date || booking.date || '',
        booking_time: booking.booking_time || booking.time || '',
        passengers: String(booking.passengers || ''),
        price: String(booking.price || amount || ''),
        distance_km: String(booking.distance_km || booking.distance || ''),
        duration_minutes: String(booking.duration_minutes || booking.duration || ''),
        status: 'paid'
      },
      payment_intent_data: {
        metadata: {
          email: booking.email || '',
          full_name: booking.full_name || booking.fullName || '',
          phone_code: phoneCode,
          phone_number: phoneNumber,
          phone: fullPhone,
          notes: booking.notes || '',
          pickup: booking.pickup || '',
          dropoff: booking.dropoff || '',
          booking_date: booking.booking_date || booking.date || '',
          booking_time: booking.booking_time || booking.time || ''
        }
      }
    });

    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/confirm-payment', async (req, res) => {
  const { session_id } = req.body;

  if (!session_id) {
    return res.status(400).json({ error: 'Missing session_id' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);

    return res.json({
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      customer_email: session.customer_email || null,
      amount_total: session.amount_total || null,
      currency: session.currency || null
    });
  } catch (error) {
    console.error('Confirm payment error:', error);
    return res.status(500).json({ error: error.message });
  }
});

app.post('/api/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];

  if (!sig) {
    return res.status(400).send('Missing Stripe signature');
  }

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      req.body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const md = session.metadata || {};

    const bookingRow = {
      user_id: null,
      full_name: md.full_name || null,
      phone_code: md.phone_code || null,
      phone_number: md.phone_number || null,
      phone: md.phone || null,
      notes: md.notes || null,
      pickup: md.pickup || null,
      dropoff: md.dropoff || null,
      booking_date: md.booking_date || null,
      booking_time: md.booking_time || null,
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
