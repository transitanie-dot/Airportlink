import express from 'express';
import cors from 'cors';
import Stripe from 'stripe';
// O cliente e as funções de identidade vivem no supabaseclient.js.
// Antes esse ficheiro era um segundo servidor com uma cópia antiga
// da lógica; agora é o módulo partilhado que o nome sempre prometeu.
import {
  supabase,
  getUserFromRequest,
  getApprovedAgent,
  requireAdmin,
  checkConnection,
  DEFAULT_AGENT_COMMISSION
} from './supabaseclient.js';
import {
  initEmail,
  sendBookingConfirmation,
  sendCardSaved,
  sendChargeSucceeded,
  sendChargeFailed,
  sendCancellation,
  sendDriverDetails,
  sendAgentDecision,
  sendDocumentExpiring,
  sendPartnerApplicationReceived,
  sendPartnerDecision,
  sendRideConfirmedToPartner,
  previewAll,
  notifyOps
} from './emailService.js';
import { createPartnerRoutes } from './partners.js';

const app = express();
const PORT = process.env.PORT || 3000;

if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is required');
if (!process.env.SUPABASE_URL) throw new Error('SUPABASE_URL is required');
if (!process.env.SUPABASE_SERVICE_ROLE_KEY) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required');
if (!process.env.STRIPE_WEBHOOK_SECRET) throw new Error('STRIPE_WEBHOOK_SECRET is required');
if (!process.env.GOOGLE_SERVER_API_KEY) throw new Error('GOOGLE_SERVER_API_KEY is required');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
initEmail(supabase);

const SITE_ORIGIN = process.env.SITE_ORIGIN || 'https://www.airportlink.app';
const FREE_CANCELLATION_HOURS = Number(process.env.FREE_CANCELLATION_HOURS || 24);

// Os agentes têm uma janela mais generosa. É uma das condições do
// programa de parceria e não custa dinheiro.
const AGENT_CANCELLATION_HOURS = Number(process.env.AGENT_CANCELLATION_HOURS || 12);

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

