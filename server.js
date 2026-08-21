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

const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.airportlink.app';
const APP_ORIGIN = process.env.APP_ORIGIN || 'https://app.airportlink.app';

// Horas antes da recolha até às quais o cliente pode cancelar sozinho.
const FREE_CANCELLATION_HOURS = Number(process.env.FREE_CANCELLATION_HOURS || 24);

// ============================================================
// CÂMBIOS
//
// As taxas eram constantes no código e estavam desatualizadas em até
// 11% — o que significava cobrar abaixo do pretendido em USD, JPY,
// CAD, NZD, AED e SAR. Passam a vir do Banco Central Europeu uma vez
// por dia, com as constantes abaixo apenas como rede de segurança.
// ============================================================

// Valores de referência de agosto de 2026. Só usados se o BCE
// estiver inacessível.
const FALLBACK_RATES = {
  EUR: 1.0, USD: 1.168, GBP: 0.856, BRL: 6.02, CAD: 1.608, AUD: 1.639,
  CHF: 0.936, JPY: 185.7, NOK: 10.95, SEK: 11.04, DKK: 7.46, NZD: 1.953,
  MXN: 19.76, ZAR: 18.80, AED: 4.29, SAR: 4.38
};

const SUPPORTED_CURRENCIES = Object.keys(FALLBACK_RATES);

// O BCE não publica AED nem SAR: ambas têm paridade fixa ao dólar.
const USD_PEGS = { AED: 3.6725, SAR: 3.75 };

// Margem sobre a taxa de mercado. Entre a cotação de hoje e o dia em
// que o Stripe converte há sempre movimento, e o Stripe cobra a sua
// própria conversão. 2% é conservador.
const FX_MARGIN = Number(process.env.FX_MARGIN || 0.02);

// Moedas sem subunidade. https://docs.stripe.com/currencies#zero-decimal
const ZERO_DECIMAL_CURRENCIES = ['JPY'];

let ratesCache = { rates: { ...FALLBACK_RATES }, fetchedAt: 0, source: 'fallback' };
const RATES_TTL_MS = 6 * 60 * 60 * 1000;

async function loadExchangeRates() {
  if (Date.now() - ratesCache.fetchedAt < RATES_TTL_MS) return ratesCache;

  try {
    const response = await fetch(
      'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-daily.xml',
      { signal: AbortSignal.timeout(8000) }
    );
    if (!response.ok) throw new Error('ECB HTTP ' + response.status);

    const xml = await response.text();
    const parsed = { EUR: 1.0 };
    const pattern = /currency=['"]([A-Z]{3})['"]\s+rate=['"]([\d.]+)['"]/g;
    let match;
    while ((match = pattern.exec(xml)) !== null) {
      parsed[match[1]] = parseFloat(match[2]);
    }

    if (!parsed.USD) throw new Error('ECB response missing USD');

    for (const [code, peg] of Object.entries(USD_PEGS)) {
      parsed[code] = parsed.USD * peg;
    }

    const rates = {};
    for (const code of SUPPORTED_CURRENCIES) {
      rates[code] = parsed[code] || FALLBACK_RATES[code];
    }

    ratesCache = { rates, fetchedAt: Date.now(), source: 'ecb' };
    console.log('Exchange rates updated from ECB');
  } catch (error) {
    console.error('ECB rates error, using previous values:', error.message);
    ratesCache = {
      rates: ratesCache.rates,
      fetchedAt: Date.now() - RATES_TTL_MS + 15 * 60 * 1000, // tenta outra vez em 15 min
      source: ratesCache.source === 'ecb' ? 'ecb-stale' : 'fallback'
    };
  }

  return ratesCache;
}

function convertFromEUR(amountEUR, currency, rates) {
  const rate = rates[currency];
  if (!rate) return null;
  return amountEUR * rate * (currency === 'EUR' ? 1 : 1 + FX_MARGIN);
}

// ============================================================
// PREÇOS — fonte de verdade. O valor enviado pelo browser nunca é
// usado para cobrar, só para mostrar uma estimativa antes disto.
// ============================================================

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

// ============================================================
// CORS — 'origin: *' deixava qualquer site do mundo criar sessões
// de pagamento em teu nome.
// ============================================================
const ALLOWED_ORIGINS = [
  SITE_ORIGIN,
  APP_ORIGIN,
  'https://airportlink.app',
  'https://www.theepictours.com',
  /\.filesusr\.com$/,   // embeds HTML do Wix
  /\.wixsite\.com$/,
  /\.editorx\.io$/
];

function originAllowed(origin) {
  if (!origin) return true; // curl, server-to-server
  let hostname;
  try { hostname = new URL(origin).hostname; } catch (e) { return false; }
  return ALLOWED_ORIGINS.some((rule) =>
    rule instanceof RegExp ? rule.test(hostname) : rule === origin
  );
}

app.use(cors({
  origin(origin, callback) {
    if (originAllowed(origin)) return callback(null, true);
    console.warn('CORS blocked:', origin);
    return callback(new Error('Origin not allowed'));
  },
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Stripe-Signature']
}));

// O webhook precisa do corpo cru para validar a assinatura,
// por isso vem antes do express.json().
app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

// ============================================================
// PÁGINAS DA APLICAÇÃO
//
// A área de cliente deixa de viver dentro de iframes do Wix. Uma só
// origem elimina o silo de localStorage, a ponte de postMessage, o
// flash do tema e o scroll preso no telemóvel.
// ============================================================
app.use(express.static(path.join(__dirname, 'public'), { extensions: ['html'] }));

const PAGES = ['myaccount', 'support', 'admin'];
for (const page of PAGES) {
  app.get('/' + page, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', page + '.html'));
  });
}

