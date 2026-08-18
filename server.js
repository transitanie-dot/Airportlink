import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is required');
if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL is required');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is required');
if (!process.env.GOOGLE_SERVER_API_KEY) throw new Error('GOOGLE_SERVER_API_KEY is required');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================================
// Pricing — mirrors the frontend calculator exactly, so quotes
// shown to the customer match what actually gets charged. This
// is the SOURCE OF TRUTH: the amount sent by the browser is
// never trusted, only used as a display hint before this runs.
// ============================================================

const EXCHANGE_RATES = {
  EUR: 1.0, USD: 1.08, GBP: 0.85, BRL: 6.2, CAD: 1.48, AUD: 1.65,
  CHF: 0.97, JPY: 165, NOK: 11.5, SEK: 11.3, DKK: 7.45, NZD: 1.78,
  MXN: 18.5, ZAR: 20.0, AED: 3.95, SAR: 4.05
};

// Stripe treats these currencies as having no minor unit (no cents).
// Keep in sync with https://docs.stripe.com/currencies#zero-decimal
const ZERO_DECIMAL_CURRENCIES = ['JPY'];

function passengerMultiplier(count) {
  const n = Math.max(1, Math.min(16, parseInt(count || '1', 10) || 1));
  if (n <= 4) return 1.0;
  if (n <= 8) return 1.5;
  if (n <= 12) return 2.0;
  return 2.5;
}

function toStripeAmount(amountMajorUnits, currencyCode) {
  const code = (currencyCode || 'EUR').toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.includes(code)) return Math.round(amountMajorUnits);
  return Math.round(amountMajorUnits * 100);
}

function computePriceEUR(distanceKm, passengers, isPortugalRoute) {
  const pricing = isPortugalRoute
    ? { BASE_FARE: 40, PRICE_PER_KM: 1.60, MIN_PRICE: 25, PRICE_MARKUP: 1.0 }
    : { BASE_FARE: 20, PRICE_PER_KM: 3.5, MIN_PRICE: 25, PRICE_MARKUP: 1.3 };

  let priceEUR = pricing.BASE_FARE + distanceKm * pricing.PRICE_PER_KM;
  priceEUR = priceEUR * pricing.PRICE_MARKUP * passengerMultiplier(passengers);
  if (priceEUR < pricing.MIN_PRICE) priceEUR = pricing.MIN_PRICE;
  return priceEUR;
}

// Calls Google Directions API server-side — the same route calculation
// the frontend map does, but computed independently so the client can't
// spoof the distance either.
async function getDistanceAndDuration(pickupAddress, dropoffAddress) {
  const url = new URL('https://maps.googleapis.com/maps/api/directions/json');
  url.searchParams.set('origin', pickupAddress);
  url.searchParams.set('destination', dropoffAddress);
  url.searchParams.set('mode', 'driving');
  url.searchParams.set('key', process.env.GOOGLE_SERVER_API_KEY);

  const response = await fetch(url.toString());
  const data = await response.json();

  if (data.status !== 'OK' || !data.routes?.[0]?.legs?.[0]) {
    throw new Error('Could not calculate route: ' + data.status);
  }

  const leg = data.routes[0].legs[0];
  return {
    distanceKm: leg.distance.value / 1000,
    durationMinutes: Math.round(leg.duration.value / 60),
    isPortugalRoute:
      (pickupAddress || '').toLowerCase().includes('portugal') &&
      (dropoffAddress || '').toLowerCase().includes('portugal')
  };
}

app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Stripe-Signature']
}));

app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// Serve arquivos estáticos da pasta public/
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.send('Backend is running');
});