// Inverso do toStripeAmount: converte o que vem do Stripe (unidades
// menores) para a unidade que guardamos na base de dados.
function fromStripeAmount(amount, currencyCode) {
  const code = (currencyCode || 'EUR').toUpperCase();

  return ZERO_DECIMAL_CURRENCIES.includes(code)
    ? Number(amount)
    : Number(amount) / 100;
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

/**
 * O aeroporto da recolha, a partir do texto que o cliente escreveu.
 *
 * É o que liga uma reserva aos parceiros que a podem fazer, por isso
 * é calculado aqui e guardado — não adivinhado depois. Procura o
 * código IATA como palavra isolada, e só depois o nome da cidade,
 * porque "Porto" aparece em "Porto Santo" e em "Portofino".
 */
let airportCache = { rows: [], at: 0 };

async function findPickupAirport(pickupText) {
  const text = String(pickupText || '');
  if (!text) return { iata: null, city: null };

  if (Date.now() - airportCache.at > 60 * 60 * 1000) {
    const { data } = await supabase.from('airports')
      .select('iata, name, city, country').eq('active', true);
    airportCache = { rows: data || [], at: Date.now() };
  }

  const upper = text.toUpperCase();
  const lower = text.toLowerCase();

  const byCode = airportCache.rows.find((a) =>
    new RegExp(`\\b${a.iata}\\b`).test(upper));
  if (byCode) return { iata: byCode.iata, city: byCode.city };

  const byName = airportCache.rows.find((a) =>
    lower.includes(a.name.toLowerCase()));
  if (byName) return { iata: byName.iata, city: byName.city };

  // A cidade só conta se o texto também disser que é um aeroporto.
  // Sem isso, um hotel em Lisboa virava recolha no aeroporto.
  if (/airport|aeroporto|a[ée]roport|flughafen|aeropuerto/i.test(text)) {
    const byCity = airportCache.rows.find((a) =>
      lower.includes(a.city.toLowerCase()));
    if (byCity) return { iata: byCity.iata, city: byCity.city };
  }

  return { iata: null, city: null };
}

/**
 * O país, a partir do texto da morada. O Google devolve o país no
 * fim da descrição, por isso olhamos para a última parte.
 *
 * Deliberadamente simples: serve para distinguir uma viagem interna
 * de uma transfronteiriça, que é a distinção que os regimes fiscais
 * fazem. Não serve para determinar imposto sozinho.
 */
const COUNTRY_NAMES = {
  'portugal': 'PT', 'spain': 'ES', 'españa': 'ES', 'france': 'FR', 'italy': 'IT',
  'italia': 'IT', 'germany': 'DE', 'deutschland': 'DE', 'netherlands': 'NL',
  'belgium': 'BE', 'united kingdom': 'GB', 'uk': 'GB', 'england': 'GB',
  'scotland': 'GB', 'wales': 'GB', 'ireland': 'IE', 'switzerland': 'CH',
  'austria': 'AT', 'greece': 'GR', 'croatia': 'HR', 'poland': 'PL',
  'czechia': 'CZ', 'czech republic': 'CZ', 'hungary': 'HU', 'denmark': 'DK',
  'sweden': 'SE', 'norway': 'NO', 'finland': 'FI', 'iceland': 'IS',
  'luxembourg': 'LU', 'malta': 'MT', 'cyprus': 'CY', 'turkey': 'TR',
  'morocco': 'MA', 'united states': 'US', 'usa': 'US', 'canada': 'CA',
  'mexico': 'MX', 'brazil': 'BR', 'brasil': 'BR'
};

function guessCountry(text) {
  const value = String(text || '').toLowerCase();
  if (!value) return null;

  const tail = value.split(',').pop().trim();
  if (COUNTRY_NAMES[tail]) return COUNTRY_NAMES[tail];

  const found = Object.keys(COUNTRY_NAMES).find((name) => value.includes(name));
  return found ? COUNTRY_NAMES[found] : null;
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
// RESERVAR AGORA, PAGAR DEPOIS
//
// O Stripe não devolve a comissão num reembolso. Guardar o cartão e
// cobrar 48 horas antes faz com que a maioria dos cancelamentos
// aconteça antes de haver cobrança nenhuma — e aí não há comissão a
// perder.
//
// As regras vivem na base de dados, não aqui: os limiares vão mudar
// com o ticket médio e não quero um deploy por causa disso.
// ============================================================

let rulesCache = { rules: null, at: 0 };

async function getPaymentRules() {
  if (rulesCache.rules && Date.now() - rulesCache.at < 5 * 60 * 1000) {
    return rulesCache.rules;
  }

  const { data } = await supabase.from('payment_rules').select('*').eq('id', 1).maybeSingle();

  const rules = data || {
    min_hours_for_later: 72,
    charge_lead_hours: 48,
    max_value_for_later: 300,
    max_km_for_later: 150,
    agents_always_later: true,
    max_charge_attempts: 3,
    retry_interval_hours: 8
  };

  rulesCache = { rules, at: Date.now() };
  return rules;
}

function hoursUntil(dateStr, timeStr) {
  const at = new Date(`${dateStr}T${timeStr || '00:00'}`);
  if (!Number.isFinite(at.getTime())) return NaN;
  return (at.getTime() - Date.now()) / 36e5;
}

/**
 * Pode esta reserva ser paga depois?
 *
 * Devolve sempre o motivo, e não só um sim ou não: o calculador
 * mostra-o ao cliente, e "não disponível" sem explicação parece uma
 * avaria.
 */
async function payLaterEligibility({ dateStr, timeStr, priceEUR, distanceKm, isAgent }) {
  const rules = await getPaymentRules();
  const hours = hoursUntil(dateStr, timeStr);

  if (isAgent && rules.agents_always_later) {
    return { allowed: true, reason: null, rules };
  }

  // As razões dizem o número concreto. "Não disponível" sem
  // explicação parece uma avaria; "a recolha é dentro de 72 horas"
  // é uma regra que se percebe e que a pessoa pode contornar
  // escolhendo outra data.
  if (!Number.isFinite(hours)) {
    return {
      allowed: false,
      reason: 'Pick a date and time first.',
      rules
    };
  }

  if (hours < rules.min_hours_for_later) {
    return {
      allowed: false,
      reason: `Pick-up is in about ${Math.round(hours)} hours. Paying later needs at least ` +
        `${rules.min_hours_for_later} hours' notice, so this one is paid now.`,
      rules
    };
  }

  if (Number(priceEUR) > Number(rules.max_value_for_later)) {
    return {
      allowed: false,
      reason: 'Transfers above our higher-value threshold are paid at booking.',
      rules
    };
  }

  if (Number(distanceKm) > Number(rules.max_km_for_later)) {
    return {
      allowed: false,
      reason: `This route is about ${Math.round(distanceKm)} km. Journeys over ` +
        `${rules.max_km_for_later} km are paid at booking.`,
      rules
    };
  }

  return { allowed: true, reason: null, rules };
}

// ============================================================
// IDENTIDADE E AGENTES
//
// A margem do agente é SEMPRE calculada aqui, a partir do JWT. Se
// viesse do browser, qualquer pessoa reclamava 12% de desconto.
// ============================================================

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
  // O x-cron-secret está aqui só para as rotas de diagnóstico
  // poderem ser chamadas do browser. Não abre nada: sem o valor
  // certo, a rota responde 403 na mesma.
  allowedHeaders: ['Content-Type', 'Authorization', 'Stripe-Signature', 'x-cron-secret']
}));

app.use('/api/stripe-webhook', express.raw({ type: 'application/json' }));
app.use(express.json());
app.use(express.static('public'));

app.get('/', (req, res) => {
  res.send('Backend is running');
});

// Rede de parceiros de motoristas. Vive em partners.js para este
// ficheiro não crescer sem fim; as dependências vão por parâmetro.
app.use(createPartnerRoutes({
  supabase,
  getUserFromRequest,
  requireAdmin,
  config: {
    defaultCountry: process.env.DEFAULT_PARTNER_COUNTRY || 'PT'
  }
}));

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

// O calculador pergunta aqui se pode mostrar a opção de pagar
// depois. A decisão é sempre repetida no checkout — isto é só para a
// interface, e nunca é o que decide se se cobra ou não.
/**
 * Quem tem de confirmar o email antes de a conta funcionar.
 *
 * Motoristas e agências: sim. Têm acesso a dinheiro e a dados de
 * terceiros, e ninguém está a meio de uma compra quando se regista.
 *
 * Clientes: não. O Supabase recusa o login enquanto o email não
 * estiver confirmado, e no calculador a conta é criada a meio da
 * reserva — bloquear aí obrigava a pessoa a sair, ir ao email e
 * recomeçar a reserva do zero. Um cliente já se verifica de outra
 * forma: paga com um cartão.
 *
 * Para mudar, é só pôr 'customer' a true. Mas lê o parágrafo acima
 * antes de o fazeres.
 */
const VERIFY_REQUIRED = {
  customer: false,
  partner: true,
  agent: true
};

