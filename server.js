import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { sendBookingConfirmation } from './emailService.js';

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

const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.airportlink.app';
const FREE_CANCELLATION_HOURS = Number(process.env.FREE_CANCELLATION_HOURS || 24);

// Os agentes têm uma janela mais generosa. É uma das condições do
// programa de parceria e não custa dinheiro.
const AGENT_CANCELLATION_HOURS = Number(process.env.AGENT_CANCELLATION_HOURS || 12);
const DEFAULT_AGENT_COMMISSION = Number(process.env.DEFAULT_AGENT_COMMISSION || 12);

const FX_MARGIN = Number(process.env.FX_MARGIN || 0.02);

const FALLBACK_RATES = {
  EUR: 1.0,
  USD: 1.168,
  GBP: 0.856,
  BRL: 6.02,
  CAD: 1.608,
  AUD: 1.639,
  CHF: 0.936,
  JPY: 185.7,
  NOK: 10.95,
  SEK: 11.04,
  DKK: 7.46,
  NZD: 1.953,
  MXN: 19.76,
  ZAR: 18.8,
  AED: 4.29,
  SAR: 4.38
};

const SUPPORTED_CURRENCIES = Object.keys(FALLBACK_RATES);
const USD_PEGS = { AED: 3.6725, SAR: 3.75 };
const ZERO_DECIMAL_CURRENCIES = ['JPY'];

let ratesCache = {
  rates: { ...FALLBACK_RATES },
  fetchedAt: 0,
  source: 'fallback'
};

const RATES_TTL_MS = 6 * 60 * 60 * 1000;

async function loadExchangeRates() {
  if (Date.now() - ratesCache.fetchedAt < RATES_TTL_MS) {
    return ratesCache;
  }

  try {
    const response = await fetch(
      'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
      { signal: AbortSignal.timeout(8000) }
    );

    if (!response.ok) {
      throw new Error(`ECB HTTP ${response.status}`);
    }

    const xml = await response.text();
    const parsed = { EUR: 1.0 };
    const pattern = /currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g;

    let match;
    while ((match = pattern.exec(xml)) !== null) {
      parsed[match[1]] = parseFloat(match[2]);
    }

    if (!parsed.USD) {
      throw new Error('ECB response missing USD');
    }

    for (const [code, peg] of Object.entries(USD_PEGS)) {
      parsed[code] = parsed.USD * peg;
    }

    const rates = {};
    for (const code of SUPPORTED_CURRENCIES) {
      rates[code] = parsed[code] || FALLBACK_RATES[code];
    }

    ratesCache = {
      rates,
      fetchedAt: Date.now(),
      source: 'ecb'
    };

    console.log('Exchange rates updated from ECB');
  } catch (error) {
    console.error('ECB rates error, keeping previous values:', error.message);

    ratesCache = {
      rates: ratesCache.rates,
      fetchedAt: Date.now() - RATES_TTL_MS + 15 * 60 * 1000,
      source: ratesCache.source === 'ecb' ? 'ecb-stale' : 'fallback'
    };
  }

  return ratesCache;
}

function convertFromEUR(amountEUR, currency, rates) {
  const rate = rates[currency];

  if (!rate) {
    return null;
  }

  return amountEUR * rate * (currency === 'EUR' ? 1 : 1 + FX_MARGIN);
}

function passengerMultiplier(count) {
  const passengers = Math.max(
    1,
    Math.min(16, parseInt(count || '1', 10) || 1)
  );

  if (passengers <= 4) return 1.0;
  if (passengers <= 8) return 1.5;
  if (passengers <= 12) return 2.0;
  return 2.5;
}

function toStripeAmount(amount, currencyCode) {
  const code = (currencyCode || 'EUR').toUpperCase();

  return ZERO_DECIMAL_CURRENCIES.includes(code)
    ? Math.round(amount)
    : Math.round(amount * 100);
}

