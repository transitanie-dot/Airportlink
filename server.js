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
if (!process.env.GOOGLE_SERVER_API_KEY) throw new Error('GOOGLE_SERVER_API_KEY is required');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ============================================================
// Pricing — espelha o calculador do frontend. Esta é a FONTE DE
// VERDADE: o valor enviado pelo browser nunca é usado para cobrar,
// apenas para mostrar uma estimativa antes disto correr.
// ============================================================

const EXCHANGE_RATES = {
  EUR: 1.0, USD: 1.08, GBP: 0.85, BRL: 6.2, CAD: 1.48, AUD: 1.65,
  CHF: 0.97, JPY: 165, NOK: 11.5, SEK: 11.3, DKK: 7.45, NZD: 1.78,
  MXN: 18.5, ZAR: 20.0, AED: 3.95, SAR: 4.05
};

// Moedas sem subunidade. https://docs.stripe.com/currencies#zero-decimal
const ZERO_DECIMAL_CURRENCIES = ['JPY'];

// Domínios autorizados a chamar esta API. 'origin: *' deixava
// qualquer site do mundo criar sessões de pagamento em teu nome.
const ALLOWED_ORIGINS = [
  'https://www.airportlink.app',
  'https://airportlink.app',
  'https://www.theepictours.com',
  // Os embeds HTML do Wix correm em filesusr.com.
  /\.filesusr\.com$/,
  /\.wixsite\.com$/,
  /\.editorx\.io$/
];

function originAllowed(origin) {
  if (!origin) return true; // pedidos server-to-server e curl
  return ALLOWED_ORIGINS.some(function (rule) {
    return rule instanceof RegExp ? rule.test(new URL(origin).hostname) : rule === origin;
  });
}

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
  origin: function (origin, callback) {
    if (originAllowed(origin)) return callback(null, true);
    console.warn('CORS bloqueado:', origin);
    return callback(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Stripe-Signature']
}));

app.use(express.static('public'));

// O webhook precisa do corpo cru para validar a assinatura,
// por isso este middleware tem de vir antes do express.json().
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

app.get('/', (req, res) => res.send('Backend is running'));

app.get('/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ============================================================
// REGISTER — cria user no Supabase Auth + registo em contacts
//
// NOTA: /api/login foi removido. O login passou a ser feito
// diretamente contra o Supabase a partir do browser, que devolve um
// JWT — este endpoint não devolvia token nenhum e ficou órfão.
// ============================================================
app.post('/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({
        success: false,
        message: 'Name, email and password are required.'
      });
    }

    if (String(password).length < 8) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 8 characters.'
      });
    }

    const { data: authData, error: authError } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: { full_name: name }
    });

    if (authError || !authData?.user) {
      console.error('Auth error:', authError);
      return res.status(400).json({
        success: false,
        message: authError?.message || 'Could not create account.'
      });
    }

    // upsert por email: a contacts não tem primary key em id e pode
    // já existir uma linha de quem reservou sem criar conta.
    const { error: contactError } = await supabase
      .from('contacts')
      .upsert({
        id: authData.user.id,
        full_name: name,
        email: email,
        phone_number: phone || null,
        is_admin: false
      }, { onConflict: 'email' });

    if (contactError) {
      console.error('Contacts upsert error:', contactError);
      return res.status(500).json({
        success: false,
        message: 'Account created but profile setup failed. Please contact support.'
      });
    }

    res.json({ success: true });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({
      success: false,
      message: err.message || 'Could not create account.'
    });
  }
});