/**
 * A confirmação de email é enviada pelo SUPABASE, não por aqui.
 *
 * Configurado em Authentication > Emails com o SMTP do Resend, sai
 * do mesmo domínio e com o mesmo aspeto, e trata também da
 * recuperação de password e do aviso de password alterada — três
 * emails que teríamos de escrever e manter.
 *
 * Basta criar a conta com email_confirm a false: o Supabase envia
 * sozinho. Esta função existe para o registo de parceiros a poder
 * chamar sem saber disto.
 */
async function sendVerification(email, name, kind) {
  // Nada a fazer: o Supabase já enviou quando a conta foi criada.
  console.log(`[email] verification for ${email} (${kind}) handled by Supabase`);
  return { sent: true, by: 'supabase' };
}

app.post('/api/payment-options', async (req, res) => {
  try {
    const { booking } = req.body || {};
    if (!booking) return res.status(400).json({ error: 'Missing booking' });

    const requester = await getUserFromRequest(req);
    const agent = await getApprovedAgent(requester);

    let distanceKm = Number(booking.distance_km) || 0;
    if (!distanceKm && booking.pickup && booking.dropoff) {
      try {
        ({ distanceKm } = await getDistanceAndDuration(booking.pickup, booking.dropoff));
      } catch (e) {
        distanceKm = 0;
      }
    }

    const result = await payLaterEligibility({
      dateStr: booking.booking_date || booking.date,
      timeStr: booking.booking_time || booking.time,
      priceEUR: booking.price_eur || 0,
      distanceKm,
      isAgent: Boolean(agent)
    });

    return res.json({
      pay_later: result.allowed,
      reason: result.reason,
      charge_lead_hours: result.rules.charge_lead_hours,
      is_agent: Boolean(agent)
    });
  } catch (error) {
    console.error('payment-options error:', error);
    // Perante a dúvida, só pagar já. Nunca o contrário — mas com
    // uma explicação, senão o cartão fica cinzento sem motivo.
    return res.json({
      pay_later: false,
      reason: 'We could not check the payment options right now, so this booking is paid at checkout.',
      charge_lead_hours: 48
    });
  }
});