function computePriceEUR(distanceKm, passengers, isPortugalRoute) {
  const pricing = isPortugalRoute
    ? {
        BASE_FARE: 40,
        PRICE_PER_KM: 1.6,
        MIN_PRICE: 25,
        PRICE_MARKUP: 1.0
      }
    : {
        BASE_FARE: 20,
        PRICE_PER_KM: 3.5,
        MIN_PRICE: 25,
        PRICE_MARKUP: 1.3
      };

  const price =
    (pricing.BASE_FARE + distanceKm * pricing.PRICE_PER_KM) *
    pricing.PRICE_MARKUP *
    passengerMultiplier(passengers);

  return price < pricing.MIN_PRICE ? pricing.MIN_PRICE : price;
}

async function getDistanceAndDuration(pickup, dropoff) {
  const url = new URL('https://maps.googleapis.com/maps/api/directions/json');

  url.searchParams.set('origin', pickup);
  url.searchParams.set('destination', dropoff);
  url.searchParams.set('mode', 'driving');
  url.searchParams.set('key', process.env.GOOGLE_SERVER_API_KEY);

  const response = await fetch(url.toString());
  const data = await response.json();

  if (data.status !== 'OK' || !data.routes?.[0]?.legs?.[0]) {
    throw new Error(`Could not calculate route: ${data.status}`);
  }

  const leg = data.routes[0].legs[0];

  return {
    distanceKm: leg.distance.value / 1000,
    durationMinutes: Math.round(leg.duration.value / 60),
    isPortugalRoute:
      (pickup || '').toLowerCase().includes('portugal') &&
      (dropoff || '').toLowerCase().includes('portugal')
  };
}

// ============================================================
// IDENTIDADE E AGENTES
//
// A margem do agente é SEMPRE calculada aqui, a partir do JWT. Se
// viesse do browser, qualquer pessoa reclamava 12% de desconto.
// ============================================================

async function getUserFromRequest(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');

  if (!token) {
    return null;
  }

  const { data, error } = await supabase.auth.getUser(token);

  if (error || !data?.user) {
    return null;
  }

  return data.user;
}

async function getApprovedAgent(user) {
  if (!user) {
    return null;
  }

  // travel_agents é a tabela das AGÊNCIAS. A contacts continua a ser
  // a das pessoas — o agente tem linha nas duas.
  const { data, error } = await supabase
    .from('travel_agents')
    .select('id, email, contact_name, agency_name, status, commission')
    .eq('id', user.id)
    .maybeSingle();

  if (error || !data || data.status !== 'approved') {
    return null;
  }

  const pct = Number(data.commission);

  return {
    ...data,
    commission: Number.isFinite(pct) && pct > 0 && pct < 100
      ? pct
      : DEFAULT_AGENT_COMMISSION
  };
}

async function requireAdmin(req) {
  const user = await getUserFromRequest(req);

  if (!user) {
    return null;
  }

  const { data, error } = await supabase
    .from('contacts')
    .select('id, email, is_admin')
    .eq('id', user.id)
    .maybeSingle();

  if (error || !data || data.is_admin !== true) {
    return null;
  }

  return user;
}

const ALLOWED_ORIGINS = [
  SITE_ORIGIN,
  'https://airportlink.app',
  'https://www.theepictours.com',
  /\.filesusr\.com$/,
  /\.wixsite\.com$/,
  /\.editorx\.io$/
];

function originAllowed(origin) {
  if (!origin) return true;

  let host;
  try {
    host = new URL(origin).hostname;
  } catch {
    return false;
  }

  return ALLOWED_ORIGINS.some((rule) =>
    rule instanceof RegExp ? rule.test(host) : rule === origin
  );
}

app.use(cors({
  origin(origin, callback) {
    if (originAllowed(origin)) {
      return callback(null, true);
    }

    console.warn('CORS blocked:', origin);
    return callback(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Stripe-Signature']
}));

app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.send('Backend is running');
});

app.get('/health', async (req, res) => {
  const { source, fetchedAt } = await loadExchangeRates();

  res.json({
    ok: true,
    time: new Date().toISOString(),
    ratesSource: source,
    ratesAgeSeconds: Math.round((Date.now() - fetchedAt) / 1000)
  });
});