app.post('/api/create-checkout-session', async (req, res) => {
  const { booking } = req.body;

  if (!booking || !booking.pickup || !booking.dropoff || !booking.email) {
    return res.status(400).json({ error: 'Missing pickup, dropoff or email' });
  }

  const passengers = parseInt(booking.passengers, 10) || 1;
  const currency = (booking.currency || req.body.currency || 'EUR').toUpperCase();

  if (!EXCHANGE_RATES[currency]) {
    return res.status(400).json({ error: 'Unsupported currency' });
  }

  let distanceKm, durationMinutes, isPortugalRoute;
  try {
    ({ distanceKm, durationMinutes, isPortugalRoute } = await getDistanceAndDuration(booking.pickup, booking.dropoff));
  } catch (error) {
    console.error('Directions error:', error);
    return res.status(400).json({ error: 'Could not calculate the route for this pickup/dropoff.' });
  }

  // These two lines are the actual source of truth for what gets charged.
  // `req.body.amount` and `booking.price` (sent by the browser) are only
  // ever used for display purposes and are ignored here.
  const priceEUR = computePriceEUR(distanceKm, passengers, isPortugalRoute);
  const priceInCurrency = priceEUR * EXCHANGE_RATES[currency];
  const amount = toStripeAmount(priceInCurrency, currency);

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
              description: `${passengers} passengers, ${distanceKm.toFixed(1)} km, ${durationMinutes} min`
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
        user_id: booking.user_id || '',
        full_name: booking.full_name || booking.fullName || '',
        phone_code: phoneCode,
        phone_number: phoneNumber,
        phone: fullPhone,
        currency: currency || '',
        notes: booking.notes || '',
        pickup: booking.pickup || '',
        dropoff: booking.dropoff || '',
        booking_date: booking.booking_date || booking.date || '',
        booking_time: booking.booking_time || booking.time || '',
        passengers: String(passengers),
        price: String(priceInCurrency.toFixed(2)),
        distance_km: String(distanceKm.toFixed(1)),
        duration_minutes: String(durationMinutes),
        status: 'paid'
      },
      payment_intent_data: {
        metadata: {
          email: booking.email || '',
          user_id: booking.user_id || '',
          full_name: booking.full_name || booking.fullName || '',
          phone_code: phoneCode,
          phone_number: phoneNumber,
          phone: fullPhone,
          currency: currency || '',
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

    const paymentIntent =
      typeof session.payment_intent === 'string'
        ? await stripe.paymentIntents.retrieve(session.payment_intent)
        : null;

    const firstCharge =
      paymentIntent?.charges?.data?.[0] || null;

    return res.json({
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      customer_email: session.customer_email || null,
      customer: typeof session.customer === 'string' ? session.customer : null,
      amount_total: session.amount_total || null,
      currency: session.currency || null,
      payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : null,
      receipt_url: firstCharge?.receipt_url || null,
      payment_method_type: firstCharge?.payment_method_details?.type || null
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

    let paymentIntent = null;
    let firstCharge = null;

    if (typeof session.payment_intent === 'string') {
      try {
        paymentIntent = await stripe.paymentIntents.retrieve(session.payment_intent);
        firstCharge = paymentIntent.charges?.data?.[0] || null;
      } catch (e) {
        console.error('PaymentIntent retrieve error:', e);
      }
    }

    const bookingRow = {
      user_id: md.user_id || null,
      full_name: md.full_name || null,
      phone_code: md.phone_code || null,
      phone_number: md.phone_number || null,
      phone: md.phone || null,
      currency: md.currency || session.currency || null,
      notes: md.notes || null,
      pickup: md.pickup || null,
      dropoff: md.dropoff || null,
      booking_date: md.booking_date || null,
      booking_time: md.booking_time || null,
      passengers: md.passengers ? parseInt(md.passengers, 10) : null,
      price: md.price ? Number(md.price) : null,
      distance_km: md.distance_km ? Number(md.distance_km) : null,
      duration_minutes: md.duration_minutes ? parseInt(md.duration_minutes, 10) : null,
      status: md.status || session.payment_status || 'paid',
      payment_status: session.payment_status || null,
      amount_total: session.amount_total || null,
      stripe_customer_id: typeof session.customer === 'string' ? session.customer : null,
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: session.payment_intent || null,
      receipt_url: firstCharge?.receipt_url || null,
      payment_method_type: firstCharge?.payment_method_details?.type || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      email: md.email || session.customer_details?.email || session.customer_email || null
    };

    const { error } = await supabase.from('bookings').upsert(bookingRow, {
      onConflict: 'stripe_checkout_session_id'
    });

    if (error) {
      console.error('Supabase upsert error:', error);
      return res.status(500).send(`Supabase error: ${error.message}`);
    }
  }

  res.json({ received: true });
});

app.listen(PORT, () => {
  console.log(`Server running on ${PORT}`);
});