app.get('/', (req, res) => res.redirect(SITE_ORIGIN));

app.get('/health', async (req, res) => {
  const { source, fetchedAt } = await loadExchangeRates();
  res.json({
    ok: true,
    time: new Date().toISOString(),
    ratesSource: source,
    ratesAge: Math.round((Date.now() - fetchedAt) / 1000) + 's'
  });
});

// ============================================================
// CÂMBIOS PARA O FRONTEND
// O calculador usa isto para mostrar o preço, para que o valor
// apresentado e o cobrado venham sempre da mesma fonte.
// ============================================================
app.get('/api/exchange-rates', async (req, res) => {
  const { rates, source } = await loadExchangeRates();
  const withMargin = {};
  for (const [code, rate] of Object.entries(rates)) {
    withMargin[code] = code === 'EUR' ? 1 : rate * (1 + FX_MARGIN);
  }
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({ base: 'EUR', source, rates: withMargin });
});

// ============================================================
// REGISTO
// ============================================================
app.post('/register', async (req, res) => {
  try {
    const { name, email, password, phone } = req.body;

    if (!name || !email || !password) {
      return res.status(400).json({ success: false, message: 'Name, email and password are required.' });
    }
    if (String(password).length < 8) {
      return res.status(400).json({ success: false, message: 'Password must be at least 8 characters.' });
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

    // upsert por email: contacts não tem primary key em id e pode já
    // existir uma linha de quem reservou sem criar conta.
    const { error: contactError } = await supabase.from('contacts').upsert({
      id: authData.user.id,
      full_name: name,
      email,
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
    res.status(500).json({ success: false, message: err.message || 'Could not create account.' });
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
  const currency = (booking.currency || 'EUR').toUpperCase();

  const { rates } = await loadExchangeRates();
  if (!rates[currency]) return res.status(400).json({ error: 'Unsupported currency' });

  let distanceKm, durationMinutes, isPortugalRoute;
  try {
    ({ distanceKm, durationMinutes, isPortugalRoute } =
      await getDistanceAndDuration(booking.pickup, booking.dropoff));
  } catch (error) {
    console.error('Directions error:', error);
    return res.status(400).json({ error: 'Could not calculate the route for this pickup/dropoff.' });
  }

  const priceEUR = computePriceEUR(distanceKm, passengers, isPortugalRoute);
  const priceInCurrency = convertFromEUR(priceEUR, currency, rates);
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
    status: 'paid'
  };

  try {
    const parts = [`${passengers} passengers`, `${distanceKm.toFixed(1)} km`, `${durationMinutes} min`];
    if (metadata.flight_number) parts.push(`Flight ${metadata.flight_number}`);

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

    // Devolvemos o URL, não o sessionId: o calculador corre num iframe
    // do Wix e o Stripe recusa ser carregado dentro de frames. O
    // redirect tem de ser window.top.location.href.
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
    const paymentIntent = typeof session.payment_intent === 'string'
      ? await stripe.paymentIntents.retrieve(session.payment_intent, { expand: ['latest_charge'] })
      : null;
    const charge = paymentIntent?.latest_charge || null;

    return res.json({
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,
      customer_email: session.customer_email || session.customer_details?.email || null,
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
// CANCELAMENTO COM REEMBOLSO
//
// Feito no servidor de propósito. O reembolso exige a chave secreta
// do Stripe e a verificação da janela de 24 horas tem de ser
// inviolável — nada disto pode viver no browser.
// ============================================================
app.post('/api/cancel-booking', async (req, res) => {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Not signed in' });

    const { data: userData, error: userError } = await supabase.auth.getUser(token);
    if (userError || !userData?.user) return res.status(401).json({ error: 'Invalid session' });

    const user = userData.user;
    const { booking_id } = req.body;
    if (!booking_id) return res.status(400).json({ error: 'Missing booking_id' });

    const { data: booking, error: bookingError } = await supabase
      .from('bookings').select('*').eq('id', booking_id).maybeSingle();

    if (bookingError || !booking) return res.status(404).json({ error: 'Booking not found' });

    // O pedido tem de ser do dono da reserva.
    const owns = booking.user_id === user.id ||
      String(booking.email || '').toLowerCase() === String(user.email || '').toLowerCase();
    if (!owns) return res.status(403).json({ error: 'This booking is not yours' });

    if (booking.status === 'cancelled') {
      return res.status(400).json({ error: 'This booking is already cancelled' });
    }

    const pickupAt = new Date(`${booking.booking_date}T${booking.booking_time || '00:00'}`);
    const hoursUntil = (pickupAt.getTime() - Date.now()) / 36e5;

    if (!isFinite(hoursUntil)) {
      return res.status(400).json({ error: 'This booking has no valid pick-up time. Please contact support.' });
    }
    if (hoursUntil < FREE_CANCELLATION_HOURS) {
      return res.status(400).json({
        error: `Free cancellation closes ${FREE_CANCELLATION_HOURS} hours before pick-up. Please contact support.`,
        hoursUntilPickup: Math.max(0, Math.round(hoursUntil))
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

    const { error: updateError } = await supabase.from('bookings').update({
      status: 'cancelled',
      payment_status: refundId ? 'refunded' : booking.payment_status,
      updated_at: new Date().toISOString()
    }).eq('id', booking_id);

    if (updateError) {
      console.error('Cancel update error:', updateError);
      return res.status(500).json({
        error: 'The refund was issued but the booking status could not be updated. Please contact support.'
      });
    }

    res.json({ success: true, refunded: Boolean(refundId), refund_id: refundId });
  } catch (error) {
    console.error('Cancel booking error:', error);
    res.status(500).json({ error: 'Something went wrong. Please contact support.' });
  }
});

// ============================================================
// WEBHOOK — a única coisa que escreve em bookings. Usa a
// service_role key, que ignora a RLS. É por isso que o browser não
// tem política de INSERT nessa tabela.
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

    // Liga a reserva à conta pelo email se o user_id não veio,
    // para que apareça no /myaccount do cliente.
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

app.listen(PORT, async () => {
  console.log(`Server running on ${PORT}`);
  await loadExchangeRates();
});