app.get('/api/exchange-rates', async (req, res) => {
  const { rates, source } = await loadExchangeRates();
  const withMargin = {};

  for (const [code, rate] of Object.entries(rates)) {
    withMargin[code] = code === 'EUR' ? 1 : rate * (1 + FX_MARGIN);
  }

  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    base: 'EUR',
    source,
    rates: withMargin
  });
});

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

    const { data: authData, error: authError } =
      await supabase.auth.admin.createUser({
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

    const { error: contactError } = await supabase
      .from('contacts')
      .upsert({
        id: authData.user.id,
        full_name: name,
        email,
        phone_number: phone || null,
        is_admin: false
      }, {
        onConflict: 'email'
      });

    if (contactError) {
      console.error('Contacts upsert error:', contactError);

      return res.status(500).json({
        success: false,
        message: 'Account created but profile setup failed. Please contact support.'
      });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error('Register error:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Could not create account.'
    });
  }
});

app.post('/api/create-checkout-session', async (req, res) => {
  const { booking } = req.body;

  if (!booking || !booking.pickup || !booking.dropoff || !booking.email) {
    return res.status(400).json({
      error: 'Missing pickup, dropoff or email'
    });
  }

  const passengers = parseInt(booking.passengers, 10) || 1;
  const currency = (booking.currency || 'EUR').toUpperCase();
  const { rates } = await loadExchangeRates();

  if (!rates[currency]) {
    return res.status(400).json({ error: 'Unsupported currency' });
  }

  let distanceKm;
  let durationMinutes;
  let isPortugalRoute;

  try {
    ({
      distanceKm,
      durationMinutes,
      isPortugalRoute
    } = await getDistanceAndDuration(booking.pickup, booking.dropoff));
  } catch (error) {
    console.error('Directions error:', error);

    return res.status(400).json({
      error: 'Could not calculate the route for this pickup/dropoff.'
    });
  }

  const priceEUR = computePriceEUR(
    distanceKm,
    passengers,
    isPortugalRoute
  );

  // Se quem pede for um agente aprovado, aplica-se a margem dele.
  // O browser não tem palavra nenhuma nisto.
  const requester = await getUserFromRequest(req);
  const agent = await getApprovedAgent(requester);
  const commission = agent ? agent.commission : 0;
  const netPriceEUR = priceEUR * (1 - commission / 100);

  const grossInCurrency = convertFromEUR(priceEUR, currency, rates);
  const priceInCurrency = convertFromEUR(netPriceEUR, currency, rates);

  const amount = toStripeAmount(priceInCurrency, currency);

  const phoneCode = booking.phone_code || booking.phoneCode || '';
  const phoneNumber = booking.phone_number || booking.phoneNumber || '';

  const fullPhone = (phoneCode || phoneNumber)
    ? `+${phoneCode}${phoneNumber ? ` ${phoneNumber}` : ''}`.trim()
    : '';

  const metadata = {
    email: booking.email || '',
    user_id: booking.user_id || '',
    full_name: booking.full_name || booking.fullName || '',
    phone_code: phoneCode,
    phone_number: phoneNumber,
    phone: fullPhone,
    currency,
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
    status: 'paid',
    booked_by: agent ? agent.id : '',
    agent_commission_pct: agent ? String(commission) : '',
    agent_gross_price: agent ? String(grossInCurrency.toFixed(2)) : '',
    passenger_name: booking.passenger_name || '',
    passenger_email: booking.passenger_email || '',
    passenger_phone: booking.passenger_phone || ''
  };

  try {
    const parts = [
      `${passengers} passengers`,
      `${distanceKm.toFixed(1)} km`,
      `${durationMinutes} min`
    ];

    if (metadata.flight_number) {
      parts.push(`Flight ${metadata.flight_number}`);
    }

    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode: 'payment',
      line_items: [{
        price_data: {
          currency: currency.toLowerCase(),
          product_data: {
            name: `Transfer: ${booking.pickup} to ${booking.dropoff}`,
            description: parts.join(', ')
          },
          unit_amount: amount
        },
        quantity: 1
      }],
      success_url: `${SITE_ORIGIN}/success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${SITE_ORIGIN}/?cancel=true`,
      customer_email: booking.email,
      metadata,
      payment_intent_data: { metadata }
    });

    return res.json({
      url: session.url,
      sessionId: session.id,
      agent: agent
        ? { commission, agency_name: agent.agency_name }
        : null
    });
  } catch (error) {
    console.error('Stripe error:', error);

    return res.status(500).json({
      error: error.message
    });
  }
});