// ============================================================
// CHECKOUT
// ============================================================
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
    ({ distanceKm, durationMinutes, isPortugalRoute } =
      await getDistanceAndDuration(booking.pickup, booking.dropoff));
  } catch (error) {
    console.error('Directions error:', error);
    return res.status(400).json({ error: 'Could not calculate the route for this pickup/dropoff.' });
  }

  const priceEUR = computePriceEUR(distanceKm, passengers, isPortugalRoute);
  const priceInCurrency = priceEUR * EXCHANGE_RATES[currency];
  const amount = toStripeAmount(priceInCurrency, currency);

  const phoneCode = booking.phone_code || booking.phoneCode || '';
  const phoneNumber = booking.phone_number || booking.phoneNumber || '';
  const fullPhone = phoneCode || phoneNumber
    ? `+${phoneCode}${phoneNumber ? ` ${phoneNumber}` : ''}`.trim()
    : '';

  const metadata = {
    email: booking.email || '',
    user_id: booking.user_id || '',
    full_name: booking.full_name || booking.fullName || '',
    phone_code: phoneCode,
    phone_number: phoneNumber,
    phone: fullPhone,
    currency: currency || '',
    notes: booking.notes || '',
    flight_number: booking.flight_number || booking.flightNumber || '',
    pickup: booking.pickup || '',
    dropoff: booking.dropoff || '',
    booking_date: booking.booking_date || booking.date || '',
    booking_time: booking.booking_time || booking.time || '',
    passengers: String(passengers),
    price: String(priceInCurrency.toFixed(2)),
    distance_km: String(distanceKm.toFixed(1)),
    duration_minutes: String(durationMinutes),
    status: 'paid'
  };

  try {
    const descriptionParts = [
      `${passengers} passengers`,
      `${distanceKm.toFixed(1)} km`,
      `${durationMinutes} min`
    ];
    if (metadata.flight_number) descriptionParts.push(`Flight ${metadata.flight_number}`);

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: currency.toLowerCase(),
          product_data: {
            name: `Transfer: ${booking.pickup} to ${booking.dropoff}`,
            description: descriptionParts.join(', ')
          },
          unit_amount: amount
        },
        quantity: 1
      }],
      success_url: 'https://www.airportlink.app/success?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://www.airportlink.app/?cancel=true',
      customer_email: booking.email,
      metadata,
      payment_intent_data: { metadata }
    });

    // Devolvemos o URL, não o sessionId. O calculador corre num iframe
    // e o Stripe recusa ser carregado dentro de frames — o redirect
    // tem de ser feito com window.top.location.href a partir do
    // cliente. O redirectToCheckout do Stripe.js está depreciado.
    res.json({ url: session.url, sessionId: session.id });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/confirm-payment', async (req, res) => {
  const { session_id } = req.body;
  if (!session_id) return res.status(400).json({ error: 'Missing session_id' });

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);

    // charges deixou de vir expandido por omissão nas versões
    // recentes da API. latest_charge é o caminho atual.
    const paymentIntent =
      typeof session.payment_intent === 'string'
        ? await stripe.paymentIntents.retrieve(session.payment_intent, { expand: ['latest_charge'] })
        : null;

    const charge = paymentIntent?.latest_charge || null;

    return res.json({
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      customer_email: session.customer_email || session.customer_details?.email || null,
      customer: typeof session.customer === 'string' ? session.customer : null,
      amount_total: session.amount_total || null,
      currency: session.currency || null,
      payment_intent_id: typeof session.payment_intent === 'string' ? session.payment_intent : null,
      receipt_url: charge?.receipt_url || null,
      payment_method_type: charge?.payment_method_details?.type || null
    });
  } catch (error) {
    console.error('Confirm payment error:', error);
    return res.status(500).json({ error: error.message });
  }
});

// ============================================================
// WEBHOOK — a única coisa que escreve em bookings.
// Usa a service_role key, que ignora a RLS. É por isso que o
// browser não tem política de INSERT nessa tabela: sem isto,
// qualquer pessoa forjava uma reserva paga.
// ============================================================
app.post('/api/stripe-webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  if (!sig) return res.status(400).send('Missing Stripe signature');

  let event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      req.body, sig, process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const md = session.metadata || {};

    let charge = null;
    if (typeof session.payment_intent === 'string') {
      try {
        const pi = await stripe.paymentIntents.retrieve(
          session.payment_intent, { expand: ['latest_charge'] }
        );
        charge = pi.latest_charge || null;
      } catch (e) {
        console.error('PaymentIntent retrieve error:', e);
      }
    }

    // Se o cliente não estava autenticado, tenta ligar a reserva à
    // conta pelo email para que apareça no /myaccount dele.
    let userId = md.user_id || null;
    if (!userId && md.email) {
      const { data: contact } = await supabase
        .from('contacts').select('id').ilike('email', md.email).maybeSingle();
      if (contact?.id) userId = contact.id;
    }

    const bookingRow = {
      user_id: userId,
      full_name: md.full_name || null,
      phone_code: md.phone_code || null,
      phone_number: md.phone_number || null,
      phone: md.phone || null,
      currency: md.currency || session.currency || null,
      notes: md.notes || null,
      flight_number: md.flight_number || null,
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
      receipt_url: charge?.receipt_url || null,
      payment_method_type: charge?.payment_method_details?.type || null,
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

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