app.post('/register', async (req, res) => {
  try {
    const { name, email, password, phone, preferred_languages } = req.body;

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
        // Para clientes marcamos como confirmado: o Supabase recusa
        // o login enquanto não estiver, e isso partia a reserva a
        // meio. O email de confirmação sai na mesma, a pedir e não
        // a exigir.
        email_confirm: !VERIFY_REQUIRED.customer,
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
        // Preferência, não garantia. No máximo duas: mais do que isso
        // deixa de ser uma preferência e passa a ser uma lista de desejos.
        preferred_languages: Array.isArray(preferred_languages) && preferred_languages.length
          ? preferred_languages.slice(0, 2)
          : null,
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

    // A confirmação sai depois de a conta existir. Se falhar, a
    // conta continua boa — o email é um extra, não um requisito.
    await sendVerification(email, name, 'customer');

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

  const pickupAirport = await findPickupAirport(booking.pickup);

  // A taxa fica registada na reserva. Converter mais tarde com a taxa
  // do dia em que se lê o relatório dava números diferentes a cada
  // consulta, e nenhum deles seria o que realmente aconteceu.
  // País de recolha e de destino, a partir do texto. Grosseiro mas
  // suficiente: serve para separar viagens internas de transfronteiriças,
  // que é a distinção que quase todos os regimes fazem.
  const countryFrom = guessCountry(booking.pickup);
  const countryTo = guessCountry(booking.dropoff);

  const rateData = await loadExchangeRates();
  const fxRate = Number((rateData.rates || {})[String(currency).toUpperCase()] || 1);

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
    price_eur: String(priceEUR.toFixed(2)),
    fx_rate: String(fxRate),
    country_from: countryFrom || '',
    country_to: countryTo || '',
    // Só faz sentido numa reserva de agência, e só o servidor sabe
    // se quem reserva é mesmo uma. Vem do JWT, não do que o browser
    // diz que é.
    agent_reference: agent ? String(booking.agent_reference || '').slice(0, 60) : '',
    passenger_name: booking.passenger_name || '',
    passenger_email: booking.passenger_email || '',
    passenger_phone: booking.passenger_phone || '',
    pickup_airport: pickupAirport.iata || '',
    pickup_city: pickupAirport.city || '',
    preferred_languages: Array.isArray(booking.preferred_languages)
      ? booking.preferred_languages.slice(0, 2).join(',')
      : ''
  };

  // O cliente pediu pagar depois? Só se as regras deixarem. A
  // decisão é tomada AQUI, não no browser: um pedido forjado com
  // payment_mode 'later' cai na mesma nesta verificação.
  const wantsLater = booking.payment_mode === 'later';
  const eligibility = await payLaterEligibility({
    dateStr: metadata.booking_date,
    timeStr: metadata.booking_time,
    priceEUR,
    distanceKm,
    isAgent: Boolean(agent)
  });

  const payLater = wantsLater && eligibility.allowed;

  if (wantsLater && !eligibility.allowed) {
    return res.status(400).json({
      error: eligibility.reason || 'This booking has to be paid at checkout.'
    });
  }

  metadata.payment_mode = payLater ? 'later' : 'now';

  if (payLater) {
    const pickupAt = new Date(`${metadata.booking_date}T${metadata.booking_time || '00:00'}`);
    metadata.charge_at = new Date(
      pickupAt.getTime() - eligibility.rules.charge_lead_hours * 36e5
    ).toISOString();
  }

  try {
    const parts = [
      `${passengers} passengers`,
      `${distanceKm.toFixed(1)} km`,
      `${durationMinutes} min`
    ];

    if (metadata.flight_number) {
      parts.push(`Flight ${metadata.flight_number}`);
    }

    let session;

    if (payLater) {
      // mode 'setup' guarda o cartão sem cobrar nada. O cliente vê a
      // página do Stripe, autentica o cartão se o banco exigir, e não
      // sai dinheiro nenhum da conta dele hoje.
      session = await stripe.checkout.sessions.create({
        mode: 'setup',
        payment_method_types: ['card'],
        customer_email: booking.email,
        success_url: `${SITE_ORIGIN}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE_ORIGIN}/?cancel=true`,
        metadata,
        setup_intent_data: { metadata }
      });
    } else {
      session = await stripe.checkout.sessions.create({
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
    }

    return res.json({
      url: session.url,
      sessionId: session.id,
      payment_mode: payLater ? 'later' : 'now',
      charge_at: metadata.charge_at || null,
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

    if (!Number.isFinite(hoursUntil)) {
      return res.status(400).json({
        error: 'This booking has no valid pick-up time. Please contact support.'
      });
    }

    // Reserva com pagamento adiado e ainda por cobrar: cancela-se sem
    // mais nada. Não há dinheiro a devolver, nem comissão a perder —
    // é exatamente para isto que o pagar depois existe.
    const notYetCharged = booking.payment_mode === 'later' && !booking.charged_at;

    if (notYetCharged) {
      const { error: cancelError } = await supabase.from('bookings').update({
        status: 'cancelled',
        payment_status: 'cancelled_before_charge',
        charge_at: null,
        assigned_partner_id: null,
        assigned_driver_id: null,
        assigned_vehicle_id: null,
        assigned_at: null,
        updated_at: new Date().toISOString()
      }).eq('id', booking_id);

      if (cancelError) {
        console.error('Cancel (uncharged) error:', cancelError);
        return res.status(500).json({ error: 'Could not cancel. Please contact support.' });
      }

      // O cartão guardado deixa de fazer falta. Apagá-lo do Stripe é
      // o mínimo: guardar cartões de reservas canceladas é risco sem
      // proveito nenhum.
      if (booking.stripe_payment_method_id) {
        try {
          await stripe.paymentMethods.detach(booking.stripe_payment_method_id);
        } catch (error) {
          console.warn('Could not detach card:', error.message);
        }
      }

      await sendCancellation(booking, { refunded: false, amount: 0 });

      return res.json({ success: true, refunded: false, charged: false });
    }

    // Agentes têm 12 horas em vez de 24, mas só nas reservas que
    // eles próprios fizeram.
    const agent = await getApprovedAgent(user);
    const windowHours = (agent && booking.booked_by === user.id)
      ? AGENT_CANCELLATION_HOURS
      : FREE_CANCELLATION_HOURS;

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
        payment_status: refundId ? 'refunded' : booking.payment_status,
        refunded_amount: refundId ? Number(booking.price || 0) : booking.refunded_amount,
        // Também em euros: sem isto o relatório mensal não sabe
        // quanto foi devolvido numa reserva feita em libras.
        refunded_amount_eur: refundId && booking.fx_rate
          ? Number((Number(booking.price || 0) / Number(booking.fx_rate)).toFixed(2))
          : booking.refunded_amount_eur,
        refunded_at: refundId ? new Date().toISOString() : booking.refunded_at,
        refund_reason: refundId ? 'Cancelled by customer within the free window' : booking.refund_reason,
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

    await sendCancellation(booking, {
      refunded: Boolean(refundId),
      amount: Number(booking.price || 0)
    });

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
// REEMBOLSO MANUAL (ADMIN)
//
// Para os casos fora da janela de cancelamento automático, onde a
// decisão é comercial e tem de ser de uma pessoa. Aceita reembolso
// parcial e não obriga a cancelar a reserva — às vezes devolve-se
// uma diferença sem anular o transfer.
// ============================================================
app.post('/api/admin/refund', async (req, res) => {
  try {
    const { user: admin, error: adminError } = await requireAdmin(req);

    if (!admin) {
      return res.status(403).json({ error: adminError || 'Administrator access required.' });
    }

    const { booking_id, amount, cancel_booking, reason } = req.body || {};

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

    if (!booking.stripe_payment_intent_id) {
      return res.status(400).json({
        error: 'This booking has no Stripe payment on file. Nothing to refund here.'
      });
    }

    const currency = booking.currency || 'EUR';

    // amount_total vem do Stripe em unidades menores e é a fonte de
    // verdade do que foi realmente cobrado. O price é o que
    // mostrámos, que pode divergir por arredondamento.
    const paidMajor = booking.amount_total
      ? fromStripeAmount(booking.amount_total, currency)
      : Number(booking.price || 0);

    const alreadyMajor = Number(booking.refunded_amount || 0);
    const remainingMajor = Number((paidMajor - alreadyMajor).toFixed(2));

    if (remainingMajor <= 0) {
      return res.status(400).json({
        error: 'This booking has already been fully refunded.'
      });
    }

    let refundMajor = remainingMajor;

    if (amount !== undefined && amount !== null && amount !== '') {
      const requested = Number(amount);

      if (!Number.isFinite(requested) || requested <= 0) {
        return res.status(400).json({ error: 'Refund amount must be a positive number.' });
      }

      if (requested > remainingMajor + 0.001) {
        return res.status(400).json({
          error: `Only ${remainingMajor.toFixed(2)} ${currency} is left to refund on this booking.`
        });
      }

      refundMajor = requested;
    }

    const refundMinor = toStripeAmount(refundMajor, currency);

    if (refundMinor <= 0) {
      return res.status(400).json({ error: 'Refund amount is too small to process.' });
    }

    let refund;

    try {
      refund = await stripe.refunds.create({
        payment_intent: booking.stripe_payment_intent_id,
        amount: refundMinor,
        reason: 'requested_by_customer',
        metadata: {
          issued_by: admin.email,
          booking_id: String(booking.id),
          note: (reason || '').slice(0, 400)
        }
      });
    } catch (error) {
      console.error('Admin refund error:', error);

      return res.status(502).json({
        error: error.message || 'Stripe refused the refund.'
      });
    }

    const totalRefunded = Number((alreadyMajor + refundMajor).toFixed(2));
    const fullyRefunded = totalRefunded >= paidMajor - 0.001;

    const update = {
      refunded_amount: totalRefunded,
      refunded_amount_eur: booking.fx_rate
        ? Number((totalRefunded / Number(booking.fx_rate)).toFixed(2))
        : totalRefunded,
      refunded_at: new Date().toISOString(),
      refunded_by: admin.id,
      refund_reason: reason || null,
      payment_status: fullyRefunded ? 'refunded' : 'partially_refunded',
      updated_at: new Date().toISOString()
    };

    if (cancel_booking) {
      update.status = 'cancelled';
    }

    const { error: updateError } = await supabase
      .from('bookings')
      .update(update)
      .eq('id', booking_id);

    if (updateError) {
      console.error('Refund update error:', updateError);

      // O dinheiro já saiu. Não devolvemos erro genérico: quem está
      // no painel precisa de saber que o Stripe fez a parte dele.
      return res.status(500).json({
        error: `Stripe issued refund ${refund.id}, but the booking record could not be updated. ` +
               'Please fix the booking manually.'
      });
    }

    console.log('Manual refund issued:', {
      by: admin.email,
      booking: booking.booking_id || booking.id,
      amount: refundMajor,
      currency,
      cancelled: Boolean(cancel_booking)
    });

    return res.json({
      success: true,
      refund_id: refund.id,
      refunded_now: refundMajor,
      refunded_total: totalRefunded,
      remaining: Number((paidMajor - totalRefunded).toFixed(2)),
      currency,
      fully_refunded: fullyRefunded
    });
  } catch (error) {
    console.error('admin/refund error:', error);

    return res.status(500).json({ error: 'Something went wrong issuing the refund.' });
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
        'id, email, contact_name, representative_role, legal_name, agency_name, ' +
        'agency_vat, agency_country, agency_website, agency_phone, note, ' +
        'status, commission, applied_at'
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
      legal_name,
      agency_name,
      agency_vat,
      agency_country,
      agency_website,
      agency_phone,
      representative_name,
      representative_role,
      note,
      full_name
    } = req.body || {};

    if (!legal_name || !agency_country || !agency_phone || !representative_name) {
      return res.status(400).json({
        error: 'Registered company name, country, phone and representative name are required.'
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
        full_name: representative_name || full_name || user.user_metadata?.full_name || null,
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
        contact_name: representative_name || full_name || null,
        representative_role: representative_role || null,
        legal_name,
        // Sem nome comercial, o comercial é o legal.
        agency_name: agency_name || legal_name,
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
    const { user: admin, error: adminError } = await requireAdmin(req);

    if (!admin) {
      return res.status(403).json({ error: adminError || 'Administrator access required.' });
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

    // O email não pode partir a decisão: a agência já está aprovada
    // na base de dados quando chegamos aqui.
    if (decision === 'approved' || decision === 'rejected') {
      await sendAgentDecision(data, decision, req.body.reason);
    }

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
      legal_name,
      agency_name,
      agency_vat,
      agency_country,
      agency_phone,
      agency_website,
      contact_name,
      representative_role
    } = req.body || {};

    if (!legal_name || !agency_country || !agency_phone || !contact_name) {
      return res.status(400).json({
        error: 'Registered company name, country, phone and representative name are required.'
      });
    }

    const { data, error } = await supabase
      .from('travel_agents')
      .update({
        legal_name,
        agency_name: agency_name || legal_name,
        agency_vat: agency_vat || null,
        agency_country,
        agency_phone,
        agency_website: agency_website || null,
        contact_name,
        representative_role: representative_role || null,
        updated_at: new Date().toISOString()
      })
      .eq('id', user.id)
      .select('id, email, contact_name, representative_role, legal_name, agency_name, agency_vat, agency_country, agency_phone, agency_website, status, commission')
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
    const payLater = metadata.payment_mode === 'later' || session.mode === 'setup';

    // Em modo setup não há cobrança: o que interessa é o cartão que
    // ficou guardado, para o podermos usar mais tarde sem o cliente
    // estar presente.
    let savedPaymentMethod = null;
    let setupIntentId = null;

    if (payLater && typeof session.setup_intent === 'string') {
      try {
        const si = await stripe.setupIntents.retrieve(session.setup_intent);
        setupIntentId = si.id;
        savedPaymentMethod = typeof si.payment_method === 'string'
          ? si.payment_method
          : si.payment_method?.id || null;
      } catch (error) {
        console.error('SetupIntent retrieve error:', error);
      }
    }

    let charge = null;

    // O que o Stripe depositou, em euros, já líquido de comissão.
    // O price_eur é o valor cotado à taxa do BCE; este é o que
    // aparece no extrato. Os dois têm de existir: um para reportar
    // receita, outro para bater com o banco.
    let settlement = { eur: null, fee: null, rate: null, id: null };

    if (typeof session.payment_intent === 'string') {
      try {
        // Expandimos até ao balance_transaction numa só chamada: é
        // aí que está o valor líquido em euros e a comissão.
        const paymentIntent = await stripe.paymentIntents.retrieve(
          session.payment_intent,
          { expand: ['latest_charge.balance_transaction'] }
        );

        charge = paymentIntent.latest_charge || null;

        const bt = charge && charge.balance_transaction;
        if (bt && typeof bt === 'object') {
          const factor = ZERO_DECIMAL_CURRENCIES
            .includes(String(bt.currency).toUpperCase()) ? 1 : 100;

          settlement = {
            eur: Number((bt.net / factor).toFixed(2)),
            fee: Number((bt.fee / factor).toFixed(2)),
            rate: bt.exchange_rate || null,
            id: bt.id
          };
        }
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
      agent_reference: metadata.agent_reference || null,
      pickup_airport: metadata.pickup_airport || null,
      pickup_city: metadata.pickup_city || null,
      country_from: metadata.country_from || null,
      country_to: metadata.country_to || null,
      // Onde a viagem acontece decide, em vários regimes fiscais,
      // onde o imposto é devido. Guardamos mesmo antes de usar.
      cross_border: Boolean(metadata.country_from && metadata.country_to &&
        metadata.country_from !== metadata.country_to),
      price_eur: metadata.price_eur ? Number(metadata.price_eur) : null,
      fx_rate: metadata.fx_rate ? Number(metadata.fx_rate) : null,
      fx_rate_at: new Date().toISOString(),
      settled_eur: settlement.eur,
      stripe_fee_eur: settlement.fee,
      stripe_fx_rate: settlement.rate,
      balance_transaction_id: settlement.id,
      preferred_languages: metadata.preferred_languages
        ? metadata.preferred_languages.split(',').filter(Boolean)
        : null,
      status: payLater ? 'confirmed' : (metadata.status || session.payment_status || 'paid'),
      payment_status: payLater ? 'card_saved' : (session.payment_status || null),
      payment_mode: payLater ? 'later' : 'now',
      charge_at: payLater ? (metadata.charge_at || null) : null,
      stripe_payment_method_id: savedPaymentMethod,
      stripe_setup_intent_id: setupIntentId,
      amount_total: payLater ? null : (session.amount_total || null),
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

    // Dois emails diferentes: quem pagou já recebe a confirmação,
    // quem só guardou o cartão recebe a data em que será cobrado.
    // Mandar a mesma coisa aos dois faria alguém pensar que já pagou.
    if (payLater) {
      await sendCardSaved(savedBooking, bookingRow.charge_at);
    } else {
      await sendBookingConfirmation(savedBooking);
    }
  }

  return res.json({ received: true });
});

// ============================================================
// COBRANÇA AGENDADA
//
// Chamado de hora a hora por um cron externo. Não é uma rota pública:
// exige um segredo no cabeçalho, senão qualquer pessoa disparava
// cobranças no teu Stripe.
//
// cron-job.org → POST https://airportlink.onrender.com/api/tasks/charge-due
//                cabeçalho: x-cron-secret: <CRON_SECRET>
// ============================================================
/**
 * Testar o email sem fazer uma reserva.
 *
 * Existe porque diagnosticar "não recebi nada" através de uma
 * reserva real mistura três coisas que podem falhar: o Stripe, o
 * webhook e o email. Isto testa só a última.
 *
 * Protegido pelo mesmo segredo do cron: não é uma rota pública.
 */
app.post('/api/tasks/test-email', async (req, res) => {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured.' });
  }
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const to = (req.body && req.body.to) || process.env.EMAIL_OPERATIONS;
  if (!to) {
    return res.status(400).json({ error: 'Send { "to": "you@example.com" } or set EMAIL_OPERATIONS.' });
  }

  const checks = {
    resend_key: Boolean(process.env.RESEND_API_KEY),
    from: process.env.EMAIL_FROM_BOOKINGS || process.env.EMAIL_FROM || '(default)',
    reply_to: process.env.EMAIL_REPLY_TO || '(default)',
    email_log_table: null,
    delivered: false,
    error: null
  };

  // A email_log existe? É a causa mais provável de nada sair: sem a
  // tabela, o registo falha e o envio é abandonado antes de começar.
  try {
    const { error } = await supabase.from('email_log').select('id').limit(1);
    checks.email_log_table = error ? `MISSING — ${error.message}` : 'ok';
  } catch (error) {
    checks.email_log_table = `MISSING — ${error.message}`;
  }

  // Envio direto, sem passar pelo registo: queremos saber se o
  // Resend aceita, separado de tudo o resto.
  try {
    const result = await notifyOps('Test email', [
      'If you are reading this, Resend is working.',
      `Sent at ${new Date().toISOString()}`,
      `From: ${checks.from}`
    ], to);
    checks.delivered = result.sent;
    if (!result.sent) checks.error = result.reason || 'unknown';
  } catch (error) {
    checks.error = error.message;
  }

  console.log('[email] test run:', checks);

  return res.json({ to, ...checks });
});

/**
 * O correio de todos os dias.
 *
 * Uma só chamada trata do que depende do calendário: os detalhes do
 * motorista na véspera, os documentos a expirar, e o aviso interno
 * das viagens que ninguém quis.
 *
 * Corre uma vez por dia, de manhã. Não de hora a hora: um lembrete
 * que chega às três da manhã é pior do que nenhum.
 *
 * cron-job.org → POST /api/tasks/daily-emails, às 09:15
 */
/**
 * Envio de emails para o serviço dos motoristas.
 *
 * O emailService vive aqui e só aqui. O outro serviço pede a esta
 * rota em vez de ter uma cópia do ficheiro — duas cópias divergem
 * sempre, e no dia em que divergem um dos dois manda o texto antigo.
 *
 * A proteção é o CRON_SECRET, mas não é só isso: os modelos são uma
 * LISTA FECHADA. Quem tivesse o segredo não poderia mandar um email
 * qualquer a partir do nosso domínio — apenas disparar um destes
 * três, que são inofensivos fora de contexto.
 */
const INTERNAL_TEMPLATES = {
  partner_received: (p) => sendPartnerApplicationReceived(p.partner),
  partner_decision: (p) => sendPartnerDecision(p.partner, p.decision, p.reason),
  ride_confirmed: (p) => sendRideConfirmedToPartner(p.partner, p.booking),
  // O link de confirmação só pode ser gerado aqui: é este serviço
  // que tem o cliente com service_role.
  verify_email: (p) => sendVerification(p.email, p.name, p.kind || 'partner')
};

app.post('/api/internal/email', async (req, res) => {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured.' });
  }
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    console.warn('internal/email called with a bad secret');
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { template, payload } = req.body || {};
  const handler = INTERNAL_TEMPLATES[template];

  if (!handler) {
    return res.status(400).json({
      error: `Unknown template: ${template}`,
      allowed: Object.keys(INTERNAL_TEMPLATES)
    });
  }

  try {
    const result = await handler(payload || {});
    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error('internal/email error:', error);
    return res.status(500).json({ error: 'Could not send that email.' });
  }
});

/**
 * Todos os modelos de email, de uma vez, para um endereço.
 *
 * Rever um email a um obriga a provocar cada acontecimento: pagar,
 * cancelar, deixar uma cobrança falhar. Uma revisão de texto não
 * devia custar isso.
 *
 * Demora cerca de doze segundos: há uma pausa entre cada um porque
 * o Resend limita a dois por segundo no plano gratuito.
 */
app.post('/api/tasks/preview-emails', async (req, res) => {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured.' });
  }
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const to = (req.body && req.body.to) || process.env.EMAIL_OPERATIONS;
  if (!to) {
    return res.status(400).json({ error: 'Send { "to": "you@example.com" }.' });
  }

  const results = await previewAll(to);
  const sent = results.filter((r) => r.sent).length;

  console.log(`[email] preview: ${sent}/${results.length} sent to ${to}`);

  return res.json({ to, sent, total: results.length, results });
});

app.post('/api/tasks/daily-emails', async (req, res) => {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured.' });
  }
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const out = { driver_details: 0, expiring: 0, expired: 0, unclaimed: 0, errors: [] };

  const day = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  // ---------- 1. o motorista, na véspera ----------
  try {
    const { data: rides } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_date', day(1))
      .not('assigned_partner_id', 'is', null)
      .neq('status', 'cancelled');

    for (const ride of (rides || [])) {
      // Um motorista e um veículo do parceiro. Quando houver
      // atribuição explícita usamos essa; até lá, o primeiro ativo.
      const [driverRes, vehicleRes] = await Promise.all([
        supabase.from('drivers').select('*')
          .eq('partner_id', ride.assigned_partner_id)
          .eq('status', 'active').limit(1).maybeSingle(),
        supabase.from('partner_vehicles').select('*')
          .eq('partner_id', ride.assigned_partner_id)
          .eq('status', 'active')
          .gte('seats', ride.passengers || 1)
          .order('seats').limit(1).maybeSingle()
      ]);

      if (!driverRes.data) {
        // Sem motorista não há email — e é um problema real, porque
        // a viagem é amanhã.
        await notifyOps('Ride tomorrow with no driver on file', [
          `Reference: ${ride.booking_reference || ride.booking_id}`,
          `Route: ${ride.pickup} to ${ride.dropoff}`,
          `Pick-up: ${ride.booking_date} ${String(ride.booking_time || '').slice(0, 5)}`,
          'The partner has taken this ride but has no active driver.'
        ]);
        continue;
      }

      const result = await sendDriverDetails(ride, driverRes.data, vehicleRes.data);
      if (result.sent) out.driver_details += 1;
    }
  } catch (error) {
    out.errors.push('driver_details: ' + error.message);
  }

  // ---------- 2. documentos a expirar ----------
  try {
    const { data: docs } = await supabase
      .from('compliance_documents')
      .select('*, driver_partners!inner(id, email, legal_name, status)')
      .not('expires_on', 'is', null)
      .lte('expires_on', day(30));

    for (const doc of (docs || [])) {
      const partner = doc.driver_partners;
      if (!partner || partner.status === 'rejected') continue;

      const daysLeft = Math.round(
        (new Date(doc.expires_on).getTime() - Date.now()) / 864e5
      );

      // Avisamos aos 30, aos 7, e no dia em que expira. Todos os
      // dias seria assédio; só uma vez seria fácil de perder.
      if (![30, 7, 1].includes(daysLeft) && daysLeft > 0) continue;

      const result = await sendDocumentExpiring(partner, doc, daysLeft);
      if (result.sent) {
        if (daysLeft <= 0) out.expired += 1;
        else out.expiring += 1;
      }
    }
  } catch (error) {
    out.errors.push('expiring: ' + error.message);
  }

  // ---------- 3. viagens que ninguém quis ----------
  try {
    const { data: orphans } = await supabase
      .from('unclaimed_rides')
      .select('*')
      .lte('hours_to_pickup', 48);

    if ((orphans || []).length) {
      out.unclaimed = orphans.length;

      await notifyOps(`${orphans.length} ride(s) with no partner`, [
        'These are within 48 hours of pick-up and nobody has taken them.',
        '',
        ...orphans.map((r) =>
          `${r.booking_reference || r.booking_id} — ${r.pickup_airport || 'NO AIRPORT'} — ` +
          `${r.booking_date} ${String(r.booking_time || '').slice(0, 5)} — ` +
          `${Math.round(r.hours_to_pickup)}h left — ` +
          `${r.partners_that_can_see_it} partner(s) can see it`),
        '',
        'Where the airport is missing, the pick-up text did not match any airport ' +
        'and the ride cannot reach anyone.'
      ]);
    }
  } catch (error) {
    out.errors.push('unclaimed: ' + error.message);
  }

  console.log('[daily-emails]', out);
  return res.json({ ok: true, ...out });
});

app.post('/api/tasks/charge-due', async (req, res) => {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured.' });
  }
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    console.warn('charge-due called with a bad secret');
    return res.status(403).json({ error: 'Forbidden' });
  }

  const rules = await getPaymentRules();
  const results = { checked: 0, charged: 0, failed: 0, abandoned: 0, skipped: 0 };

  try {
    const { data: due, error } = await supabase
      .from('bookings')
      .select('*')
      .eq('payment_mode', 'later')
      .is('charged_at', null)
      .neq('status', 'cancelled')
      .lte('charge_at', new Date().toISOString())
      .lt('charge_attempts', rules.max_charge_attempts)
      .limit(50);

    if (error) throw error;

    for (const booking of (due || [])) {
      results.checked += 1;

      // Uma tentativa falhada volta a ser elegível só depois do
      // intervalo. Sem isto, o cron de hora a hora queimava as três
      // tentativas em três horas.
      if (booking.charge_attempts > 0 && booking.updated_at) {
        const since = (Date.now() - new Date(booking.updated_at).getTime()) / 36e5;
        if (since < rules.retry_interval_hours) {
          results.skipped += 1;
          continue;
        }
      }

      if (!booking.stripe_payment_method_id || !booking.stripe_customer_id) {
        results.skipped += 1;
        continue;
      }

      const attemptNo = (booking.charge_attempts || 0) + 1;
      const currency = booking.currency || 'EUR';
      const amount = toStripeAmount(Number(booking.price || 0), currency);

      try {
        const intent = await stripe.paymentIntents.create({
          amount,
          currency: currency.toLowerCase(),
          customer: booking.stripe_customer_id,
          payment_method: booking.stripe_payment_method_id,
          // off_session: o cliente não está no site. O banco pode
          // recusar por isso mesmo, e é esse o caso que tratamos abaixo.
          off_session: true,
          confirm: true,
          metadata: {
            booking_id: String(booking.booking_id || booking.id),
            scheduled_charge: 'true'
          }
        });

        await supabase.from('bookings').update({
          charged_at: new Date().toISOString(),
          charge_attempts: attemptNo,
          payment_status: 'paid',
          status: 'paid',
          amount_total: intent.amount,
          stripe_payment_intent_id: intent.id,
          last_charge_error: null,
          updated_at: new Date().toISOString()
        }).eq('id', booking.id);

        await supabase.from('charge_attempts').insert({
          booking_id: booking.id, attempt_no: attemptNo, outcome: 'succeeded',
          amount: Number(booking.price || 0), currency, stripe_id: intent.id
        });

        results.charged += 1;
        console.log('Scheduled charge succeeded:', booking.booking_id || booking.id);
        await sendChargeSucceeded(booking);
      } catch (error) {
        const code = error.code || error.decline_code || 'unknown';
        const needsCustomer = code === 'authentication_required';
        const giveUp = attemptNo >= rules.max_charge_attempts;

        await supabase.from('charge_attempts').insert({
          booking_id: booking.id, attempt_no: attemptNo,
          outcome: needsCustomer ? 'requires_action' : 'failed',
          amount: Number(booking.price || 0), currency,
          error_code: code, error_message: error.message
        });

        await supabase.from('bookings').update({
          charge_attempts: attemptNo,
          last_charge_error: `${code}: ${error.message}`,
          payment_status: giveUp ? 'charge_abandoned' : 'charge_failed',
          // Desistir cancela a reserva: manter uma viagem por pagar
          // significa mandar um motorista a um serviço que ninguém
          // pagou. Melhor libertá-lo com antecedência.
          status: giveUp ? 'cancelled' : booking.status,
          assigned_partner_id: giveUp ? null : booking.assigned_partner_id,
          updated_at: new Date().toISOString()
        }).eq('id', booking.id);

        await sendChargeFailed(booking, { attempt: attemptNo, willRetry: !giveUp });

        if (giveUp) {
          results.abandoned += 1;
          console.error('Charge abandoned, booking cancelled:', booking.booking_id || booking.id, code);

          // Um aviso para dentro: alguém tem de saber que uma reserva
          // foi cancelada por não haver pagamento, sobretudo se já
          // tinha motorista atribuído.
          await notifyOps('Booking cancelled — payment failed', [
            `Reference: ${booking.booking_reference || booking.booking_id}`,
            `Customer: ${booking.full_name || ''} (${booking.email})`,
            `Pick-up: ${booking.booking_date} ${String(booking.booking_time || '').slice(0, 5)}`,
            `Route: ${booking.pickup} to ${booking.dropoff}`,
            `Amount: ${booking.currency} ${booking.price}`,
            `Last error: ${code} — ${error.message}`,
            booking.assigned_partner_id
              ? 'A partner had already taken this ride and has been released.'
              : 'No partner had taken it.'
          ]);
        } else {
          results.failed += 1;
          console.warn('Charge failed, will retry:', booking.booking_id || booking.id, code);
        }
      }
    }

    return res.json({ ok: true, ...results });
  } catch (error) {
    console.error('charge-due error:', error);
    return res.status(500).json({ error: 'Charge run failed.', ...results });
  }
});

app.listen(PORT, async () => {
  // Uma leitura qualquer confirma que a chave é a certa. Mais vale
  // descobrir aqui do que na primeira reserva, com um cliente à
  // espera e um "permission denied" no log.
  await checkConnection();

  console.log(`Server running on ${PORT}`);
  await loadExchangeRates();
});