app.post('/api/confirm-payment', async (req, res) => {
  const { session_id } = req.body;

  if (!session_id) {
    return res.status(400).json({ error: 'Missing session_id' });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);

    const paymentIntent = typeof session.payment_intent === 'string'
      ? await stripe.paymentIntents.retrieve(
          session.payment_intent,
          { expand: ['latest_charge'] }
        )
      : null;

    const charge = paymentIntent?.latest_charge || null;

    return res.json({
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      customer_email:
        session.customer_email ||
        session.customer_details?.email ||
        null,
      amount_total: session.amount_total || null,
      currency: session.currency || null,
      receipt_url: charge?.receipt_url || null,
      payment_method_type: charge?.payment_method_details?.type || null
    });
  } catch (error) {
    console.error('Confirm payment error:', error);

    return res.status(500).json({
      error: error.message
    });
  }
});

app.post('/api/cancel-booking', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({ error: 'Not signed in' });
    }

    const { booking_id } = req.body;

    if (!booking_id) {
      return res.status(400).json({ error: 'Missing booking_id' });
    }

    const { data: booking, error: bookingError } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', booking_id)
      .maybeSingle();

    if (bookingError || !booking) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const owns =
      booking.user_id === user.id ||
      booking.booked_by === user.id ||
      String(booking.email || '').toLowerCase() ===
        String(user.email || '').toLowerCase();

    if (!owns) {
      return res.status(403).json({
        error: 'This booking is not yours'
      });
    }

    if (booking.status === 'cancelled') {
      return res.status(400).json({
        error: 'This booking is already cancelled'
      });
    }

    const pickupAt = new Date(
      `${booking.booking_date}T${booking.booking_time || '00:00'}`
    );

    const hoursUntil = (pickupAt.getTime() - Date.now()) / 36e5;

    // Agentes têm 12 horas em vez de 24, mas só nas reservas que
    // eles próprios fizeram.
    const agent = await getApprovedAgent(user);
    const windowHours = (agent && booking.booked_by === user.id)
      ? AGENT_CANCELLATION_HOURS
      : FREE_CANCELLATION_HOURS;

    if (!Number.isFinite(hoursUntil)) {
      return res.status(400).json({
        error: 'This booking has no valid pick-up time. Please contact support.'
      });
    }

    if (hoursUntil < windowHours) {
      return res.status(400).json({
        error:
          `Free cancellation closes ${windowHours} hours before pick-up. ` +
          'Please contact support.'
      });
    }

    let refundId = null;

    if (booking.stripe_payment_intent_id) {
      try {
        const refund = await stripe.refunds.create({
          payment_intent: booking.stripe_payment_intent_id,
          reason: 'requested_by_customer'
        });

        refundId = refund.id;
      } catch (error) {
        console.error('Refund error:', error);

        return res.status(502).json({
          error: 'We could not process the refund automatically. Please contact support.'
        });
      }
    }

    const { error: updateError } = await supabase
      .from('bookings')
      .update({
        status: 'cancelled',
        payment_status: refundId
          ? 'refunded'
          : booking.payment_status,
        updated_at: new Date().toISOString()
      })
      .eq('id', booking_id);

    if (updateError) {
      console.error('Cancel update error:', updateError);

      return res.status(500).json({
        error:
          'The refund was issued but the booking status could not be updated. ' +
          'Please contact support.'
      });
    }

    return res.json({
      success: true,
      refunded: Boolean(refundId)
    });
  } catch (error) {
    console.error('Cancel booking error:', error);

    return res.status(500).json({
      error: 'Something went wrong. Please contact support.'
    });
  }
});

// ============================================================
// PROGRAMA DE AGENTES
// ============================================================

app.get('/api/agent/me', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({ error: 'Not signed in' });
    }

    const { data, error } = await supabase
      .from('travel_agents')
      .select(
        'id, email, contact_name, agency_name, agency_vat, agency_country, ' +
        'agency_website, agency_phone, note, status, commission, applied_at'
      )
      .eq('id', user.id)
      .maybeSingle();

    if (error) throw error;

    // Sem linha na tabela significa que nunca se candidatou. Não
    // existe estado 'none' guardado — a ausência é o estado.
    return res.json({
      email: user.email,
      status: data?.status || 'none',
      commission: data?.status === 'approved'
        ? Number(data.commission || DEFAULT_AGENT_COMMISSION)
        : null,
      agency_name: data?.agency_name || null,
      cancellation_hours: AGENT_CANCELLATION_HOURS,
      profile: data || null
    });
  } catch (error) {
    console.error('agent/me error:', error);

    return res.status(500).json({
      error: 'Could not load your agent status.'
    });
  }
});

// Cria SEMPRE o estado 'pending'. A aprovação é manual e só o
// service role a pode escrever, porque a coluna está revogada ao
// papel authenticated.
app.post('/api/agent/apply', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({ error: 'Please sign in first.' });
    }

    const {
      agency_name,
      agency_vat,
      agency_country,
      agency_website,
      agency_phone,
      note,
      full_name
    } = req.body || {};

    if (!agency_name || !agency_country || !agency_phone) {
      return res.status(400).json({
        error: 'Agency name, country and phone are required.'
      });
    }

    const { data: existing } = await supabase
      .from('travel_agents')
      .select('status')
      .eq('id', user.id)
      .maybeSingle();

    if (existing?.status === 'approved') {
      return res.status(400).json({
        error: 'Your agency is already approved.'
      });
    }

    if (existing?.status === 'pending') {
      return res.status(400).json({
        error: 'Your application is already under review.'
      });
    }

    // O agente continua a ser uma pessoa: garantimos a linha em
    // contacts, porque bookings.email aponta para lá.
    const { error: contactError } = await supabase
      .from('contacts')
      .upsert({
        id: user.id,
        email: user.email,
        full_name: full_name || user.user_metadata?.full_name || null,
        is_admin: false
      }, {
        onConflict: 'email'
      });

    if (contactError) throw contactError;

    // O status e a commission ficam nos valores por omissão da
    // tabela: 'pending' e 12. Nunca vêm do pedido.
    const { error } = await supabase
      .from('travel_agents')
      .upsert({
        id: user.id,
        email: user.email,
        contact_name: full_name || user.user_metadata?.full_name || null,
        agency_name,
        agency_vat: agency_vat || null,
        agency_country,
        agency_website: agency_website || null,
        agency_phone,
        note: note || null,
        status: 'pending',
        applied_at: new Date().toISOString(),
        commission: DEFAULT_AGENT_COMMISSION,
        updated_at: new Date().toISOString()
      }, {
        onConflict: 'id'
      });

    if (error) throw error;

    return res.json({ success: true, status: 'pending' });
  } catch (error) {
    console.error('agent/apply error:', error);

    return res.status(500).json({
      error: 'Could not submit your application. Please try again.'
    });
  }
});

// Aprovação e recusa.
//
// Passa pelo servidor porque o SQL revoga o update das colunas
// agent_status e agent_commission ao papel authenticated — e o
// admin também é authenticated, por isso não conseguiria escrever
// a partir do browser. Uma revogação de coluna não distingue papéis.
app.post('/api/agent/review', async (req, res) => {
  try {
    const admin = await requireAdmin(req);

    if (!admin) {
      return res.status(403).json({ error: 'Administrator access required.' });
    }

    const { agent_id, decision, commission } = req.body || {};

    if (!agent_id || !['approved', 'rejected'].includes(decision)) {
      return res.status(400).json({ error: 'Missing agent_id or invalid decision.' });
    }

    const update = {
      status: decision,
      reviewed_at: new Date().toISOString(),
      reviewed_by: admin.id,
      updated_at: new Date().toISOString()
    };

    if (decision === 'approved') {
      const pct = Number(commission);
      update.commission = Number.isFinite(pct) && pct > 0 && pct < 100
        ? pct
        : DEFAULT_AGENT_COMMISSION;
    }

    const { data, error } = await supabase
      .from('travel_agents')
      .update(update)
      .eq('id', agent_id)
      .select('id, email, agency_name, status, commission')
      .single();

    if (error) throw error;

    console.log('Agent reviewed:', {
      by: admin.email,
      agent: data.email,
      decision,
      commission: data.commission
    });

    return res.json({ success: true, agent: data });
  } catch (error) {
    console.error('agent/review error:', error);

    return res.status(500).json({
      error: 'Could not update the application.'
    });
  }
});

// Edição dos dados da agência.
//
// Passa pelo servidor porque travel_agents não tem política de UPDATE
// para o papel authenticated. A lista de campos é branca de propósito:
// status e commission nunca são aceites, venham como vierem no pedido.
app.post('/api/agent/profile', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({ error: 'Not signed in' });
    }

    const { data: existing } = await supabase
      .from('travel_agents')
      .select('id, status')
      .eq('id', user.id)
      .maybeSingle();

    if (!existing) {
      return res.status(404).json({ error: 'No partner account found.' });
    }

    const {
      agency_name,
      agency_vat,
      agency_country,
      agency_phone,
      agency_website,
      contact_name
    } = req.body || {};

    if (!agency_name || !agency_country || !agency_phone) {
      return res.status(400).json({
        error: 'Agency name, country and phone are required.'
      });
    }

    const { data, error } = await supabase
      .from('travel_agents')
      .update({
        agency_name,
        agency_vat: agency_vat || null,
        agency_country,
        agency_phone,
        agency_website: agency_website || null,
        contact_name: contact_name || null,
        updated_at: new Date().toISOString()
      })
      .eq('id', user.id)
      .select('id, email, contact_name, agency_name, agency_vat, agency_country, agency_phone, agency_website, status, commission')
      .single();

    if (error) throw error;

    // O nome de contacto também vive na contacts, que é a ficha da
    // pessoa. Mantemos as duas alinhadas.
    if (contact_name) {
      await supabase.from('contacts')
        .update({ full_name: contact_name })
        .eq('id', user.id);
    }

    return res.json({ success: true, profile: data });
  } catch (error) {
    console.error('agent/profile error:', error);

    return res.status(500).json({
      error: 'Could not save your agency details.'
    });
  }
});

// Extrato mensal consolidado. O agente paga viagem a viagem; isto é
// o documento único para a contabilidade dele.
app.get('/api/agent/statement', async (req, res) => {
  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({ error: 'Not signed in' });
    }

    const agent = await getApprovedAgent(user);

    if (!agent) {
      return res.status(403).json({ error: 'Your agency is not approved yet.' });
    }

    const month = /^\d{4}-\d{2}$/.test(String(req.query.month || ''))
      ? String(req.query.month)
      : new Date().toISOString().slice(0, 7);

    const start = `${month}-01`;
    const endDate = new Date(start);
    endDate.setMonth(endDate.getMonth() + 1);
    const end = endDate.toISOString().slice(0, 10);

    const { data, error } = await supabase
      .from('bookings')
      .select(
        'id, booking_id, booking_reference, booking_date, booking_time, ' +
        'pickup, dropoff, passengers, price, agent_gross_price, ' +
        'agent_commission_pct, currency, status, full_name, ' +
        'passenger_name, flight_number'
      )
      .eq('booked_by', user.id)
      .gte('booking_date', start)
      .lt('booking_date', end)
      .order('booking_date', { ascending: true });

    if (error) throw error;

    const rows = data || [];
    const billable = rows.filter((row) => row.status !== 'cancelled');

    const net = billable.reduce(
      (sum, row) => sum + (Number(row.price) || 0),
      0
    );

    const gross = billable.reduce(
      (sum, row) => sum + (Number(row.agent_gross_price) || Number(row.price) || 0),
      0
    );

    return res.json({
      month,
      agency_name: agent.agency_name,
      agent_email: agent.email,
      commission: agent.commission,
      currency: billable[0]?.currency || 'EUR',
      bookings: rows,
      totals: {
        count: billable.length,
        gross: Number(gross.toFixed(2)),
        net: Number(net.toFixed(2)),
        saved: Number((gross - net).toFixed(2))
      }
    });
  } catch (error) {
    console.error('agent/statement error:', error);

    return res.status(500).json({
      error: 'Could not build your statement.'
    });
  }
});

app.post('/api/stripe-webhook', async (req, res) => {
  const signature = req.headers['stripe-signature'];

  if (!signature) {
    return res.status(400).send('Missing Stripe signature');
  }

  let event;

  try {
    event = await stripe.webhooks.constructEventAsync(
      req.body,
      signature,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (error) {
    return res.status(400).send(`Webhook Error: ${error.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const metadata = session.metadata || {};

    let charge = null;

    if (typeof session.payment_intent === 'string') {
      try {
        const paymentIntent = await stripe.paymentIntents.retrieve(
          session.payment_intent,
          { expand: ['latest_charge'] }
        );

        charge = paymentIntent.latest_charge || null;
      } catch (error) {
        console.error('PaymentIntent retrieve error:', error);
      }
    }

    let userId = metadata.user_id || null;

    if (!userId && metadata.email) {
      const { data: contact } = await supabase
        .from('contacts')
        .select('id')
        .ilike('email', metadata.email)
        .maybeSingle();

      if (contact?.id) {
        userId = contact.id;
      }
    }

    const bookingRow = {
      user_id: userId,
      full_name: metadata.full_name || null,
      phone_code: metadata.phone_code || null,
      phone_number: metadata.phone_number || null,
      phone: metadata.phone || null,
      currency: metadata.currency || session.currency || null,
      notes: metadata.notes || null,
      flight_number: metadata.flight_number || null,
      pickup: metadata.pickup || null,
      dropoff: metadata.dropoff || null,
      booking_date: metadata.booking_date || null,
      booking_time: metadata.booking_time || null,
      passengers: metadata.passengers
        ? parseInt(metadata.passengers, 10)
        : null,
      price: metadata.price ? Number(metadata.price) : null,
      distance_km: metadata.distance_km
        ? Number(metadata.distance_km)
        : null,
      duration_minutes: metadata.duration_minutes
        ? parseInt(metadata.duration_minutes, 10)
        : null,
      booked_by: metadata.booked_by || null,
      agent_commission_pct: metadata.agent_commission_pct
        ? Number(metadata.agent_commission_pct)
        : null,
      agent_gross_price: metadata.agent_gross_price
        ? Number(metadata.agent_gross_price)
        : null,
      passenger_name: metadata.passenger_name || null,
      passenger_email: metadata.passenger_email || null,
      passenger_phone: metadata.passenger_phone || null,
      status: metadata.status || session.payment_status || 'paid',
      payment_status: session.payment_status || null,
      amount_total: session.amount_total || null,
      stripe_customer_id: typeof session.customer === 'string'
        ? session.customer
        : null,
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id: session.payment_intent || null,
      receipt_url: charge?.receipt_url || null,
      payment_method_type: charge?.payment_method_details?.type || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      email:
        metadata.email ||
        session.customer_details?.email ||
        session.customer_email ||
        null
    };

    const { data: savedBooking, error: upsertError } = await supabase
      .from('bookings')
      .upsert(bookingRow, {
        onConflict: 'stripe_checkout_session_id'
      })
      .select()
      .single();

    if (upsertError) {
      console.error('Supabase upsert error:', upsertError);

      return res.status(500).send(
        `Supabase error: ${upsertError.message}`
      );
    }

    const recipientEmail = savedBooking.email || bookingRow.email;

    try {
      const emailResult = await sendBookingConfirmation({
        to: recipientEmail,
        booking: savedBooking
      });

      console.log('Booking confirmation email sent:', {
        bookingId: savedBooking.id,
        recipientEmail,
        resendId: emailResult?.id || null
      });
    } catch (emailError) {
      console.error('Booking confirmation email failed:', {
        bookingId: savedBooking.id,
        recipientEmail,
        error: emailError.message
      });
    }
  }

  return res.json({ received: true });
});

app.listen(PORT, async () => {
  console.log(`Server running on ${PORT}`);
  await loadExchangeRates();
});
