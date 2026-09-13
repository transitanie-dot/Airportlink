import crypto from 'node:crypto';
import express from 'express';
/**
 * Os avisos no telemóvel.
 *
 * O email de operações não serve para o que é urgente: chega a uma
 * caixa que se lê quando se lê. O Telegram notifica no telemóvel,
 * é gratuito, e separa vendas de alarmes em dois canais.
 */
import {
  telegramNewBooking,
  telegramNoDriver,
  telegramDispute,
  telegramTest,
  telegramDaySummary,
  // As tarefas automáticas avisam quando falham, e quando voltam.
  telegramTaskFailed,
  telegramTaskRecovered,

  // Uma agência que se candidata, e uma conta de cliente nova.
  telegramNewAgency,
  telegramNewAccount,

  // Pedidos pelo serviço dos drivers, pela rota /api/internal/alert.
  telegramNewChat,
  telegramNewPartner,

  /**
   * Os alarmes que vigiam números plausíveis mas errados.
   *
   * Um preço de 26 euros numa viagem de 87 não dá erro nenhum:
   * sai um número bonito. Estes três apanham-no.
   */
  telegramPrecoEstranho,
  telegramPrecoDivergente,
  telegramSemReservas,
  telegramReservaIncompleta,

  // O trabalho de fundo parou. Existia há semanas sem ser chamado.
  telegramTickDown
} from './telegram.js';

/**
 * O cálculo de preços vive num ficheiro só.
 *
 * Estava aqui e no browser — duas cópias, duas verdades. Mudei
 * uma e a outra ficou para trás, e um cliente viu 87 euros na
 * calculadora e 30 no checkout.
 *
 * Agora é o precos.js, e é ele que os testes verificam.
 */
import {
  computePriceEUR,
  isNightPickup,
  resolveVehicleClass,

  // As classes conhecidas, para a validação não ter uma lista
  // própria a divergir da de cálculo.
  VEHICLE_CLASSES
} from './precos.js';

/**
 * As viagens na agenda.
 *
 * Turquesa sem motorista, azul escuro com. A cor muda sozinha
 * quando a cascata encontra parceiro — o calendário conta a
 * história sem ninguém lhe tocar.
 */
import { calendarUpsert, calendarCancel, calendarTest } from './calendar.js';
/**
 * A hora a que o avião aterrou.
 *
 * O relógio da espera começa aí, não na hora que o cliente
 * escreveu — senão um voo com duas horas de atraso queima a hora
 * grátis antes de ele pisar o chão.
 */
import { flightLanding, flightsTest } from './flights.js';
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
  sendRideOffer,
  sendRideOfferReminder,
  sendTripReminder,
  sendDriverArrived,
  sendRideChanged,
  sendTicketReply,
  sendDeletionConfirm,
  sendPasswordChanged,

  // Os emails de confirmação de conta. O registo de parceiros
  // ficou semanas sem os mandar.
  sendVerifyPartner,
  sendVerifyCustomer,

  // Para quem ficou com a conta criada e sem forma de entrar.
  sendPartnerAccessLink,

  // O código de seis dígitos para definir a palavra-passe.
  sendResetCode,
  sendCancellation,
  sendDriverDetails,
  sendAgentDecision,
  sendDocumentExpiring,
  sendPartnerApplicationReceived,
  sendPartnerDecision,
  sendRideConfirmedToPartner,
  previewAll,
  sendPartnerStatement,
  sendAgentStatement,
  notifyOps,
  // Ligar o alarme dos emails às operações.
  setEmailAlarm
} from './emailService.js';

/**
 * Um email que falha avisa no canal de alarmes.
 *
 * Ligado aqui e não dentro do emailService: esse ficheiro não deve
 * saber que existe Telegram. Se um dia o alarme for por outro
 * canal, muda-se nesta linha.
 */
setEmailAlarm(telegramTaskFailed);
import { createShared } from './support-shared.js';
import { createPartnerRoutes } from './partners.js';

const app = express();

/**
 * O IP verdadeiro, atrás do proxy.
 *
 * O Render põe o endereço do visitante no x-forwarded-for e o seu
 * próprio no req.ip. Sem esta linha, o limitador via todos os
 * pedidos como vindos do mesmo sítio — e bloqueava toda a gente
 * ao mesmo tempo, ou ninguém.
 *
 * O 1 diz "confia num proxy". Confiar em todos deixaria alguém
 * forjar o cabeçalho e contornar o limite.
 */
app.set('trust proxy', 1);

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

/**
 * As classes de veículo, com o multiplicador de cada uma.
 *
 * A classe vem do browser mas o multiplicador vem DAQUI: quem
 * manipular o pedido escolhe no máximo um carro maior, nunca um
 * preço menor.
 */
/**
 * As classes, com o multiplicador de Portugal.
 *
 * As combinações estavam ABAIXO do custo das viaturas que enviam:
 * uma Van+Sedan é literalmente uma van (1,70) mais um sedan (1,00),
 * ou seja 2,70 — e cobrava-se 2,50. Duas vans são 3,40 e cobrava-se
 * 3,20. Cada uma dessas reservas dava prejuízo garantido.
 *
 * Agora ficam 5-6% acima da soma das partes, para pagar o segundo
 * motorista, o segundo regresso vazio e a coordenação entre viaturas.
 * Continua muito abaixo dos 24% que a Transfeero cobra em Espanha.
 */


/**
 * A classe pedida, ou a mais barata em que o grupo cabe.
 *
 * Também é a rede de segurança: 6 pessoas num "sedan" sobem para a
 * van — nunca se vende um carro onde o grupo não cabe.
 */


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

/**
 * As zonas de Portugal, cada uma com a sua tabela.
 *
 * Vêm do estudo da concorrência de 28/08/2026 (19 rotas medidas,
 * km confirmados no site deles), a 2% abaixo:
 *   Faro erro 1,6% · Porto 4,4% · Lisboa 6,8%.
 * O fallback é a média das três — serve Madeira e Açores até serem
 * medidos. Cada cidade tem MESMO tabela própria: o Porto custa 51%
 * mais por km do que Lisboa; uma fórmula nacional falhava sempre.
 */




/**
 * Espanha — estudo de 29/08/2026.
 *
 * Madrid e Barcelona têm tabela própria. Málaga serve de fórmula
 * para toda a restante Espanha: das três, é a que tem o preço por km
 * mais moderado, o que a torna a base segura para aeroportos ainda
 * não medidos.
 *
 * Calibradas para NUNCA ficarem acima deles. O desvio real vai de 0
 * a -10% conforme a rota: a fórmula deles não é uma reta perfeita, e
 * uma reta única não consegue seguir-lhes o preço a menos de 5% em
 * todas as distâncias ao mesmo tempo.
 *
 * Duas coisas que Portugal não tinha:
 *  - HÁ suplemento de aeroporto (~10%), já embutido na base.
 *  - As classes grandes custam mais: eles cobram 3,39x e 3,80x onde
 *    nós cobrávamos 2,50x e 3,20x. Duas viaturas são duas viaturas.
 */


/** Málaga: a tabela dela serve toda a Espanha que não seja Madrid nem
 *  Barcelona, incluindo a própria Málaga. */


/**
 * As cidades espanholas que não são Madrid nem Barcelona.
 *
 * Não têm tabela própria — usam a de Málaga. Servem só para o site
 * reconhecer que a rota é em Espanha quando o país não vem escrito
 * na morada, que é quase sempre.
 */


/**
 * Em Espanha cada zona tem os seus multiplicadores.
 *
 * Estão calibrados para as classes acima do Sedan ficarem entre 0% e
 * 10% ACIMA da Transfeero — o Premium a partir de 10%. O cálculo
 * parte do ponto onde o nosso Sedan mais desce face ao deles, para
 * que nem a rota mais desfavorável caia abaixo do preço deles.
 */

/**
 * Rotas com preço próprio.
 *
 * O Sitges custa-lhes o dobro do que a fórmula de Barcelona prevê —
 * destino de resort, procura alta. Uma fórmula não apanha isto, e
 * publicá-lo a metade do preço deles seria vender a perder.
 */


/**
 * Itália — estudo de 02/09/2026.
 *
 * Roma é a base nacional: seis rotas medidas de 8 a 234 km.
 * O Sedan fica sempre ABAIXO deles, o Premium sempre ACIMA.
 *
 * Duas coisas que Portugal e Espanha não tinham:
 *
 * 1. Em quatro cidades — Veneza, Florença, Milão e Cagliari — eles
 *    NÃO oferecem sedan de todo. É decisão comercial: a procura
 *    permite cobrar premium a toda a gente. O nosso sedan sai a 15%
 *    abaixo do premium deles, e é a nossa maior vantagem no país:
 *    em Florença são 36 euros de diferença numa rota de 40 km.
 *
 * 2. O Premium tem FÓRMULA PRÓPRIA, não um multiplicador.
 *    O sedan e o premium deles não crescem ao mesmo ritmo — em Roma
 *    o rácio vai de 1,22 aos 8 km a 1,09 aos 234. Um multiplicador
 *    fixo é a média de duas curvas diferentes e falha nas pontas: ou
 *    ficávamos 38% acima nas longas, ou abaixo deles nas curtas.
 *
 * Cada cidade tem MESMO tabela própria. Florença cobra 2,74 €/km no
 * premium contra 1,64 de Roma — 67% acima. Uma fórmula nacional
 * falharia por larga margem.
 */


/**
 * Roma serve toda a Itália não medida.
 *
 * AVISO: Roma é cidade cara. Palermo mostra que o sul corre cerca de
 * 30% mais barato. Abrir Bari, Catânia ou Lamezia com esta tabela
 * põe-nos acima do mercado — essas merecem estudo próprio.
 */


/**
 * Cidades italianas sem tabela própria.
 *
 * Servem só para o site reconhecer que a rota é em Itália quando o
 * país não vem escrito na morada, que é quase sempre.
 */


/** A zona, pelo texto das moradas. Palavra inteira sempre: "aeroporto"
 *  contém "porto", e sem isso "Aeroporto de Faro" caía na zona do Porto. */


/** Espanha ou Portugal, pelo texto das moradas. */


/** Uma rota com preço combinado, se existir. */


/**
 * O suplemento noturno.
 *
 * Entre as 22h55 e as 6h o preço sobe 20%. É o que a Transfeero
 * cobra — em Bilbao, 251,42 de dia e 301,70 de noite, que é
 * exatamente 1,2 vezes.
 *
 * A razão é real: um transfer às três da manhã custa mais ao
 * parceiro. O motorista dorme mal, há menos gente disponível, e
 * quem aceita cobra mais.
 *
 * As 22h55 e não as 23h porque a hora de recolha de um voo que
 * aterra às 23h é quase sempre uns minutos antes. Cortar às 23h
 * deixava de fora metade dos voos noturnos.
 */
   // 22:55
           // 06:00







/**
 * Servimos aqui?
 *
 * A calculadora dava preço para qualquer sítio do mundo. Um
 * cliente em Bogotá recebia um valor, pagava, e depois não havia
 * ninguém para o levar — e a devolução do dinheiro não devolve a
 * confiança.
 *
 * A resposta vem dos aeroportos operacionais: 440 aeroportos em
 * 129 países. Se a morada não cair em nenhum país da lista,
 * dizemos que ainda não estamos lá.
 *
 * A lista é a mesma que os parceiros veem ao registar-se. Abrir um
 * mercado novo é uma linha de SQL, e a calculadora acompanha
 * sozinha.
 */
/**
 * Os países que NÃO servimos.
 *
 * A lógica estava ao contrário: procurava os países que servimos
 * e recusava quando não encontrava nenhum. Uma morada como
 * "Hotel Maroa, Vigo" não tem a palavra "Spain" — e era recusada,
 * apesar de Vigo ser uma cidade onde operamos.
 *
 * Assim, só se recusa quando o país aparece EXPLICITAMENTE na
 * lista dos que ficaram de fora. Tudo o resto passa.
 *
 * É a diferença entre "prove que servimos aqui" e "só recuso o
 * que sei que não servimos" — e a segunda é a única que não fecha
 * a loja quando algo corre mal.
 */
let foraCache = { set: null, at: 0 };

const COBERTURA_LIGADA = process.env.COVERAGE_CHECK !== 'off';


async function paisesForaDaLista() {
  if (foraCache.set && Date.now() - foraCache.at < 60 * 60 * 1000) {
    return foraCache.set;
  }

  const { data, error } = await supabase
    .from('airports')
    .select('country, operational')
    .limit(10000);

  if (error || !data || data.length === 0) {
    console.error('coverage lookup failed:', error?.message || 'no rows');
    return null;
  }

  /**
   * Um país fica de fora quando NENHUM dos aeroportos dele é
   * operacional.
   *
   * A Colômbia com dois aeroportos, um operacional, está dentro.
   * O Botswana, com todos desligados, está fora.
   */
  const temOperacional = new Set();
  const todos = new Set();

  for (const a of data) {
    if (!a.country) continue;
    todos.add(a.country);
    if (a.operational === true) temOperacional.add(a.country);
  }

  const fora = new Set(
    [...todos].filter((c) => !temOperacional.has(c))
  );

  /**
   * Se TODOS estiverem fora, algo está errado com os dados.
   *
   * Guardar isso significaria recusar o mundo inteiro durante uma
   * hora — que foi exatamente o que aconteceu.
   */
  if (temOperacional.size === 0) {
    console.error('coverage: no operational airports at all');

    telegramTaskFailed('coverage',
      'No operational airports in the table. ' +
      'The calculator is letting everything through.'
    ).catch(() => {});

    return null;
  }

  foraCache = { set: fora, at: Date.now() };

  return fora;
}


/**
 * Esta morada é de um país que não servimos?
 *
 * Devolve o nome do país quando é para recusar, e null quando é
 * para deixar passar — incluindo quando não sabemos.
 */
async function paisForaDaLista(texto) {
  if (!texto || !COBERTURA_LIGADA) return null;

  const fora = await paisesForaDaLista();

  // Sem lista, deixa passar.
  if (!fora || fora.size === 0) return null;

  const lower = String(texto).toLowerCase();

  for (const p of fora) {
    /**
     * O país no fim da morada.
     *
     * O Google escreve-o sempre no fim: "Rua X, Gaborone,
     * Botswana". Procurá-lo no meio do texto daria falsos
     * positivos — "Chad" apanha "Chadwick Road".
     */
    if (lower.endsWith(', ' + p.toLowerCase())
        || lower.endsWith(' ' + p.toLowerCase())
        || lower === p.toLowerCase()) {
      return p;
    }
  }

  return null;
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
      /**
       * Um código, para o browser traduzir.
       *
       * A frase em inglês fica como recurso: se o browser não
       * conhecer o código, mostra-a. Melhor do que um espaço
       * vazio.
       */
      reason: 'Pick a date and time first.',
      code: 'noDate',
      rules
    };
  }

  if (hours < rules.min_hours_for_later) {
    return {
      allowed: false,
      code: 'tooSoon',
      hours: Math.round(hours),
      minHours: rules.min_hours_for_later,
      reason: `Pick-up is in about ${Math.round(hours)} hours. Paying later needs at least ` +
        `${rules.min_hours_for_later} hours' notice, so this one is paid now.`,
      rules
    };
  }

  if (Number(priceEUR) > Number(rules.max_value_for_later)) {
    return {
      allowed: false,
      reason: 'Transfers above our higher-value threshold are paid at booking.',
      code: 'tooExpensive',
      rules
    };
  }

  if (Number(distanceKm) > Number(rules.max_km_for_later)) {
    return {
      allowed: false,
      code: 'tooLong',
      km: Math.round(distanceKm),
      maxKm: rules.max_km_for_later,
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

  /**
   * Com www também.
   *
   * O _redirects manda tudo para o www — é lá que o site vive de
   * facto. Sem esta linha, o /maps chamava a API e o CORS
   * recusava, e o browser dizia só "Failed to fetch".
   */
  'https://www.airportlink.app',

  /**
   * O portal dos motoristas e o call centre.
   *
   * Vivem noutros domínios e chamam esta API — o portal para
   * definir a palavra-passe, o call centre para tudo o resto.
   *
   * Sem esta linha, o browser recusa o pedido e diz "Failed to
   * fetch", que não explica nada.
   */
  'https://drivers.airportlink.app',
  'https://callcentre.airportlink.app',

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
/**
 * O portal de motoristas também vive aqui.
 *
 * O mesmo módulo é montado nos dois serviços: aqui, para quem
 * chega pelo site principal, e no serviço de drivers, para quem
 * chega pelo subdomínio.
 *
 * O shared tem de existir — o partners.js espera as peças
 * partilhadas (asUser, chatFor) e sem elas rebenta na primeira
 * chamada.
 */
/**
 * As peças partilhadas.
 *
 * O partners.js foi separado em três — o portal, o call centre e
 * o que ambos usam. Aqui só se monta o portal, mas ele precisa do
 * shared na mesma.
 */
const sharedPeças = createShared({
  supabase,
  getUserFromRequest,
  email: {
    sendPartnerApplicationReceived,
    sendPartnerDecision,
    sendRideConfirmedToPartner,
    sendRideOffer,
    sendRideOfferReminder
  },
  config: {
    defaultCountry: process.env.DEFAULT_PARTNER_COUNTRY || 'PT'
  }
});

app.use(createPartnerRoutes({
  supabase,
  getUserFromRequest,
  requireAdmin,
  shared: sharedPeças,
  config: {
    defaultCountry: process.env.DEFAULT_PARTNER_COUNTRY || 'PT',
    // O calendário vive neste serviço, por isso o aviso é local.
    apiUrl: process.env.MAIN_API_URL || '',
    cronSecret: process.env.CRON_SECRET
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

/**
 * Qualquer erro da API vai para o canal de alarmes.
 *
 * O middleware das tarefas cobria os crons. Mas um erro no
 * checkout é uma venda perdida, e esse só aparecia na consola do
 * Render — onde ninguém olha até alguém se queixar.
 *
 * Isto apanha tudo o que responda com 5xx, e os 4xx que importam.
 * Não apanha os 404 nem os 403: um endereço errado ou uma sessão
 * expirada não são problemas nossos.
 */
/**
 * ---------------------------------------------------------------
 * OS CABEÇALHOS DE SEGURANÇA
 *
 * Escritos à mão em vez do helmet. São seis linhas contra uma
 * dependência de 90 KB — e, mais importante, escritos aqui
 * consigo explicar o que cada um faz.
 *
 * Uma biblioteca que põe quinze cabeçalhos por omissão acaba por
 * ser desligada à primeira coisa que parte, e desligada fica.
 * ---------------------------------------------------------------
 */
app.use((req, res, next) => {
  /**
   * Só HTTPS, e o browser lembra-se.
   *
   * Um ano. Sem isto, alguém que escreva "airportlink.app" na
   * barra faz o primeiro pedido em HTTP — e nesse pedido vai o
   * cookie de sessão em claro, numa rede de aeroporto onde
   * qualquer um o lê.
   *
   * Sem preload de propósito: entrar na lista do Chrome é
   * irreversível na prática, e não se faz com um domínio de dois
   * meses.
   */
  res.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');

  /**
   * O browser não adivinha o tipo do ficheiro.
   *
   * Sem isto, um ficheiro que um parceiro carregue como .jpg mas
   * que contenha HTML pode ser servido como página — e correr
   * JavaScript no nosso domínio.
   */
  res.set('X-Content-Type-Options', 'nosniff');

  /**
   * Ninguém nos põe num iframe.
   *
   * É o ataque de sobrepor um botão invisível sobre o nosso: a
   * pessoa julga que clica noutra coisa e reserva uma viagem.
   */
  res.set('X-Frame-Options', 'DENY');

  /**
   * O endereço não viaja para fora.
   *
   * Um link de /myaccount?booking=AL123 para um site externo
   * levava a referência da reserva no cabeçalho Referer. Com
   * same-origin, sites externos só recebem o domínio.
   */
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');

  /**
   * Nada de câmara, microfone ou localização.
   *
   * Não usamos nenhum. Declará-lo impede que um script de
   * terceiros os peça em nosso nome — e o pedido apareceria com o
   * nosso nome na caixa do browser.
   */
  res.set('Permissions-Policy',
    'camera=(), microphone=(), geolocation=(), payment=(self)');

  next();
});


/**
 * ---------------------------------------------------------------
 * UM LIMITE POR ENDEREÇO
 *
 * A rota do checkout podia ser chamada mil vezes por segundo. Cada
 * chamada custa uma ida à API do Google Directions e uma ao
 * Stripe — e a quota do Google é diária.
 *
 * Um script simples esvaziava-a numa hora, e a partir daí nenhum
 * cliente conseguia um preço. Não é preciso má intenção: um bot de
 * indexação mal configurado faz o mesmo.
 *
 * SEM DEPENDÊNCIAS
 *
 * O express-rate-limit resolveria isto, mas são mais 200 KB e uma
 * atualização a acompanhar. Um Map em memória chega para um
 * servidor só — e é o que temos.
 *
 * O QUE ISTO NÃO É
 *
 * Não é proteção contra um ataque a sério: um atacante com mil
 * endereços passa. É proteção contra o caso comum — um script, um
 * bot, um botão carregado vinte vezes por impaciência.
 * ---------------------------------------------------------------
 */
const janelas = new Map();

function limitar(nome, req, res, { max, segundos }) {
  /**
   * O endereço real, atrás do proxy.
   *
   * O Render põe o IP verdadeiro no x-forwarded-for. Sem isto,
   * todos os pedidos vinham do mesmo endereço — o do proxy — e o
   * limite bloqueava toda a gente ao mesmo tempo.
   */
  const ip = String(req.headers['x-forwarded-for'] || '')
    .split(',')[0].trim() || req.ip || 'sem-ip';

  const chave = `${nome}:${ip}`;
  const agora = Date.now();

  let j = janelas.get(chave);

  if (!j || agora > j.ate) {
    j = { contagem: 0, ate: agora + segundos * 1000 };
    janelas.set(chave, j);
  }

  j.contagem += 1;

  if (j.contagem > max) {
    const faltam = Math.ceil((j.ate - agora) / 1000);

    res.set('Retry-After', String(faltam));

    res.status(429).json({
      error: 'Too many requests. Wait a moment and try again.',
      retry_after_seconds: faltam
    });

    return true;
  }

  return false;
}


/**
 * A memória não cresce sem fim.
 *
 * Cada endereço que chegue deixa uma entrada. Sem limpeza, um mês
 * de tráfego são centenas de milhares de linhas num Map que nunca
 * é lido outra vez.
 */
setInterval(() => {
  const agora = Date.now();

  for (const [k, j] of janelas) {
    if (agora > j.ate) janelas.delete(k);
  }
}, 60000).unref();


app.use((req, res, next) => {
  // As tarefas têm o seu próprio middleware, mais detalhado.
  if (req.path.startsWith('/api/tasks')) return next();

  // Só o que é API. Os ficheiros estáticos não interessam.
  if (!req.path.startsWith('/api/')) return next();

  const jsonOriginal = res.json.bind(res);

  res.json = (body) => {
    try {
      const codigo = res.statusCode;

      /**
       * O que vale um alarme.
       *
       * 5xx é sempre nosso — o servidor rebentou.
       *
       * 400 num checkout é um cliente que não conseguiu comprar, e
       * isso interessa saber. 400 noutro sítio pode ser só um
       * pedido mal formado.
       *
       * 401, 403 e 404 não avisam: são sessões expiradas e
       * endereços errados, e encheriam o canal.
       */
      const critico = /checkout|payment|charge|booking|refund|webhook/.test(req.path);

      /**
       * As rotas que batem sozinhas não alarmam.
       *
       * Quando o Render adormece, a primeira chamada de cada uma
       * dá 504 — e o canal enchia-se de avisos sobre uma coisa que
       * se resolve ao acordar.
       */
      const bateSozinha = /\/(presence|tick|health|ping|heartbeat|rates)/.test(req.path);

      /**
       * E o 5xx do proxy é do proxy.
       *
       * Um 502 ou 504 é o Render a acordar ou a rede a falhar. O
       * código nem chegou a correr.
       */
      const daInfraestrutura = codigo === 502 || codigo === 503 || codigo === 504;

      if (bateSozinha || daInfraestrutura) {
        return jsonOriginal(body);
      }

      /**
       * Um 400 de validação não é um erro nosso.
       *
       * Alguém tentou reservar sem escolher data e o servidor
       * recusou — que é exatamente o que ele deve fazer. Avisar
       * sobre isso é avisar que o código funciona.
       *
       * O que interessa saber é quando uma reserva VÁLIDA falha:
       * o Stripe em baixo, a base a recusar, o Google sem quota.
       * Esses são 500.
       */
      /**
       * A resposta diz se é validação.
       *
       * Comparar o texto da mensagem funcionava até alguém mudar
       * uma palavra — e depois o canal enchia-se outra vez, sem
       * ninguém perceber porquê.
       *
       * Um campo na resposta é explícito: quem escreve a
       * validação decide, e não há regex a adivinhar.
       */
      const validacao = codigo === 400 && body?.field_error === true;

      if (validacao) {
        return jsonOriginal(body);
      }

      if (codigo >= 500 || (codigo === 400 && critico)) {
        telegramTaskFailed(
          `${req.method} ${req.path}`,
          body?.error || `HTTP ${codigo}`
        ).catch(() => {});
      }
    } catch (e) {
      // Um alarme que falha não deve travar a resposta.
    }

    return jsonOriginal(body);
  };

  next();
});


app.use('/api/tasks', (req, res, next) => {
  const nome = req.path.replace(/^\//, '') || 'task';

  // Os testes não valem alarme: são corridos à mão de propósito.
  if (/test|preview/.test(nome)) return next();

  const jsonOriginal = res.json.bind(res);

  res.json = (body) => {
    try {
      const falhas = body?.failures;

      if (res.statusCode >= 400) {
        telegramTaskFailed(nome,
          body?.error || `HTTP ${res.statusCode}`).catch(() => {});
      } else if (Array.isArray(falhas) && falhas.length) {
        telegramTaskFailed(nome,
          falhas.map((f) => `${f.part}: ${f.error}`).join('\n')).catch(() => {});
      } else if (body?.ok === false) {
        telegramTaskFailed(nome, body.reason || 'returned ok:false').catch(() => {});
      } else {
        telegramTaskRecovered(nome).catch(() => {});
      }
    } catch (e) {
      // Um alarme que falha não deve travar a resposta.
    }

    return jsonOriginal(body);
  };

  next();
});


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
  // A oferta com prazo, mandada pelo serviço de drivers quando a
  // cascata avança. Sem ela, só o primeiro parceiro de cada viagem
  // era avisado.
  ride_offer: (p) => sendRideOffer(p.partner, p.booking, p.offer),
  // O empurrão a meio do prazo. É o que mais reduz o ignorar.
  ride_offer_reminder: (p) =>
    sendRideOfferReminder(p.partner, p.booking, p.offer),
  // A viagem mudou depois de ele a aceitar.
  ride_changed: (p) => sendRideChanged(p.partner, p.booking, p.mudanca),
  // Um agente respondeu a um ticket.
  ticket_reply: (p) => sendTicketReply(p.chat, p.mensagem, p.agente),
  // O link de confirmação só pode ser gerado aqui: é este serviço
  // que tem o cliente com service_role.
  verify_email: (p) => sendVerification(p.email, p.name, p.kind || 'partner'),

  /**
   * Um parceiro à espera há dez minutos com um agente atribuído.
   *
   * Vai para o endereço de operações e não para o agente: o agente
   * já viu o aviso no painel duas vezes. Este email existe para o
   * caso de ele não estar a ver o painel de todo.
   */
  support_escalation: async (p) => {
    const nome = p.partner_name || 'A partner';
    const min = p.waiting_minutes || 10;

    await notifyOps(`${nome} has been waiting ${min} minutes for a reply`, [
      `Partner: ${nome}`,
      `Waiting: ${min} minutes since their last message`,
      'The conversation is assigned to an agent — it is not sitting in the queue.',
      'Somebody took it and has not answered.',
      `Chat: ${p.chat_id || '(unknown)'}`
    ]);

    return { sent: true };
  }
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

/**
 * Envia os dados do motorista de uma viagem.
 *
 * Usada pelo cron e pelo botão do admin. A ordem importa: um
 * motorista posto à mão ganha sempre ao do parceiro, porque foi
 * posto à mão precisamente quando o do parceiro não servia.
 */
async function sendDriverDetailsFor(ride) {
  let driver = null;
  let vehicle = null;

  if (ride.manual_driver_name) {
    driver = {
      full_name: ride.manual_driver_name,
      phone: ride.manual_driver_phone || ''
    };
    vehicle = ride.manual_vehicle
      ? {
          make: ride.manual_vehicle,
          model: '',
          plate: ride.manual_vehicle_plate || ''
        }
      : null;
  } else if (ride.assigned_partner_id) {
    const [driverRes, vehicleRes] = await Promise.all([
      supabase.from('drivers').select('*')
        .eq('partner_id', ride.assigned_partner_id)
        .eq('status', 'active').order('created_at').limit(1).maybeSingle(),
      supabase.from('partner_vehicles').select('*')
        .eq('partner_id', ride.assigned_partner_id)
        .eq('status', 'active')
        .gte('seats', ride.passengers || 1)
        .order('seats').limit(1).maybeSingle()
    ]);

    driver = driverRes.data;
    vehicle = vehicleRes.data;
  }

  if (!driver) {
    // Sem motorista não há email. É um problema real, porque a
    // viagem é amanhã e o cliente não sabe quem o vai buscar.
    await notifyOps('Ride tomorrow with no driver', [
      `Reference: ${ride.booking_reference || ride.booking_id}`,
      `Route: ${ride.pickup} to ${ride.dropoff}`,
      `Pick-up: ${ride.booking_date} ${String(ride.booking_time || '').slice(0, 5)}`,
      ride.assigned_partner_id
        ? 'A partner took this ride but has no active driver on file.'
        : 'Nobody has taken this ride.',
      '',
      'Add a driver by hand in the admin, or put the email on hold.'
    ]);

    return { sent: false, reason: 'no-driver' };
  }

  const result = await sendDriverDetails(ride, driver, vehicle);

  if (result.sent) {
    await supabase.from('bookings').update({
      driver_details_sent_at: new Date().toISOString()
    }).eq('id', ride.id);
  }

  return result;
}

/**
 * Suster, libertar, ou pôr um motorista à mão.
 *
 * Uma rota para as três coisas porque são a mesma decisão vista de
 * ângulos diferentes: quem vai buscar o cliente amanhã.
 */
app.post('/api/admin/ride-driver', async (req, res) => {
  const { user: admin, error: adminError } = await requireAdmin(req);
  if (!admin) return res.status(403).json({ error: adminError || 'Administrator access required.' });

  const { booking_id, action, driver, reason } = req.body || {};

  if (!booking_id || !['hold', 'release', 'manual', 'send'].includes(action)) {
    return res.status(400).json({
      error: 'Send booking_id and action: hold, release, manual or send.'
    });
  }

  try {
    if (action === 'hold') {
      await supabase.from('bookings').update({
        driver_email_hold: true,
        driver_email_hold_reason: reason || null,
        updated_at: new Date().toISOString()
      }).eq('id', booking_id);

      return res.json({ success: true, held: true });
    }

    if (action === 'release') {
      await supabase.from('bookings').update({
        driver_email_hold: false,
        driver_email_hold_reason: null,
        updated_at: new Date().toISOString()
      }).eq('id', booking_id);

      return res.json({ success: true, held: false });
    }

    if (action === 'manual') {
      if (!driver?.name || !driver?.phone) {
        return res.status(400).json({
          error: 'A name and a phone number are the minimum — the passenger calls that number.'
        });
      }

      /**
       * E o número tem de marcar.
       *
       * Verificava-se que existia. Um agente com pressa escreve
       * "ver no whatsapp" e o campo passa — mas é este o número
       * que vai no SMS ao cliente, e quem o marca é alguém sozinho
       * num aeroporto à noite.
       */
      if (String(driver.phone).replace(/\D/g, '').length < 6) {
        return res.status(400).json({
          error: 'That phone number is too short. ' +
                 'The passenger calls it on the day.',
          field_error: true
        });
      }

      await supabase.from('bookings').update({
        manual_driver_name: driver.name,
        manual_driver_phone: driver.phone,
        manual_vehicle: driver.vehicle || null,
        manual_vehicle_plate: driver.plate || null,
        manual_driver_note: driver.note || null,
        // Pôr um motorista à mão levanta a retenção: a razão para a
        // suspender era não haver motorista, e agora há.
        driver_email_hold: false,
        driver_email_hold_reason: null,
        updated_at: new Date().toISOString()
      }).eq('id', booking_id);

      console.log('Manual driver set:', { by: admin.email, booking: booking_id });

      return res.json({ success: true });
    }

    // send
    const { data: ride } = await supabase.from('bookings')
      .select('*').eq('id', booking_id).maybeSingle();

    if (!ride) return res.status(404).json({ error: 'That booking no longer exists.' });

    // O envio manual ignora a marca de já enviado: às vezes é
    // preciso reenviar porque o motorista mudou.
    await supabase.from('bookings').update({
      driver_details_sent_at: null
    }).eq('id', booking_id);

    const result = await sendDriverDetailsFor({ ...ride, driver_details_sent_at: null });

    if (!result.sent) {
      return res.status(400).json({
        error: result.reason === 'no-driver'
          ? 'There is no driver for this ride yet. Add one by hand first.'
          : (result.reason || 'Could not send.')
      });
    }

    return res.json({ success: true, sent: true });
  } catch (error) {
    console.error('admin/ride-driver error:', error);
    return res.status(500).json({ error: 'Could not update that ride.' });
  }
});

/**
 * Os extratos do mês passado.
 *
 * Corre uma vez por mês, no dia 1. Se correr duas vezes não faz mal:
 * a chave de idempotência inclui o mês, e o segundo envio é
 * descartado antes de sair.
 *
 * cron-job.org → POST /api/tasks/monthly-statements
 *                dia 1 de cada mês, 09:30
 *
 * Aceita { "month": "2026-07" } para reenviar um mês concreto —
 * útil quando alguém pede o extrato de há três meses.
 */
app.post('/api/tasks/monthly-statements', async (req, res) => {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured.' });
  }
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  // Por omissão, o mês passado: no dia 1 é esse que interessa.
  let month = req.body && req.body.month;

  if (!month) {
    const d = new Date();
    d.setMonth(d.getMonth() - 1);
    month = d.toISOString().slice(0, 7);
  }

  if (!/^\d{4}-\d{2}$/.test(month)) {
    return res.status(400).json({ error: 'month must look like 2026-07.' });
  }

  const from = `${month}-01`;
  const to = new Date(month + '-01T12:00:00');
  to.setMonth(to.getMonth() + 1);
  const until = to.toISOString().slice(0, 10);

  const out = { month, partners: 0, agents: 0, skipped: 0, errors: [] };

  // ---------- parceiros ----------
  try {
    const { data: rides, error } = await supabase
      .from('bookings')
      .select('id, booking_id, booking_reference, pickup, dropoff, booking_date, ' +
              'booking_time, driver_payout, driver_payout_eur, currency, assigned_partner_id')
      .not('assigned_partner_id', 'is', null)
      .neq('status', 'cancelled')
      .gte('booking_date', from)
      .lt('booking_date', until)
      .order('booking_date');

    if (error) throw error;

    const byPartner = new Map();

    for (const ride of (rides || [])) {
      if (!byPartner.has(ride.assigned_partner_id)) {
        byPartner.set(ride.assigned_partner_id, []);
      }
      byPartner.get(ride.assigned_partner_id).push(ride);
    }

    for (const [partnerId, list] of byPartner) {
      const { data: partner } = await supabase
        .from('driver_partners')
        .select('id, email, legal_name, trading_name, payout_iban, status')
        .eq('id', partnerId).maybeSingle();

      if (!partner?.email) {
        out.skipped += 1;
        continue;
      }

      // Em euros, à taxa do dia de cada viagem — nunca à de hoje.
      const total = list.reduce((t, r) =>
        t + Number(r.driver_payout_eur || r.driver_payout || 0), 0);

      const result = await sendPartnerStatement(partner, month, list, total);
      if (result.sent) out.partners += 1;

      if (!partner.payout_iban) {
        await notifyOps('Partner with no IBAN has money owed', [
          `Partner: ${partner.legal_name} (${partner.email})`,
          `Month: ${month}`,
          `Rides: ${list.length}`,
          `Owed: EUR ${total.toFixed(2)}`,
          '',
          'They cannot be paid until they add payout details.'
        ]);
      }
    }
  } catch (error) {
    out.errors.push('partners: ' + error.message);
  }

  // ---------- agências ----------
  try {
    const { data: bookings, error } = await supabase
      .from('bookings')
      .select('id, booking_id, booking_reference, booking_date, passenger_name, ' +
              'price, price_eur, agent_gross_price, currency, agent_reference, booked_by')
      .not('booked_by', 'is', null)
      .neq('status', 'cancelled')
      .gte('booking_date', from)
      .lt('booking_date', until)
      .order('booking_date');

    if (error) throw error;

    const byAgent = new Map();

    for (const b of (bookings || [])) {
      if (!byAgent.has(b.booked_by)) byAgent.set(b.booked_by, []);
      byAgent.get(b.booked_by).push(b);
    }

    for (const [agentId, list] of byAgent) {
      const { data: agent } = await supabase
        .from('travel_agents')
        .select('id, email, agency_name, commission, status')
        .eq('id', agentId).maybeSingle();

      if (!agent?.email) {
        out.skipped += 1;
        continue;
      }

      const paid = list.reduce((t, b) => t + Number(b.price_eur || b.price || 0), 0);
      const gross = list.reduce((t, b) =>
        t + Number(b.agent_gross_price || b.price_eur || b.price || 0), 0);

      const result = await sendAgentStatement(agent, month, list, { paid, gross });
      if (result.sent) out.agents += 1;
    }
  } catch (error) {
    out.errors.push('agents: ' + error.message);
  }

  console.log('[monthly-statements]', out);

  // Um resumo para ti, para saberes que correu sem ires aos logs.
  await notifyOps(`Statements sent for ${month}`, [
    `${out.partners} partner statement(s)`,
    `${out.agents} agency statement(s)`,
    out.skipped ? `${out.skipped} skipped (no email on file)` : '',
    out.errors.length ? 'Errors: ' + out.errors.join(' · ') : ''
  ].filter(Boolean));

  return res.json({ ok: true, ...out });
});

/**
 * As viagens sem motorista.
 *
 * Corre de dez em dez minutos, não uma vez por dia. Uma venda às
 * 23h para as 8h da manhã não aparece num resumo das 18h — e às 6h
 * já é tarde para procurar parceiro.
 *
 * A tolerância antes de avisar depende de quanto falta: meia hora
 * para viagens dentro de 12 horas, seis horas para as de daqui a
 * semanas. Sem isso, cada venda disparava um alarme antes de a
 * cascata ter tempo de encontrar alguém.
 */
app.post('/api/tasks/driver-watch', async (req, res) => {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured.' });
  }
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const { data: semMotorista, error } = await supabase
      .rpc('bookings_needing_driver');

    if (error) throw error;

    const lista = semMotorista || [];

    if (!lista.length) {
      return res.json({ ok: true, alerts: 0 });
    }

    await telegramNoDriver(lista);

    /**
     * Marcar depois de avisar.
     *
     * Uma reserva avisada não volta a disparar. Se voltasse, uma
     * viagem sem motorista durante três dias mandaria um alarme de
     * dez em dez minutos — e ao fim de uma hora ninguém os lê.
     */
    for (const b of lista) {
      await supabase.rpc('mark_no_driver_alerted', { p_booking_id: b.booking_id });
    }

    return res.json({
      ok: true,
      alerts: lista.length,
      critical: lista.filter((b) => b.urgency === 'critical').length
    });
  } catch (error) {
    console.error('driver-watch:', error);
    return res.status(500).json({ error: error.message });
  }
});


/**
 * O resumo do dia, à meia-noite.
 *
 * Duas coisas diferentes que se confundem: o que ENTROU hoje
 * (vendas) e o que se FEZ hoje (viagens operadas). Uma reserva
 * pode entrar hoje para daqui a três semanas, e uma viagem de hoje
 * pode ter sido vendida em agosto.
 *
 * Não é um alarme — os alarmes já dispararam quando havia razão.
 */
app.post('/api/tasks/day-summary', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const { data } = await supabase.rpc('day_summary', { p_day: null });

    await telegramDaySummary(data);

    return res.json({ ok: true, ...(data || {}) });
  } catch (error) {
    console.error('day-summary:', error);
    return res.status(500).json({ error: error.message });
  }
});


/**
 * O motorista aceitou: a viagem passa a azul na agenda.
 *
 * Chamada pelo serviço de drivers. O calendário vive aqui porque é
 * aqui que estão as credenciais do Google — o outro serviço só
 * avisa.
 */
app.post('/api/internal/calendar-sync', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { booking_id, partner_id } = req.body || {};
  if (!booking_id) return res.status(400).json({ error: 'Send booking_id.' });

  try {
    const { data: booking } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', booking_id)
      .maybeSingle();

    if (!booking) return res.status(404).json({ error: 'Booking not found.' });

    const { data: partner } = partner_id
      ? await supabase
          .from('driver_partners')
          .select('trading_name, legal_name')
          .eq('id', partner_id)
          .maybeSingle()
      : { data: null };

    const result = await calendarUpsert(booking, partner);

    return res.json(result);
  } catch (error) {
    console.error('calendar-sync:', error);
    return res.status(500).json({ error: error.message });
  }
});


/**
 * Correr uma tarefa automática e avisar se falhar.
 *
 * As tarefas corriam com um try/catch que registava o erro na
 * consola do Render — onde ninguém olha. O Google Calendar falhou
 * uma semana inteira em silêncio, e só se descobriu quando uma
 * reserva não apareceu na agenda.
 *
 * Agora cada falha vai para o canal de alarmes, com som. E quando
 * a tarefa voltar a funcionar, avisa também: sem isso, alguém vai
 * investigar um problema que já se resolveu.
 */

app.get('/api/exchange-rates', async (req, res) => {
  // Sessenta por minuto: é lida no arranque de cada página.
  if (limitar('rates', req, res, { max: 60, segundos: 60 })) return;

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
 * A conta de quem reservou sem se registar.
 *
 * Criamos uma na mesma, com o email da reserva, e mandamos-lhe um
 * link para escolher password. Assim ninguém é obrigado a registar-se
 * a meio de uma compra — que é onde se perdem clientes — mas quem
 * voltar encontra o histórico à espera.
 *
 * Devolve o link, ou null se a conta já existia (aí a pessoa já sabe
 * entrar e mandar-lhe um link de password seria estranho).
 */
/**
 * Garantir a linha de contacto, sem depender de indices.
 *
 * Os tres upserts que aqui havia usavam onConflict: 'email' ou
 * 'id' — e o Postgres recusa isso quando a coluna nao tem indice
 * unico, com um "no unique or exclusion constraint matching".
 *
 * O erro sai do supabase-js como um objeto de erro que ninguem
 * verificava: a linha nao era escrita e a vida seguia, ate a
 * reserva rebentar a apontar para um contacto que nao existe.
 *
 * Procurar-e-escrever nao precisa de indice nenhum. E uma
 * consulta a mais e funciona sempre.
 */
async function garantirContacto({ id, email, nome, telefone, admin, extra }) {
  if (!email) return null;

  const limpo = String(email).trim();

  const { data: existente } = await supabase
    .from('contacts')
    .select('id, full_name, phone_number')
    .ilike('email', limpo)
    .maybeSingle();

  if (existente) {
    /**
     * Ja existe: so preenche o que estiver em branco.
     *
     * Um nome que o cliente escreveu numa reserva antiga vale
     * mais do que o que vem agora vazio.
     */
    const patch = {};
    if (nome && !existente.full_name) patch.full_name = nome;
    if (telefone && !existente.phone_number) patch.phone_number = telefone;

    Object.assign(patch, extra || {});

    if (Object.keys(patch).length) {
      await supabase.from('contacts').update(patch).eq('id', existente.id);
    }

    return existente.id;
  }

  const { data: criado, error } = await supabase
    .from('contacts')
    .insert({
      id: id || undefined,
      email: limpo,
      full_name: nome || null,
      phone_number: telefone || null,
      is_admin: Boolean(admin),

      // Campos que so alguns chamadores tem — as linguas
      // preferidas do registo, por exemplo.
      ...(extra || {})
    })
    .select('id')
    .single();

  if (error) {
    // Corrida entre dois pedidos: alguem criou entretanto.
    if (error.code === '23505') {
      const { data: outra } = await supabase
        .from('contacts').select('id').ilike('email', limpo).maybeSingle();
      return outra?.id || null;
    }

    console.error('[contacts] nao consegui criar', limpo, error.message);
    return null;
  }

  return criado?.id || null;
}


async function ensureGuestAccount(email, name, phone) {
  if (!email) return null;

  try {
    const { data: existing } = await supabase
      .from('contacts')
      .select('id')
      .ilike('email', email)
      .maybeSingle();

    if (existing?.id) return { userId: existing.id, link: null };

    // Password aleatória que ninguém vai usar: a pessoa entra pelo
    // link, e uma password vazia não é permitida.
    const { data: created, error } = await supabase.auth.admin.createUser({
      email,
      password: crypto.randomUUID() + crypto.randomUUID(),
      email_confirm: true,
      user_metadata: { full_name: name || '', created_via: 'guest_booking' }
    });

    if (error || !created?.user) {
      /**
       * A conta ja existe em auth.users mas nao em contacts.
       *
       * Acontece quando a linha do contacto foi apagada, ou
       * quando a conta nasceu por outro caminho — um parceiro que
       * depois reserva como cliente, por exemplo.
       *
       * Devolver null aqui era o pior dos dois mundos: a reserva
       * seguia em frente e rebentava a apontar para um contacto
       * que nao existe, com um "violates foreign key constraint"
       * que nao diz nada sobre a causa.
       *
       * O que falta e a linha em contacts. Vamos busca-la ao
       * auth.users e cria-la.
       */
      const jaExiste = /already been registered|already exists/i
        .test(error?.message || '');

      if (jaExiste) {
        console.log('[guest] conta ja existe, a repor o contacto:', email);

        const { data: lista } = await supabase.auth.admin.listUsers();

        const u = (lista?.users || []).find(
          (x) => x.email?.toLowerCase() === String(email).toLowerCase()
        );

        if (u) {
          await garantirContacto({
            id: u.id, email, nome: name || u.user_metadata?.full_name,
            telefone: phone
          });

          console.log('[guest] contacto reposto para', email);

          return { userId: u.id, link: null };
        }
      }

      console.error('guest account failed:', error?.message);
      return null;
    }

    await garantirContacto({
      id: created.user.id, email, nome: name, telefone: phone
    });

    const { data: linkData } = await supabase.auth.admin.generateLink({
      type: 'recovery',
      email,
      options: { redirectTo: `${SITE_ORIGIN}/resetpassword` }
    });

    console.log('Guest account created for', email);

    return {
      userId: created.user.id,
      link: linkData?.properties?.action_link || null
    };
  } catch (error) {
    console.error('ensureGuestAccount error:', error);
    return null;
  }
}

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
/**
 * O email de confirmação de conta.
 *
 * Esta função não fazia nada. O comentário dizia "o Supabase já
 * enviou quando a conta foi criada" — e isso é verdade para o
 * signUp, mas NÃO para o admin.createUser, que é o que o registo
 * de parceiros usa.
 *
 * Resultado: o parceiro registava-se, ficava com email_confirm a
 * false, não recebia nada, e não conseguia entrar para enviar os
 * documentos.
 *
 * Havia registos e nenhuma conta chegava a ser validada. Foi
 * assim durante semanas, e nada disto dava erro: a função
 * devolvia { sent: true }.
 */
/**
 * O email que diz que a conta está pronta.
 *
 * Já não gera link mágico. Um magiclink expira em uma hora — quem
 * abre o email à noite e clica de manhã encontra-o morto, e a
 * mensagem do Supabase não explica nada.
 *
 * O parceiro escolheu uma palavra-passe ao registar-se. O que
 * falta é dizer-lhe que a conta está ativa e onde entrar.
 *
 * A confirmação do email faz-se à parte: o admin.createUser cria
 * a conta com email_confirm a false, e é isso que se corrige aqui
 * antes de mandar o email.
 */
/**
 * Confirmar o email pelo lado do servidor.
 *
 * O admin.createUser cria a conta com email_confirm a false, e
 * sem isto o Supabase recusa o login com "Email not confirmed" —
 * o parceiro fica de fora mesmo sabendo a palavra-passe.
 *
 * É seguro: a conta foi criada com um endereço que ele escreveu,
 * e o email que segue chega a esse endereço. Se não for dele, não
 * recebe nada.
 */
async function confirmarEmailDe(userId, email) {
  try {
    if (!userId) return false;

    const { data } = await supabase.auth.admin.getUserById(userId);

    if (data?.user?.email_confirmed_at) return true;

    const { error } = await supabase.auth.admin.updateUserById(
      userId, { email_confirm: true }
    );

    if (error) {
      console.error('[verify] não consegui confirmar', email, error.message);
      return false;
    }

    console.log('[verify] email confirmado para', email);
    return true;
  } catch (e) {
    console.error('[verify] confirmar falhou:', e.message);
    return false;
  }
}


async function sendVerification(email, name, kind) {
  if (!email) return { sent: false, reason: 'no-email' };

  try {
    /**
     * Confirmar o email pelo lado do servidor.
     *
     * Sem isto, o Supabase recusa o login com "Email not
     * confirmed" — e o parceiro fica de fora mesmo sabendo a
     * palavra-passe.
     *
     * Confirmá-lo por ele é seguro: a conta foi criada com um
     * endereço que ele escreveu, e o email que segue chega a esse
     * endereço. Se não for dele, não recebe nada.
     */
    const { data: lista } = await supabase.auth.admin.listUsers();

    const u = (lista?.users || []).find(
      (x) => x.email?.toLowerCase() === email.toLowerCase()
    );

    if (u && !u.email_confirmed_at) {
      const { error: confErro } = await supabase.auth.admin.updateUserById(
        u.id, { email_confirm: true }
      );

      if (confErro) {
        console.error('[verify] não consegui confirmar', email, confErro.message);
      } else {
        console.log('[verify] email confirmado para', email);
      }
    }

    if (kind === 'partner') {
      return await sendVerifyPartner({ email, name });
    }

    return await sendVerifyCustomer({ email, name });
  } catch (e) {
    console.error('[verify] falhou para', email, e.message);

    telegramTaskFailed('verification email',
      `${email} (${kind}) não recebeu o email: ${e.message}.`
    ).catch(() => {});

    return { sent: false, reason: e.message };
  }
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

    const idContacto = await garantirContacto({
      id: authData.user.id,
      email,
      nome: name,
      telefone: phone,
      extra: {
        // Preferência, não garantia. No máximo duas: mais do que isso
        // deixa de ser uma preferência e passa a ser uma lista de desejos.
        preferred_languages: Array.isArray(preferred_languages) && preferred_languages.length
          ? preferred_languages.slice(0, 2)
          : null
      }
    });

    const contactError = idContacto ? null : new Error('contact row missing');

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

    /**
     * E o canal de vendas, em silêncio.
     *
     * Uma conta nova é alguém que pode vir a reservar, e o número
     * por semana diz se o site está a converter. Silenciosa
     * porque, num dia bom, são muitas — e muitos apitos ensinam a
     * ignorar o canal.
     */
    telegramNewAccount({
      full_name: name,
      email: email,
      source: 'website'
    }).catch(() => {});

    return res.json({ success: true });
  } catch (error) {
    console.error('Register error:', error);

    return res.status(500).json({
      success: false,
      message: error.message || 'Could not create account.'
    });
  }
});

/**
 * Servimos entre estes dois sítios?
 *
 * A calculadora pergunta antes de mostrar um preço. Dar um valor
 * para um sítio onde não há ninguém é vender uma coisa que não
 * existe — e a devolução do dinheiro não devolve a confiança.
 *
 * Pública: é a primeira coisa que acontece numa reserva, muito
 * antes de haver sessão.
 */
/**
 * ---------------------------------------------------------------
 * O PREÇO, CALCULADO NUM SÍTIO SÓ
 *
 * O site tinha uma cópia da fórmula. Duas cópias são duas
 * verdades: mudei a do servidor e a do browser ficou para trás, e
 * um cliente viu 87 euros na calculadora e 30 no checkout.
 *
 * Isto acaba com o problema pela raiz. A calculadora pergunta, o
 * servidor responde, e há uma fórmula só.
 *
 * Custa um pedido de rede por cotação. Vale a pena: um preço
 * errado custa a reserva inteira.
 * ---------------------------------------------------------------
 */
app.get('/api/price', async (req, res) => {
  if (limitar('price', req, res, { max: 40, segundos: 60 })) return;

  try {
    const km = Number(req.query.km);
    const pax = Number(req.query.pax) || 1;

    if (!Number.isFinite(km) || km < 0) {
      return res.status(400).json({ error: 'Send km.', field_error: true });
    }

    const de = String(req.query.from || '');
    const para = String(req.query.to || '');

    /**
     * O país fora da lista responde primeiro.
     *
     * Não vale a pena calcular um preço para um sítio onde não
     * operamos — e devolver preço E recusa ao mesmo tempo confunde
     * o site.
     */
    const foraDe = await paisForaDaLista(de);
    const foraPara = await paisForaDaLista(para);

    if (foraDe || foraPara) {
      return res.json({
        covered: false,
        blocked_country: foraDe || foraPara,
        message: `We are not operating in ${foraDe || foraPara} yet. ` +
                 'Write to us and we will tell you when we are.'
      });
    }

    /**
     * A regra do checkout, exatamente.
     *
     * O checkout usa o getDistanceAndDuration, que devolve
     * isPortugalRoute quando AS DUAS moradas dizem "portugal" — é
     * o que o Google escreve no fim da morada formatada.
     *
     * Eu tinha escrito outra regra aqui: qualquer menção a Lisboa,
     * Porto ou Faro em qualquer dos lados. Duas regras diferentes
     * para a mesma decisão dão dois preços diferentes.
     */
    const ptRota =
      de.toLowerCase().includes('portugal') &&
      para.toLowerCase().includes('portugal');

    const price = computePriceEUR(km, pax, ptRota, {
      vehicleClass: req.query.vehicle || null,
      pickupText: de,
      dropoffText: para,
      pickupTime: req.query.time || null,

      /**
       * A cidade e o país, ditos pelo Google.
       *
       * O browser guarda-os do address_components quando a pessoa
       * escolhe a morada. Adivinhar pelo texto é o que dava a
       * tarifa de Barcelona a uma rua em Ibiza.
       */
      pickupCity: req.query.from_city || null,
      dropoffCity: req.query.to_city || null,
      pickupCountry: req.query.from_country || null,
      dropoffCountry: req.query.to_country || null,
      pickupRegion: req.query.from_region || null,
      dropoffRegion: req.query.to_region || null
    });

    return res.json({
      covered: true,
      price_eur: Math.round(price * 100) / 100,
      night_surcharge: isNightPickup(req.query.time || null),
      vehicle: resolveVehicleClass(req.query.vehicle || null, pax)?.id || null
    });
  } catch (error) {
    console.error('price:', error.message);
    return res.status(500).json({ error: error.message });
  }
});


app.get('/api/coverage', async (req, res) => {
  if (limitar('coverage', req, res, { max: 30, segundos: 60 })) return;

  try {
    const de = String(req.query.from || '');
    const para = String(req.query.to || '');

    if (!de && !para) {
      return res.status(400).json({ error: 'Send from and to.' });
    }

    /**
     * Só se recusa o que sabemos que não servimos.
     *
     * Antes, procurava-se o país na lista dos que servimos e
     * recusava-se quando não aparecia. Mas "Hotel Maroa, Vigo" não
     * tem a palavra "Spain" — e era recusado, apesar de Vigo ser
     * uma cidade onde operamos.
     *
     * Agora: se o país estiver na lista dos que ficaram de fora,
     * recusa. Tudo o resto passa.
     */
    const foraDe = await paisForaDaLista(de);
    const foraPara = await paisForaDaLista(para);

    /**
     * Basta um lado estar fora.
     *
     * Um transfer de Faro para o Botswana não se faz, mesmo que a
     * origem seja um sítio onde operamos.
     */
    const bloqueado = foraDe || foraPara;

    return res.json({
      covered: !bloqueado,
      blocked_country: bloqueado || null,

      message: bloqueado
        ? `We are not operating in ${bloqueado} yet. ` +
          'Write to us and we will tell you when we are.'
        : null
    });
  } catch (error) {
    console.error('coverage:', error.message);

    // Na dúvida, deixa passar.
    return res.json({ covered: true, error: error.message });
  }
});



/**
 * Uma rede de segurança à volta de toda a rota.
 *
 * Quinze pontos desta função podem lançar — chamadas à base, ao
 * Google, ao Stripe, e leituras de campos que podem não existir.
 *
 * Quando uma delas rebenta fora de um try, o Express devolve a
 * página de erro por omissão. Essa resposta NÃO leva os
 * cabeçalhos de CORS, e o browser mostra "Failed to fetch" — que
 * não diz nada sobre a causa real.
 *
 * Com isto, qualquer falha devolve JSON com CORS. O cliente vê a
 * mensagem, e o registo do servidor tem o rasto.
 */
app.post('/api/create-checkout-session', async (req, res, next) => {
  try {
    await criarSessaoCheckout(req, res);
  } catch (error) {
    console.error('[checkout] falha não tratada:', error);

    telegramTaskFailed('checkout',
      `${error.message}\n${(error.stack || '').split('\n')[1] || ''}`
    ).catch(() => {});

    if (!res.headersSent) {
      return res.status(500).json({
        error: 'Something went wrong on our side. ' +
               'Try again, or write to us and we will book it by hand.'
      });
    }
  }
});


async function criarSessaoCheckout(req, res) {
  /**
   * Oito por minuto.
   *
   * É a rota mais cara: uma ida ao Google Directions e uma ao
   * Stripe por chamada. Ninguém reserva oito viagens num minuto —
   * e quem tenta está a testar ou a carregar no botão repetido.
   */
  if (limitar('checkout', req, res, { max: 8, segundos: 60 })) return;

  const { booking } = req.body;

  if (!booking || !booking.pickup || !booking.dropoff || !booking.email) {
    return res.status(400).json({
      error: 'Missing pickup, dropoff or email'
    });
  }

  /**
   * ---------------------------------------------------------------
   * O QUE O BROWSER VERIFICA, O SERVIDOR VERIFICA OUTRA VEZ
   *
   * O telefone passou sem validação até uma reserva chegar sem
   * ele. A verificação vivia só no browser — e um browser é código
   * que corre na máquina de outra pessoa.
   *
   * Não é preciso má intenção: uma extensão, um autopreenchimento
   * estranho, ou uma chamada direta à rota. A regra é simples — se
   * a reserva não serve sem o campo, o servidor recusa.
   * ---------------------------------------------------------------
   */

  /**
   * O email tem de ser um email.
   *
   * É por onde vai a confirmação, o recibo e o lembrete de 24
   * horas. Um endereço errado é uma reserva que existe e um
   * cliente que não sabe.
   *
   * A verificação é a mínima que faz sentido: alguma coisa, arroba,
   * alguma coisa, ponto, duas letras. Validar emails a sério é
   * impossível — o único teste real é mandar um.
   */
  const email = String(booking.email).trim();

  if (!/^[^\s@]+@[^\s@]+\.[a-z]{2,}$/i.test(email)) {
    return res.status(400).json({
      error: 'That email address does not look right. ' +
             'Check it — the confirmation goes there.',
      field_error: true
    });
  }

  /**
   * A data: existe, é uma data, e não é no passado.
   *
   * Sem isto, uma reserva para ontem entrava no sistema, aparecia
   * no calendário e ninguém a podia fazer. E uma para 2031 ocupava
   * a agenda para sempre.
   */
  /**
   * A data, com os dois nomes.
   *
   * A homepage manda "date", a página de checkout manda "date", e
   * o servidor lia "booking_date". Nenhuma das duas passava.
   *
   * Aceitar os dois é mais robusto do que escolher um: as páginas
   * evoluíram em alturas diferentes e nem todas foram
   * atualizadas ao mesmo tempo.
   */
  const dataStr = String(booking.booking_date || booking.date || '');

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dataStr)) {
    return res.status(400).json({ error: 'Pick a travel date.', field_error: true });
  }

  const horaStr = String(booking.booking_time || booking.time || '');

  if (!/^\d{2}:\d{2}$/.test(horaStr)) {
    return res.status(400).json({ error: 'Pick a pick-up time.', field_error: true });
  }

  const quando = new Date(`${dataStr}T${horaStr}:00`);

  if (Number.isNaN(quando.getTime())) {
    return res.status(400).json({ error: 'That date and time are not valid.', field_error: true });
  }

  /**
   * Duas horas de margem.
   *
   * É o mínimo para encontrar um motorista, ele receber a viagem e
   * chegar ao aeroporto. Uma reserva para daqui a vinte minutos é
   * uma que vai falhar — e é melhor recusá-la do que devolver o
   * dinheiro depois.
   */
  const MARGEM_HORAS = 2;
  const agora = Date.now();

  if (quando.getTime() < agora + MARGEM_HORAS * 3600000) {
    return res.status(400).json({
      error: 'We need at least two hours to arrange a driver. ' +
             'Pick a later time, or call us if it is urgent.',
      field_error: true
    });
  }

  /**
   * E não mais de dois anos.
   *
   * Ninguém reserva um transfer para daqui a três anos. Um ano de
   * distância já é raro; dois é a margem que não incomoda ninguém e
   * apanha um erro de digitação no ano.
   */
  if (quando.getTime() > agora + 730 * 86400000) {
    return res.status(400).json({
      error: 'That date is too far ahead. Check the year.',
      field_error: true
    });
  }

  /**
   * Os passageiros: um número, e um que caiba num carro.
   *
   * Zero passageiros dava um preço mínimo e uma viagem sem
   * ninguém. Cem dava um multiplicador absurdo — ou, pior, o
   * mínimo, porque nenhuma classe correspondia.
   */
  const pax = Number(booking.passengers);

  if (!Number.isInteger(pax) || pax < 1 || pax > 16) {
    return res.status(400).json({
      error: 'Passengers must be between 1 and 16. ' +
             'For a larger group, write to us and we will arrange it.',
      field_error: true
    });
  }

  /**
   * As moradas: alguma coisa que se possa escrever numa placa.
   *
   * Uma morada de três letras não leva ninguém a lado nenhum, e o
   * Google devolve-a como um sítio qualquer do mundo.
   */
  for (const [campo, valor] of [
    ['pickup', booking.pickup],
    ['dropoff', booking.dropoff]
  ]) {
    if (String(valor).trim().length < 4) {
      return res.status(400).json({
        error: `The ${campo === 'pickup' ? 'pick-up' : 'drop-off'} ` +
               'address is too short. Pick one from the suggestions.',
        field_error: true
      });
    }
  }

  /**
   * A classe de viatura, se vier.
   *
   * É opcional — sem ela, escolhe-se pelo número de passageiros.
   * Mas se vier, tem de existir: uma classe inventada caía no
   * ramo de omissão do cálculo e dava um preço que não é de
   * nenhuma viatura.
   */
  if (booking.vehicle_class) {
    /**
     * As classes vêm do cálculo, não de uma lista à mão.
     *
     * Esta lista dizia ['sedan', 'van', 'premium', 'minibus'] —
     * faltavam o van_sedan e o two_vans, que o site oferece, e
     * tinha um "minibus" que não existe em lado nenhum.
     *
     * Quem escolhesse Van + Sedan levava com "Unknown vehicle
     * class" e não conseguia pagar.
     *
     * Uma lista escrita à mão ao lado da lista a sério vai
     * divergir. Ler da fonte não pode divergir.
     */
    const conhecidas = Object.keys(VEHICLE_CLASSES);

    if (!conhecidas.includes(String(booking.vehicle_class).toLowerCase())) {
      console.warn('unknown vehicle class:', booking.vehicle_class,
        '| conhecidas:', conhecidas.join(', '));

      return res.status(400).json({
        error: 'Unknown vehicle class.',
        field_error: true
      });
    }
  }

  /**
   * O voo, se vier, tem forma de voo.
   *
   * Duas ou três letras e até quatro dígitos. Não confirmamos que
   * existe — isso é o AeroDataBox que faz depois — mas um campo
   * com trezentos caracteres não é um número de voo, e o que lá
   * estiver vai parar ao calendário e ao SMS do motorista.
   */
  if (booking.flight_number) {
    const voo = String(booking.flight_number).trim().toUpperCase();

    if (!/^[A-Z0-9]{2,3}\s?\d{1,4}[A-Z]?$/.test(voo)) {
      return res.status(400).json({
        error: 'That flight number does not look right. Example: TP1234.',
        field_error: true
      });
    }

    booking.flight_number = voo;
  }

  /**
   * O nome: alguma coisa que se possa escrever numa placa.
   *
   * Duas letras não é um nome, e é o que o motorista mostra na
   * chegada.
   */
  const nome = String(booking.full_name || booking.passenger_name || '').trim();

  if (nome.length < 2) {
    return res.status(400).json({
      error: 'A name is needed — the driver holds a sign with it.',
      field_error: true
    });
  }

  /**
   * E o tamanho de tudo o resto.
   *
   * Um campo de notas com cem mil caracteres enche a base, quebra
   * o email e nunca é lido. O corte é generoso: quinhentos
   * caracteres dão para escrever "somos quatro com um carrinho de
   * bebé e chegamos do voo da TAP".
   */
  for (const [campo, max] of [
    ['pickup', 300], ['dropoff', 300], ['notes', 500],
    ['full_name', 120], ['passenger_name', 120], ['email', 200]
  ]) {
    if (booking[campo] && String(booking[campo]).length > max) {
      booking[campo] = String(booking[campo]).slice(0, max);
    }
  }

  /**
   * O telefone é obrigatório, e a verificação tem de estar AQUI.
   *
   * O checkout já o exigia, mas uma reserva chegou sem ele — o que
   * significa que há outro caminho até esta rota, ou que alguém a
   * chamou diretamente.
   *
   * Sem número, o motorista não tem como avisar que chegou, nem
   * como encontrar quem espera num aeroporto com três saídas. É a
   * diferença entre uma viagem e uma reclamação.
   */
  const digitos = String(booking.phone_number || booking.passenger_phone || '')
    .replace(/\D/g, '');

  if (digitos.length < 6) {
    return res.status(400).json({
      error: 'A phone number is needed. The driver uses it to reach you on the day.',
      field_error: true
    });
  }

  /**
   * E o indicativo.
   *
   * Um número sem indicativo é um número que não marca. O
   * checkout tem um seletor obrigatório, mas isso vive no
   * browser — e o browser pode ser contornado.
   *
   * Antes era assumido 351 quando faltava, e um motorista em
   * Espanha marcava um número português que não existe.
   */
  const indicativo = String(booking.phone_code || '').replace(/\D/g, '');

  if (!indicativo || indicativo.length > 4) {
    return res.status(400).json({
      error: 'Pick the country code for your phone number.',
      field_error: true
    });
  }

  // O nome também: o motorista tem de saber por quem espera.
  if (String(booking.full_name || booking.passenger_name || '').trim().length < 2) {
    return res.status(400).json({ error: 'A name is needed for the booking.' });
  }

  /**
   * Entre um e dezasseis passageiros.
   *
   * O parseInt aceitava qualquer coisa: 999, -5, 1e10. O preco
   * trava nos dezasseis — a maior viatura — por isso nao havia
   * ganho em mentir, mas a reserva ficava com "999 passageiros"
   * e o motorista via isso no dia.
   *
   * E um numero negativo caia no || 1, o que escondia o erro em
   * vez de o dizer.
   */
  const passengers = Math.max(1, Math.min(16,
    parseInt(booking.passengers, 10) || 1
  ));
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

  /**
   * Sem distância, não se cobra.
   *
   * O Google devolveu uma rota mas com zero quilómetros — ou
   * devolveu uma rota diferente da que o cliente viu.
   *
   * Zero quilómetros dá o preço mínimo: 24 euros para uma viagem
   * de 75. E ninguém repara, porque o número sai bonito.
   *
   * Preferir um erro a uma cobrança errada: a reserva repete-se, o
   * preço já cobrado não se desfaz sem estragar a confiança.
   */
  if (!distanceKm || distanceKm <= 0) {
    console.error('checkout with no distance:',
      booking.pickup, '->', booking.dropoff);

    telegramTaskFailed('checkout',
      `No distance for ${booking.pickup} -> ${booking.dropoff}. ` +
      'The booking was refused instead of charged at the minimum.'
    ).catch(() => {});

    return res.status(400).json({
      error: 'We could not measure that route. ' +
             'Try again, or write to us and we will price it by hand.'
    });
  }

  /**
   * E a distância que o cliente viu manda.
   *
   * O Google pode devolver uma rota diferente da que a
   * calculadora usou — outro caminho, outro trânsito, outra
   * paragem. Uma diferença de dez por cento é normal; uma de
   * cinquenta significa que o cliente viu um preço e vai pagar
   * outro.
   *
   * Quando o site envia a distância, é essa que conta. É a que
   * está no preço que ele aceitou.
   */
  const kmDoCliente = Number(booking.distance_km) || 0;

  if (kmDoCliente > 0) {
    const desvio = Math.abs(kmDoCliente - distanceKm) / distanceKm;

    if (desvio > 0.25) {
      console.warn('distance mismatch:', kmDoCliente, 'vs', distanceKm,
        booking.pickup, '->', booking.dropoff);

      /**
       * Acima de 25% de diferenca, vale a MEDIDA.
       *
       * Isto avisava e usava o numero do cliente na mesma. Um
       * pedido com distance_km: 1 numa rota de 300 km pagava o
       * minimo de 24 euros — e a viagem acontecia na mesma.
       *
       * Nao e preciso ma intencao: um campo que fica a "..."
       * enquanto o mapa calcula ja o fez uma vez hoje, e deu 26
       * euros numa viagem de 87.
       *
       * Ate 25%, o do cliente conta: e o preco que ele viu e
       * aceitou, e o Google devolve rotas diferentes conforme o
       * transito.
       */
      telegramTaskFailed('distance mismatch',
        `${booking.pickup} -> ${booking.dropoff}\n` +
        `O browser enviou ${kmDoCliente} km, o Google mediu ` +
        `${distanceKm.toFixed(1)} km. Usada a medida.`
      ).catch(() => {});
    } else {
      distanceKm = kmDoCliente;
    }
  }

  /**
   * A última verificação, antes de cobrar.
   *
   * A calculadora já perguntou, mas o browser pode mentir — e uma
   * reserva paga para um sítio onde não há ninguém custa mais a
   * desfazer do que a recusar.
   */
  /**
   * A última verificação, antes de cobrar.
   *
   * Só recusa países que estão explicitamente fora. Uma morada que
   * não diga o país passa — e passa bem: a maioria das moradas
   * reais não tem o país escrito.
   */
  const foraDe = await paisForaDaLista(booking.pickup);
  const foraPara = await paisForaDaLista(booking.dropoff);

  if (foraDe || foraPara) {
    return res.status(400).json({
      error: `We are not operating in ${foraDe || foraPara} yet. ` +
             'Write to us and we will tell you when we are.',
      field_error: true
    });
  }

  const priceEUR = computePriceEUR(
    distanceKm,
    passengers,
    isPortugalRoute,
    {
      vehicleClass: booking.vehicle_class,
      pickupText: booking.pickup,
      dropoffText: booking.dropoff,

      /**
       * A cidade e o país, quando o site os enviou.
       *
       * Vêm do address_components do Google. Sem eles, o cálculo
       * cai no texto — que continua a funcionar para as reservas
       * antigas e para o call centre.
       */
      pickupCity: booking.pickup_city || null,
      dropoffCity: booking.dropoff_city || null,
      pickupCountry: booking.pickup_country || null,
      dropoffCountry: booking.dropoff_country || null,

      // A hora decide o suplemento noturno: 20% entre as 22h55 e
      // as 6h.
      pickupTime: booking.booking_time || booking.time
    }
  );

  /**
   * O que entrou no cálculo, escrito no registo.
   *
   * Um preço errado não deixa rasto: sai um número bonito e
   * ninguém sabe de onde veio. Estas quatro linhas dizem-no.
   *
   * Sem isto, um cliente que veja 75 na calculadora e 24 no
   * checkout obriga a adivinhar — e adivinhei três vezes hoje.
   */
  console.log('[price]',
    booking.pickup, '->', booking.dropoff,
    '| km:', distanceKm,
    '| km do cliente:', booking.distance_km,
    '| pax:', passengers,
    '| pt:', isPortugalRoute,
    '| classe:', booking.vehicle_class || 'auto',
    '| hora:', booking.booking_time || booking.time,
    '=> EUR', priceEUR.toFixed(2));

  /**
   * E se divergir do que o cliente viu, avisa.
   *
   * O site envia o preço que mostrou. Se o servidor chegar a
   * outro, um dos dois está errado — e é melhor saber agora do
   * que pelo cliente.
   */
  /**
   * Comparar o público com o público.
   *
   * O checkout envia o preço que mostrou, e para uma agência esse
   * é o PÚBLICO — a página não sabe da comissão, que é decidida
   * aqui.
   *
   * O alarme comparava-o com o priceEUR, que já leva a comissão
   * descontada. Uma agência com 15% dava sempre 15% de divergência
   * e um alarme falso a cada reserva.
   *
   * O que interessa saber é se os dois lados calcularam a mesma
   * TARIFA. A comissão é uma decisão nossa, não uma divergência.
   */
  const vistoPeloCliente = Number(booking.price_eur) || 0;

  if (vistoPeloCliente > 0) {
    const desvioPreco = Math.abs(vistoPeloCliente - priceEUR) / priceEUR;
    const desvioEuros = Math.abs(vistoPeloCliente - priceEUR);

    /**
     * Cinco por cento OU dez euros.
     *
     * Só a percentagem deixava passar o que mais importa: 23 euros
     * de diferenca numa viagem de 500 sao 4,6% e nao avisavam,
     * enquanto um euro numa de 24 sao 4% e tambem nao.
     *
     * A percentagem apanha os erros de formula; o valor absoluto
     * apanha os que doem. Um deles chega.
     *
     * E os dois euros de piso tiram o ruido do arredondamento:
     * a pagina arredonda e o servidor nao, e isso da sempre
     * cinquenta centimos de diferenca.
     */
    const vale = (desvioPreco > 0.05 || desvioEuros >= 10)
                 && desvioEuros >= 2;

    if (vale) {
      /**
       * Sem mencionar a agencia aqui.
       *
       * O agent so e procurado mais abaixo, depois de o preco
       * estar calculado — e usa-lo aqui dava "Cannot access
       * 'agent' before initialization", que rebenta o checkout
       * inteiro.
       *
       * Uma linha de log a mais nao vale uma reserva perdida.
       */
      console.error('[price] MISMATCH: cliente viu', vistoPeloCliente,
        'servidor calculou', priceEUR.toFixed(2));

      telegramPrecoDivergente({
        visto: vistoPeloCliente,
        calculado: priceEUR,
        km: distanceKm,
        de: booking.pickup,
        para: booking.dropoff
      }).catch(() => {});
    }
  }

  /**
   * E um preço que não faz sentido nenhum.
   *
   * Não há regra que diga qual é o preço certo, mas há limites que
   * dizem que algo está errado.
   *
   * A 10 de setembro, uma viagem de 87 euros foi cobrada a 26
   * porque a distância chegou a zero. O número saiu bonito e
   * ninguém reparou — até um cliente perguntar.
   *
   * Estes três testes apanham os erros que dão números plausíveis:
   * o preço mínimo numa viagem longa, um valor por quilómetro
   * absurdo, e um total que não paga a gasolina.
   */
  const porKm = priceEUR / Math.max(distanceKm, 1);

  let precoEstranho = null;

  /**
   * Abaixo de 3 km nao se avalia o preco por km.
   *
   * O minimo de 24 euros existe precisamente para as viagens
   * curtas: um transfer de 1 km da 24 EUR/km, e isso nao e um
   * erro — e o minimo a fazer o seu trabalho.
   *
   * Avisar sobre isso e avisar sobre uma regra que nos escrevemos.
   */
  if (distanceKm > 20 && priceEUR <= 30) {
    precoEstranho = 'Minimum fare on a long trip — distance may have been lost';
  } else if (porKm < 0.8 && distanceKm > 10) {
    precoEstranho = `Only ${porKm.toFixed(2)} EUR per km — too cheap to be right`;
  } else if (porKm > 12 && distanceKm >= 3) {
    precoEstranho = `${porKm.toFixed(2)} EUR per km — too expensive to be right`;
  }

  if (precoEstranho) {
    console.error('[price] ESTRANHO:', precoEstranho,
      '| km:', distanceKm, '| EUR:', priceEUR.toFixed(2));

    telegramPrecoEstranho({
      km: Math.round(distanceKm * 10) / 10,
      preco: priceEUR,
      de: booking.pickup,
      para: booking.dropoff,
      motivo: precoEstranho
    }).catch(() => {});
  }

  /**
   * Se foi de noite.
   *
   * Guardado na reserva para os emails, o calendário, o painel e o
   * Telegram não terem de repetir a regra. Uma regra em cinco
   * sítios é uma regra que vai divergir.
   */
  const temNoite = isNightPickup(booking.booking_time || booking.time);

  // Se quem pede for um agente aprovado, aplica-se a margem dele.
  // O browser não tem palavra nenhuma nisto.
  const requester = await getUserFromRequest(req);
  const agent = await getApprovedAgent(requester);
  const commission = agent ? agent.commission : 0;
  const netPriceEUR = priceEUR * (1 - commission / 100);

  const grossInCurrency = convertFromEUR(priceEUR, currency, rates);
  const priceInCurrency = convertFromEUR(netPriceEUR, currency, rates);

  // A volta é a mesma rota ao contrário, noutra data. Vem como um
  // objeto à parte porque cada perna é uma reserva independente.
  /**
   * A volta e a mesma rota ao contrario. Sempre.
   *
   * O browser podia mandar moradas diferentes na volta — e o
   * preco era o da ida:
   *
   *   ida:    Faro -> Albufeira      38 km,  47 EUR
   *   volta:  Albufeira -> Lisboa   280 km, 370 EUR
   *   cobrado: 94 EUR
   *
   * Uma volta para outro sitio e outra viagem, e paga-se como
   * outra viagem. Quem precisa disso faz duas reservas.
   *
   * O que o browser escolhe e a DATA e a HORA. As moradas vem da
   * ida, invertidas.
   */
  const ret = booking.return_leg && booking.return_leg.date
    ? {
        date: booking.return_leg.date,
        time: booking.return_leg.time,
        pickup: booking.dropoff,
        dropoff: booking.pickup
      }
    : null;

  // A volta percorre a mesma distância, por isso custa o mesmo antes
  // de descontos. O desconto de ida e volta vem da configuração e é
  // zero por omissão: um desconto é decisão comercial, não um valor
  // a inventar no código.
  const rules = await getPaymentRules();
  const returnDiscount = ret ? Number(rules.return_discount_pct || 0) : 0;

  const returnPriceEUR = ret
    ? priceEUR * (1 - returnDiscount / 100)
    : 0;
  const returnNetEUR = returnPriceEUR * (1 - commission / 100);

  const totalNetEUR = netPriceEUR + returnNetEUR;
  const totalInCurrency = convertFromEUR(totalNetEUR, currency, rates);

  const amount = toStripeAmount(totalInCurrency, currency);

  // A folga é verificada aqui também. O limite no browser é uma
  // cortesia; esta é a regra.
  const BOOKING_BUFFER_MINUTES = 30;
  const pickupDate = booking.booking_date || booking.date;
  const pickupTime = booking.booking_time || booking.time || '00:00';
  const pickupAt = new Date(`${pickupDate}T${pickupTime}`);

  /**
   * Uma data invalida NAO passa.
   *
   * A verificacao era "se a data e valida E esta demasiado perto,
   * recusa". Uma data que nao existe — "abc", um campo vazio, um
   * mes 13 — tornava a primeira metade falsa e o if nao entrava.
   *
   * Passava para o Stripe, e a reserva ficava com uma data que
   * ninguem consegue ler. Nenhuma tarefa a encontra: nem a
   * cobranca, nem os lembretes, nem a distribuicao.
   */
  if (!Number.isFinite(pickupAt.getTime())) {
    return res.status(400).json({
      error: 'That date does not look right. Pick a date and time.',
      field_error: true
    });
  }

  /**
   * E nao daqui a dez anos.
   *
   * Uma reserva para 2099 fica no sistema para sempre: o cartao
   * guardado expira muito antes, e a tarefa de cobranca corre
   * todos os dias sem nunca a apanhar.
   *
   * Dois anos cobre qualquer reserva a serio.
   */
  const DOIS_ANOS = 2 * 365 * 24 * 3600 * 1000;

  if (pickupAt.getTime() > Date.now() + DOIS_ANOS) {
    return res.status(400).json({
      error: 'We only take bookings up to two years ahead.',
      field_error: true
    });
  }

  if (pickupAt.getTime() < Date.now() + BOOKING_BUFFER_MINUTES * 60000) {
    return res.status(400).json({
      error: `We need at least ${BOOKING_BUFFER_MINUTES} minutes to arrange a driver. ` +
             'Please choose a later pick-up time.'
    });
  }

  const pickupAirport = await findPickupAirport(booking.pickup);

  // A taxa fica registada na reserva. Converter mais tarde com a taxa
  // do dia em que se lê o relatório dava números diferentes a cada
  // consulta, e nenhum deles seria o que realmente aconteceu.
  /**
   * O país, dito pelo Google quando o temos.
   *
   * O browser guarda o country do address_components — ES, PT, IT
   * — no momento em que a pessoa escolhe a morada.
   *
   * O guessCountry adivinha pelo texto, e fica como rede: as
   * reservas do call centre e as antigas não trazem o campo.
   */
  const countryFrom = booking.pickup_country || guessCountry(booking.pickup);
  const countryTo = booking.dropoff_country || guessCountry(booking.dropoff);

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
    // O idioma preferido, se o disseram. Vai na metadata do Stripe
    // porque é de lá que a reserva é montada no webhook.
    preferred_language: booking.preferred_language || '',
    // O que o Google disse que é o local de recolha. Decide o tempo
    // de espera grátis, e é um facto em vez de uma adivinhação.
    pickup_type: booking.pickup_type || '',
    flight_number: booking.flight_number || booking.flightNumber || '',
    pickup: booking.pickup || '',
    dropoff: booking.dropoff || '',
    booking_date: booking.booking_date || booking.date || '',
    booking_time: booking.booking_time || booking.time || '',
    passengers: String(passengers),
    price: String(priceInCurrency.toFixed(2)),
    distance_km: String(distanceKm.toFixed(1)),
    duration_minutes: String(durationMinutes),

    // Corrigido mais abaixo, depois de se saber se o pagar
    // depois foi mesmo autorizado.
    status: 'paid',
    booked_by: agent ? agent.id : '',
    agent_commission_pct: agent ? String(commission) : '',
    agent_gross_price: agent ? String(grossInCurrency.toFixed(2)) : '',
    price_eur: String(priceEUR.toFixed(2)),
    fx_rate: String(fxRate),
    // O grupo é gerado aqui e viaja nos metadados. Gerá-lo no
    // webhook daria grupos diferentes se ele chegasse duas vezes.
    trip_group_id: ret ? crypto.randomUUID() : '',
    return_date: ret ? ret.date : '',
    return_time: ret ? ret.time || '' : '',
    return_pickup: ret ? ret.pickup : '',
    return_dropoff: ret ? ret.dropoff : '',
    return_price: ret ? String(convertFromEUR(returnNetEUR, currency, rates).toFixed(2)) : '',
    return_price_eur: ret ? String(returnNetEUR.toFixed(2)) : '',
    country_from: countryFrom || '',
    country_to: countryTo || '',

    /**
     * A cidade da morada, dita pelo Google.
     *
     * Diferente do pickup_city, que é a cidade do AEROPORTO. Esta
     * é a da morada que a pessoa escreveu — e é a que decide a
     * zona de preço.
     */
    pickup_locality: booking.pickup_city || '',
    dropoff_locality: booking.dropoff_city || '',
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

/**
 * Os metadados, dentro dos limites do Stripe.
 *
 * O Stripe recusa a sessão INTEIRA se um valor passar dos 500
 * caracteres — e não diz qual. Uma nota longa de um cliente, uma
 * morada com muitos detalhes, e ninguém consegue pagar.
 *
 * Cortar aqui é uma linha; descobrir a causa em produção é uma
 * tarde.
 */
for (const chave of Object.keys(metadata)) {
  const v = metadata[chave];

  if (v === null || v === undefined) {
    delete metadata[chave];
    continue;
  }

  metadata[chave] = String(v).slice(0, 490);
}

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

  /**
   * O estado nos metadados, agora que se sabe.
   *
   * Ia para o Stripe a dizer "paid" mesmo numa reserva de pagar
   * depois, em que nao saiu dinheiro nenhum.
   *
   * A base ficava certa — o webhook escreve 'confirmed' — mas
   * quem fosse ao painel do Stripe investigar um problema lia
   * "paid" e concluia o contrario do que aconteceu.
   */
  metadata.status = payLater ? 'confirmed' : 'paid';

  if (wantsLater && !eligibility.allowed) {
    return res.status(400).json({
      error: eligibility.reason || 'This booking has to be paid at checkout.'
    });
  }

  metadata.payment_mode = payLater ? 'later' : 'now';

  // Viaja nos metadados: o webhook não recalcula a regra.
  metadata.night_surcharge = temNoite ? 'true' : 'false';

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
      /**
       * Um Customer a serio, criado por nos.
       *
       * Com customer_email o Stripe guarda o cartao e NAO cria
       * cliente nenhum — e o customer_creation nao existe no modo
       * setup, so no payment.
       *
       * Sem cliente, o stripe_customer_id fica null e a cobranca
       * de 48 horas antes nunca acontece: ela precisa de um
       * cliente E de um metodo de pagamento.
       *
       * Viagem feita, cartao guardado, e zero cobrado.
       *
       * Criar o cliente aqui resolve, e ele passa a aparecer em
       * Customers no painel do Stripe — que e onde se vai
       * procurar quando algo corre mal.
       */
      const cliente = await stripe.customers.create({
        email: booking.email,
        name: booking.full_name || booking.passenger_name || undefined,
        phone: fullPhone || undefined,
        metadata: {
          booking_id: metadata.booking_id || '',
          created_via: 'pay_later_checkout'
        }
      });

      session = await stripe.checkout.sessions.create({
        mode: 'setup',
        payment_method_types: ['card'],
        customer: cliente.id,

        /**
         * O valor, escrito no topo do formulário.
         *
         * No modo setup o Stripe não mostra preço nenhum — só pede
         * o cartão. Do lado do cliente, isso é dar os dados do
         * cartão sem ver quanto vai ser cobrado, o que é o momento
         * em que mais gente desiste.
         *
         * O custom_text põe uma linha por cima do formulário. Não
         * é o mesmo que o total grande do modo payment, mas diz o
         * essencial: quanto, e quando.
         */
        custom_text: {
          submit: {
            /**
             * As moradas cortadas a 60.
             *
             * O Stripe recusa a sessão inteira acima de 1200
             * caracteres. Duas moradas completas com código postal
             * e país chegam perto disso, e a recusa não diz porquê.
             */
            /**
             * O total que o Stripe vai cobrar, não uma perna.
             *
             * O totalInCurrency é o mesmo número que o modo
             * "pagar agora" usa: já leva a volta, o desconto de
             * ida e volta e a comissão da agência.
             *
             * Calculá-lo aqui outra vez seria uma sexta cópia de
             * uma regra que hoje já divergiu quatro vezes.
             */
            message:
              `${currency} ${totalInCurrency.toFixed(2)}` +
              `${ret ? ' (return included)' : ''} · ` +
              `${String(booking.pickup).slice(0, 60)} → ` +
              `${String(booking.dropoff).slice(0, 60)}. ` +
              `Nothing is charged today. We take it 48 hours before ` +
              `pick-up, and you can cancel free up to 24 hours before.`
          }
        },

        success_url: `${SITE_ORIGIN}/success?session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${SITE_ORIGIN}/?cancel=true`,
        metadata,
        setup_intent_data: { metadata }
      });
    } else {
      session = await stripe.checkout.sessions.create({
        payment_method_types: ['card'],
        mode: 'payment',
        // Uma linha por perna. O cliente vê as duas na página do
        // Stripe em vez de um total que não sabe de onde vem.
        line_items: ret
          ? [
              {
                price_data: {
                  currency: currency.toLowerCase(),
                  product_data: {
                    name: `Outbound: ${booking.pickup} to ${booking.dropoff}`,
                    description: `${metadata.booking_date} · ${parts.join(', ')}`
                  },
                  unit_amount: toStripeAmount(priceInCurrency, currency)
                },
                quantity: 1
              },
              {
                price_data: {
                  currency: currency.toLowerCase(),
                  product_data: {
                    name: `Return: ${ret.pickup} to ${ret.dropoff}`,
                    description: `${ret.date} · ${passengers} passengers` +
                      (returnDiscount ? ` · ${returnDiscount}% return discount` : '')
                  },
                  unit_amount: toStripeAmount(
                    convertFromEUR(returnNetEUR, currency, rates), currency)
                },
                quantity: 1
              }
            ]
          : [{
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

        /**
         * Guardar o cartão, mesmo quem paga à cabeça.
         *
         * Sem isto, o Stripe descarta o método de pagamento assim
         * que a cobrança passa — e a espera no aeroporto ficava sem
         * como ser cobrada à maioria dos clientes.
         *
         * O checkout diz o que isto significa, ao pé do botão de
         * pagar. É o que a Uber, os hotéis e as rent-a-car fazem, e
         * o cliente já espera.
         */
        customer_creation: 'always',
        payment_intent_data: {
          metadata,
          setup_future_usage: 'off_session'
        }
      });
    }

    return res.json({
      url: session.url,
      sessionId: session.id,
      payment_mode: payLater ? 'later' : 'now',
      charge_at: metadata.charge_at || null,

      // Para o site poder dizer porquê, se quiser.
      night_surcharge: temNoite,

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
}

/**
 * Completa uma reserva a partir da sessão do Stripe.
 *
 * Não substitui o webhook: é o que garante que um webhook falhado
 * não deixa um cliente pago e sem confirmação. Só toca no que
 * estiver em falta.
 */
async function repairBookingFromSession(session) {
  /**
   * Paga OU com cartao guardado.
   *
   * Exigia payment_status === 'paid'. No "pagar depois" o Stripe
   * corre em modo setup: guarda o cartao e nao cobra nada, e o
   * payment_status fica 'no_payment_required' para sempre.
   *
   * A reparacao desistia em silencio em todas as reservas de pay
   * later — que sao a maioria — e o cliente ficava com uma pagina
   * de sucesso e nenhuma reserva.
   */
  if (!session) return;

  /**
   * A sessao tem de estar COMPLETA.
   *
   * Uma sessao de checkout nasce quando a pessoa carrega em
   * "continuar" — antes de ver o formulario do cartao. Se ela
   * fechar a janela nessa altura, a sessao fica no Stripe como
   * "open" ou "expired" e nunca chega a haver cliente.
   *
   * O rebuild criava reservas a partir dessas: tres reservas de
   * clientes que nunca reservaram nada. Foi preciso apaga-las a
   * mao.
   *
   * O status da sessao e o unico campo que distingue "reservou"
   * de "pensou em reservar".
   */
  if (session.status !== 'complete') {
    console.log('[repair] sessao nao completada:', session.id,
      '| status:', session.status);
    return;
  }

  /**
   * E depois: pagou, ou guardou o cartao.
   *
   * No "pagar depois" o Stripe corre em modo setup e o
   * payment_status fica 'no_payment_required' para sempre.
   */
  const pago = session.payment_status === 'paid';
  const guardou = session.mode === 'setup'
    || session.payment_status === 'no_payment_required'
    || Boolean(session.setup_intent);

  if (!pago && !guardou) {
    console.log('[repair] sessao sem pagamento nem cartao:', session.id);
    return;
  }

  const metadata = session.metadata || {};

  if (!metadata.email && !metadata.passenger_email) {
    console.log('[repair] sessao sem email nos metadados:', session.id);
    return;
  }

  const { data: existing } = await supabase
    .from('bookings')
    .select('*')
    .eq('stripe_checkout_session_id', session.id)
    .maybeSingle();

  /**
   * Já está completa: nada a fazer.
   *
   * A condição pedia também um booking_reference — um campo que o
   * webhook NUNCA grava. A reparação disparava em todas as
   * reservas, e o log enchia-se de "incomplete booking, repairing"
   * em reservas que estavam perfeitas.
   *
   * O que marca uma reserva completa é o price_eur, que só o
   * webhook novo escreve, e o booking_id — a referência que o
   * cliente vê no email: AL7289539.
   */
  if (existing && existing.price_eur !== null && existing.booking_id) {
    return;
  }

  console.warn('[confirm] incomplete booking, repairing:', session.id);

  const patch = {
    booking_reference: existing?.booking_reference || metadata.booking_reference || null,
    price_eur: metadata.price_eur ? Number(metadata.price_eur) : null,
    fx_rate: metadata.fx_rate ? Number(metadata.fx_rate) : null,
    fx_rate_at: new Date().toISOString(),
    pickup_airport: metadata.pickup_airport || null,
    pickup_city: metadata.pickup_city || null,

    // A cidade da morada, que decide a zona de preço. Diferente
    // do pickup_city, que é a do aeroporto.
    pickup_locality: metadata.pickup_locality || null,
    dropoff_locality: metadata.dropoff_locality || null,

    country_from: metadata.country_from || null,
    country_to: metadata.country_to || null,
    cross_border: metadata.country_from && metadata.country_to
      ? metadata.country_from !== metadata.country_to
      : null,
    flight_number: metadata.flight_number || null,
    passenger_name: metadata.passenger_name || null,
    passenger_email: metadata.passenger_email || null,
    passenger_phone: metadata.passenger_phone || null,
    agent_reference: metadata.agent_reference || null,
    payment_mode: metadata.payment_mode || 'now',
    updated_at: new Date().toISOString()
  };

  let booking = existing;

  if (existing) {
    const { data } = await supabase
      .from('bookings')
      .update(patch)
      .eq('id', existing.id)
      .select()
      .single();

    booking = data || existing;
  } else {
    // Nem sequer existe: o webhook não correu de todo.
    const { data, error } = await supabase
      .from('bookings')
      .upsert({
        ...patch,
        stripe_checkout_session_id: session.id,
        full_name: metadata.full_name || null,
        email: metadata.email || null,
        phone: metadata.phone || null,
        pickup: metadata.pickup || null,
        dropoff: metadata.dropoff || null,
        booking_date: metadata.booking_date || null,
        booking_time: metadata.booking_time || null,
        passengers: Number(metadata.passengers || 1),
        price: metadata.price ? Number(metadata.price) : null,
        currency: metadata.currency || 'EUR',
        distance_km: metadata.distance_km ? Number(metadata.distance_km) : null,
        duration_minutes: metadata.duration_minutes ? Number(metadata.duration_minutes) : null,
        notes: metadata.notes || null,

        /**
         * O estado real, nao 'paid' sempre.
         *
         * Marcava tudo como pago, incluindo as reservas de pagar
         * depois — em que o Stripe so guardou o cartao. Essas
         * ficavam com paid sem nunca ter havido cobranca, e o
         * charge-due nunca as ia buscar.
         *
         * Resultado: viagem feita e nunca cobrada.
         */
        status: pago ? 'paid' : 'confirmed',
        payment_status: pago ? 'paid' : 'pending',

        /**
         * E o modo, que e o que o charge-due procura.
         *
         * Sem payment_mode: 'later', a tarefa que cobra 48 horas
         * antes nunca encontra estas reservas — e a viagem
         * acontece sem nunca ter sido cobrada.
         */
        payment_mode: pago ? 'now' : 'later',

        stripe_setup_intent_id: session.setup_intent || null,
        stripe_customer_id: session.customer || null
      }, { onConflict: 'stripe_checkout_session_id' })
      .select()
      .single();

    if (error) {
      console.error('[confirm] could not create booking:', error.message);
      return;
    }

    booking = data;

    await notifyOps('A booking was saved by the fallback, not the webhook', [
      `Session: ${session.id}`,
      `Customer: ${metadata.full_name} (${metadata.email})`,
      '',
      'The Stripe webhook did not create this booking. Check that the endpoint in',
      'Stripe points at https://airportlink.onrender.com/api/stripe-webhook',
      'and that it is returning 200.'
    ]);
  }

  if (!booking) return;

  // A email_log trata dos duplicados: se o webhook chegar depois e
  // tentar enviar, é descartado.
  const result = await sendBookingConfirmation(booking, null, null);

  console.log('[confirm] confirmation email:', {
    booking: booking.booking_id || booking.id,
    sent: result.sent,
    reason: result.reason || null
  });
}

app.post('/api/confirm-payment', async (req, res) => {
  /**
   * Vinte por minuto.
   *
   * A página de sucesso chama-a uma vez. Vinte dá margem para
   * recarregamentos sem abrir a porta a quem queira adivinhar
   * identificadores de sessão.
   */
  if (limitar('confirm', req, res, { max: 20, segundos: 60 })) return;

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

    // ---------- rede de segurança ----------
    //
    // Esta rota corre quando o cliente volta do Stripe. Se o webhook
    // não tiver corrido — endereço errado, serviço em baixo, evento
    // perdido — a reserva ou não existe ou está incompleta, e o
    // cliente nunca receberia confirmação.
    //
    // Aqui completamos o que faltar e enviamos o email. A email_log
    // impede que saia duas vezes se o webhook aparecer depois.
    try {
      await repairBookingFromSession(session);
    } catch (error) {
      console.error('[confirm] repair failed:', error.message);
    }

    /**
     * O que a página de sucesso precisa para a conversão.
     *
     * O valor em euros e a referência da reserva. Sem eles, o
     * Analytics recebia uma venda sem valor — e uma venda sem
     * valor não distingue um transfer de 25 euros de um de 300.
     */
    const { data: reserva } = await supabase
      .from('bookings')
      .select('booking_id, price_eur, price, payment_mode, trip_group_id')
      .eq('stripe_checkout_session_id', session.id)
      .maybeSingle();

    return res.json({
      id: session.id,
      status: session.status,
      payment_status: session.payment_status,

      booking_id: reserva?.booking_id || null,
      price_eur: reserva?.price_eur || reserva?.price || null,
      payment_mode: reserva?.payment_mode || null,
      trip_group_id: reserva?.trip_group_id || null,

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

    // E na agenda passa a cinzento. Apagar o evento faria a
    // reserva desaparecer sem rasto — e saber que houve um
    // cancelamento naquele dia é informação.
    calendarCancel(booking).catch(() => {});

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

    // O pagamento pode estar na outra perna: uma ida e volta é um
    // pagamento só, guardado na ida, e as duas partilham o
    // trip_group_id.
    booking.stripe_payment_intent_id = await intentDe(booking);

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

    /**
     * Reembolsar é decisão de supervisor.
     *
     * É a única ação do painel que tira dinheiro da conta sem
     * possibilidade de a desfazer. Esconder o botão não protegia
     * nada: esta rota chama-se da consola do browser.
     */
    const { data: quem } = await supabase
      .from('contacts')
      .select('role')
      .eq('id', admin.id)
      .maybeSingle();

    if (!quem || quem.role !== 'supervisor') {
      return res.status(403).json({
        error: 'Refunds are for supervisors. Ask one to do it, or escalate the ' +
          'conversation so it stays on record.'
      });
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

    /**
     * O pagamento pode estar na outra perna.
     *
     * Uma ida e volta é um pagamento só, guardado na ida. Sem
     * isto, reembolsar a volta a partir do painel dizia "sem
     * pagamento" a uma reserva que foi paga.
     *
     * As duas encontram-se pelo trip_group_id.
     */
    booking.stripe_payment_intent_id = await intentDe(booking);

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

    /**
     * O agente continua a ser uma pessoa.
     *
     * A linha em contacts tem de existir porque bookings.email
     * aponta para la. Sem ela, a primeira reserva da agencia
     * rebenta com um "violates foreign key constraint".
     */
    const contactoId = await garantirContacto({
      id: user.id,
      email: user.email,
      nome: representative_name || full_name || user.user_metadata?.full_name
    });

    const contactError = contactoId ? null : new Error('contact row missing');

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

    /**
     * O canal de vendas, com apito.
     *
     * Uma agência aprovada traz dezenas de reservas por mês. É o
     * único registo que justifica interromper alguém — e a
     * candidatura chegava em silêncio, para uma tabela que só se
     * vê no painel.
     */
    telegramNewAgency({
      agency_name: agency_name || legal_name,
      email: user.email,
      country: agency_country,
      phone: agency_phone,
      website: agency_website
    }).catch(() => {});

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

/**
 * O webhook está bem configurado?
 *
 * Uma pergunta que hoje só se responde fazendo um pagamento a
 * sério e vendo o que acontece. Isto responde-a em dois segundos.
 *
 * Protegida pelo x-cron-secret: o prefixo de uma chave é pouco,
 * mas não é nada, e não há razão para o deixar aberto.
 */
app.get('/api/stripe-webhook/health', (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const segredos = String(process.env.STRIPE_WEBHOOK_SECRET || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  return res.json({
    secrets_configured: segredos.length,
    // Chega para comparar com o que o Stripe mostra, sem revelar
    // a chave.
    prefixes: segredos.map((x) => x.slice(0, 12) + '...'),
    looks_valid: segredos.every((x) => x.startsWith('whsec_')),
    stripe_key_mode: String(process.env.STRIPE_SECRET_KEY || '').startsWith('sk_live')
      ? 'live'
      : 'test'
  });
});

/**
 * A atribuição automática de uma reserva.
 *
 * Três passos: repartir em carros, oferecer ao primeiro da lista,
 * e avisá-lo por email.
 *
 * O terceiro é o que faz os outros dois servirem para alguma
 * coisa: sem email, o parceiro não sabe que tem uma oferta e ela
 * expira sempre.
 */
async function atribuir(booking) {
  /**
   * A agenda primeiro, e sempre.
   *
   * Estava no fim, depois de a cascata encontrar um parceiro. Uma
   * reserva sem parceiro na zona não chegava lá — e é justamente
   * essa que tem de estar na agenda, a turquesa, para alguém
   * reparar nela.
   *
   * Também não chegava lá quando a cascata falhava a meio, o que
   * torna o problema invisível: o Telegram avisa, o calendário
   * fica vazio, e ninguém liga as duas coisas.
   *
   * Sem esperar: a agenda não deve atrasar a oferta ao parceiro.
   * Mas o erro é registado — o catch vazio que estava aqui
   * escondia qualquer falha de configuração do Google.
   */
  calendarUpsert(booking).catch((e) =>
    console.error('[calendar] upsert failed for',
      refDe(booking), '—', e.message));

  /**
   * Repartir primeiro.
   *
   * Uma reserva de onze pessoas são dois carros, e podem ser de
   * parceiros diferentes. Sem isto, procurava-se um parceiro que
   * cobrisse os onze sozinho — e na maioria das zonas não há
   * nenhum.
   */
  try {
    const { data: split } = await supabase.rpc('split_booking', {
      p_booking_id: booking.id
    });

    if (split?.segments?.length > 1) {
      console.log('[assign]', refDe(booking),
        'split into', split.segments.length, 'vehicles');
    }
  } catch (e) {
    console.error('[assign] split failed:', e.message);
  }

  // Oferecer ao primeiro da cascata.
  const { data: offer, error } = await supabase.rpc('offer_next_partner', {
    p_booking_id: booking.id,
    p_class: null
  });

  if (error) throw error;

  if (!offer?.partner_id) {
    /**
     * Ninguém na zona. A viagem fica no quadro aberto e as
     * operações têm de saber — é uma venda numa zona que não
     * cobrimos, e isso não se resolve sozinho.
     */
    if (offer?.stage === 'open') {
      // Este vai com som: é uma venda numa zona que não cobrimos, e
      // não se resolve sozinha.
      telegramNewBooking(booking, offer).catch(() => {});

      await notifyOps('Booking with no partner in the zone', [
        `Booking: ${refDe(booking)}`,
        `Trip: ${booking.pickup} to ${booking.dropoff}`,
        `Date: ${booking.booking_date}`,
        `Passengers: ${booking.passengers}`,
        '',
        'Nobody covers this zone with the right vehicle. It is on the ' +
        'open board, but somebody should look at recruiting there.'
      ]);
    }
    return;
  }

  console.log('[assign]', refDe(booking),
    '->', offer.partner, '(' + offer.reason + ')');

  // A venda no telemóvel, silenciosa. Ver as vendas a entrar diz
  // mais sobre o negócio do que qualquer relatório.
  telegramNewBooking(booking, offer).catch(() => {});

  // E avisá-lo.
  const { data: partner } = await supabase
    .from('driver_partners')
    .select('id, email, trading_name, legal_name')
    .eq('id', offer.partner_id)
    .maybeSingle();

  if (partner?.email) {
    await sendRideOffer(partner, booking, offer);
  }

  /**
   * E a agenda outra vez, agora que há oferta.
   *
   * O evento já existe — foi criado no início desta função. Este
   * upsert atualiza o título, que passa a dizer que há uma oferta
   * a decorrer.
   */
  calendarUpsert(booking).catch((e) =>
    console.error('[calendar] update failed:', e.message));
}

app.post('/api/stripe-webhook', async (req, res) => {
  const signature = req.headers['stripe-signature'];

  if (!signature) {
    return res.status(400).send('Missing Stripe signature');
  }

  let event;

  /**
   * Um segredo por endpoint, e pode haver mais do que um.
   *
   * O Stripe assina cada evento com o segredo DO ENDPOINT que o
   * recebe. Se houver dois — o de teste e o de produção, ou um
   * criado por engano — cada um tem o seu, e o que está no Render
   * só valida os eventos de um deles.
   *
   * A mensagem "No signatures found matching" diz exatamente isso:
   * o corpo chegou bem, a assinatura é válida, mas foi feita com
   * outra chave.
   *
   * STRIPE_WEBHOOK_SECRET aceita agora vários separados por
   * vírgula. Tenta-se cada um até algum bater.
   */
  const segredos = String(process.env.STRIPE_WEBHOOK_SECRET || '')
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

  if (!segredos.length) {
    console.error('Webhook: STRIPE_WEBHOOK_SECRET is not set.');
    return res.status(500).send('Webhook secret not configured');
  }

  let ultimoErro = null;

  for (const segredo of segredos) {
    try {
      event = await stripe.webhooks.constructEventAsync(req.body, signature, segredo);
      break;
    } catch (error) {
      ultimoErro = error;
    }
  }

  if (!event) {
    /**
     * Diagnóstico no registo, não na resposta.
     *
     * O Stripe mostra o que respondermos, e uma resposta com
     * detalhes da chave seria visível a quem tiver acesso ao painel
     * dele. Nos registos do Render fica só para quem gere o
     * serviço.
     */
    /**
     * Uma assinatura recusada é grave.
     *
     * Ou o segredo está errado — e nesse caso NENHUMA reserva está
     * a ser gravada — ou alguém está a tentar forjar pagamentos.
     *
     * Foi o que aconteceu semanas atrás: o segredo errado, o
     * webhook a devolver 400 a tudo, e a descoberta só quando um
     * cliente perguntou pela reserva.
     */
    telegramTaskFailed('stripe webhook',
      `Signature rejected: ${ultimoErro?.message || 'unknown'}`,
      'Either the webhook secret is wrong — in which case no booking ' +
      'is being saved — or somebody is forging requests.'
    ).catch(() => {});

    console.error('Webhook signature failed.', {
      secrets_configured: segredos.length,
      // Só os primeiros caracteres: chega para confirmar QUAL é
      // sem o revelar.
      secret_prefix: segredos.map((x) => x.slice(0, 12)),
      body_is_buffer: Buffer.isBuffer(req.body),
      body_length: req.body && req.body.length,
      error: ultimoErro && ultimoErro.message
    });

    return res.status(400).send(`Webhook Error: ${ultimoErro && ultimoErro.message}`);
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

    /**
     * E nos pagamentos à cabeça.
     *
     * O setup_future_usage no checkout diz ao Stripe para guardar o
     * cartão, mas o id do método só se sabe indo buscá-lo ao
     * payment_intent depois de a cobrança passar.
     *
     * Sem isto, a espera no aeroporto ficava sem como ser cobrada à
     * maioria dos clientes — e a maioria paga à cabeça.
     */
    if (!payLater && typeof session.payment_intent === 'string') {
      try {
        const pi = await stripe.paymentIntents.retrieve(session.payment_intent);

        savedPaymentMethod = typeof pi.payment_method === 'string'
          ? pi.payment_method
          : pi.payment_method?.id || null;
      } catch (e) {
        console.error('[webhook] could not read payment method:', e.message);
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
    let passwordLink = null;

    if (!userId && metadata.email) {
      // Isolado num try próprio: se falhar, a reserva continua a ser
      // criada e a confirmação continua a sair. Antes, um erro aqui
      // abortava o processador e o cliente ficava com a reserva paga
      // e sem email nenhum.
      try {
        const guest = await ensureGuestAccount(
          metadata.email,
          metadata.full_name,
          [metadata.phone_code, metadata.phone_number].filter(Boolean).join(' ')
        );

        if (guest) {
          userId = guest.userId;
          passwordLink = guest.link;
        }
      } catch (error) {
        console.error('[webhook] guest account step failed, carrying on:', error.message);
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
      trip_group_id: metadata.trip_group_id || null,
      leg: metadata.trip_group_id ? 1 : null,
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
      /**
       * O suplemento noturno fica na reserva.
       *
       * Recalculá-lo depois obrigava a repetir a regra em cada
       * sítio que a quisesse mostrar — nos emails, no calendário,
       * no painel, no Telegram. Uma regra em cinco sítios é uma
       * regra que vai divergir.
       */
      night_surcharge: metadata.night_surcharge === 'true',

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
      // Vazio conta como sem preferência: um campo opcional que
      // ninguém preencheu não deve ficar como string vazia.
      preferred_language: metadata.preferred_language || null,
      pickup_type: metadata.pickup_type || null,
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

    /**
     * A reserva tem tudo o que precisa para acontecer?
     *
     * Uma reserva sem telefone é uma pessoa que não se consegue
     * contactar no dia. Sem preço é uma que não se cobra. Sem
     * distância é uma que foi cobrada pelo mínimo.
     *
     * Nada disto dá erro: a linha grava-se na mesma. E só se
     * descobre na véspera da viagem, quando já é tarde.
     */
    if (savedBooking) {
      const faltam = [];

      if (!savedBooking.phone_number) faltam.push('phone');
      if (!savedBooking.email) faltam.push('email');
      if (!savedBooking.pickup || !savedBooking.dropoff) faltam.push('address');
      if (!savedBooking.booking_date) faltam.push('date');
      if (!savedBooking.booking_time) faltam.push('time');

      const preco = Number(savedBooking.price_eur || savedBooking.price || 0);
      if (!preco || preco <= 0) faltam.push('price');

      const km = Number(savedBooking.distance_km || 0);
      if (!km || km <= 0) faltam.push('distance');

      if (faltam.length) {
        console.error('[booking] incompleta:', savedBooking.id, faltam.join(', '));

        telegramReservaIncompleta(savedBooking, faltam).catch(() => {});
      }
    }

    /**
     * A cascata arranca aqui.
     *
     * A viagem é oferecida a UM parceiro de cada vez, começando
     * pelo que tem mais em comum com o cliente — o idioma primeiro,
     * depois a taxa de conclusão.
     *
     * Se ninguém aceitar, vai ao quadro aberto, que é o que existia
     * antes disto.
     *
     * Sem esperar pela resposta: uma falha aqui não deve impedir a
     * confirmação de chegar ao cliente. O cron apanha as reservas
     * que ficaram sem oferta.
     */
    if (savedBooking && !upsertError) {
      atribuir(savedBooking).catch((e) =>
        console.error('[assign] failed:', e.message));
    }

    if (upsertError) {
      console.error('Supabase upsert error:', upsertError);

      return res.status(500).send(
        `Supabase error: ${upsertError.message}`
      );
    }

    // ---------- a perna de regresso ----------
    //
    // Uma reserva completa e independente: pode ir para outro
    // parceiro, ter outro motorista e ser cancelada sozinha. O que
    // as liga é o trip_group_id.
    let returnBooking = null;

    // Também isolado: a ida está paga, e um erro aqui não pode
    // impedir a confirmação de sair.
    try {
    if (metadata.trip_group_id && metadata.return_date) {
      const returnAirport = await findPickupAirport(metadata.return_pickup);

      const returnRow = {
        ...bookingRow,
        booking_id: `${bookingRow.booking_id}-R`,
        booking_reference: bookingRow.booking_reference
          ? `${bookingRow.booking_reference}-R`
          : null,
        leg: 2,

        pickup: metadata.return_pickup,
        dropoff: metadata.return_dropoff,
        booking_date: metadata.return_date,
        booking_time: metadata.return_time || null,
        pickup_airport: returnAirport.iata || null,
        pickup_city: returnAirport.city || null,
        price: metadata.return_price ? Number(metadata.return_price) : bookingRow.price,
        price_eur: metadata.return_price_eur
          ? Number(metadata.return_price_eur)
          : bookingRow.price_eur,
        // O voo é o da chegada. Na volta o cliente está a partir, e
        // um número de voo errado faria o motorista esperar por um
        // avião que não vem.
        flight_number: null,
        // Uma cobrança só, registada na ida. Duplicar aqui daria dois
        // débitos para uma compra.
        stripe_checkout_session_id: `${session.id}-R`,

        /**
         * O payment_intent fica só na ida.
         *
         * A coluna é única — e é bem que seja: dois registos com o
         * mesmo intent seriam dois reembolsos possíveis do mesmo
         * dinheiro.
         *
         * As duas pernas foram pagas num só pagamento. A ida
         * guarda-o; a volta encontra-o pelo trip_group_id, que
         * ambas partilham.
         *
         * Sem isto, a volta nunca era criada: "duplicate key value
         * violates unique constraint".
         */
        stripe_payment_intent_id: null,

        settled_eur: null,
        stripe_fee_eur: null,
        balance_transaction_id: null,
        // A volta é mais tarde: tem a sua própria janela de cobrança.
        charge_at: payLater
          ? new Date(
              new Date(`${metadata.return_date}T${metadata.return_time || '00:00'}`).getTime()
              - 48 * 36e5
            ).toISOString()
          : null
      };

      const { data: savedReturn, error: returnError } = await supabase
        .from('bookings')
        .upsert(returnRow, { onConflict: 'stripe_checkout_session_id' })
        .select()
        .single();

      if (returnError) {
        // A ida está paga e gravada. Falhar aqui não pode desfazer
        // isso — mas alguém tem de saber que falta uma perna.
        console.error('Return leg failed:', returnError);

        await notifyOps('Return leg was not created', [
          `Outbound: ${refDe(bookingRow)}`,
          `Customer: ${bookingRow.full_name} (${bookingRow.email})`,
          `Return: ${metadata.return_pickup} to ${metadata.return_dropoff}`,
          `On ${metadata.return_date} at ${metadata.return_time || '(no time)'}`,
          `Error: ${returnError.message}`,
          '',
          'The customer paid for both legs. Create the return by hand.'
        ]);
      } else {
        returnBooking = savedReturn;

        await Promise.all([
          supabase.from('bookings')
            .update({ paired_booking_id: savedReturn.id })
            .eq('id', savedBooking.id),
          supabase.from('bookings')
            .update({ paired_booking_id: savedBooking.id })
            .eq('id', savedReturn.id)
        ]);

        console.log('Return leg created:', savedReturn.booking_id);

        /**
         * E a volta segue o mesmo caminho da ida.
         *
         * Era criada, entrava no email de confirmação, e mais nada:
         * sem evento na agenda e sem oferta a nenhum parceiro.
         *
         * O cliente pagou duas viagens e só uma estava a ser
         * organizada. A outra só aparecia no dia, quando ele
         * ligasse a perguntar pelo carro.
         *
         * Sem esperar: a confirmação ao cliente não deve ficar à
         * espera da cascata.
         */
        atribuir(savedReturn).catch((e) =>
          console.error('[assign] return leg failed:', e.message));
      }
    }
    } catch (error) {
      console.error('[webhook] return leg step failed, carrying on:', error.message);
    }

    // Dois emails diferentes: quem pagou já recebe a confirmação,
    // quem só guardou o cartão recebe a data em que será cobrado.
    // Mandar a mesma coisa aos dois faria alguém pensar que já pagou.
    // Um email para a viagem toda, não um por perna. Dois emails
    // para uma compra fariam o cliente pensar que reservou duas vezes.
    //
    // O resultado fica no log, para se perceber sem adivinhar se o
    // email saiu, foi descartado por duplicado, ou falhou.
    try {
      const emailResult = payLater
        ? await sendCardSaved(savedBooking, bookingRow.charge_at, returnBooking)
        : await sendBookingConfirmation(savedBooking, passwordLink, returnBooking);

      console.log('[webhook] confirmation email:', {
        booking: savedBooking.booking_id || savedBooking.id,
        to: savedBooking.passenger_email || savedBooking.email,
        mode: payLater ? 'card_saved' : 'booking_confirmed',
        sent: emailResult.sent,
        reason: emailResult.reason || null
      });

      // Um cliente que pagou e não recebeu confirmação é um
      // telefonema garantido. Melhor saberes tu primeiro.
      if (!emailResult.sent && emailResult.reason !== 'duplicate') {
        await notifyOps('A customer did not get their confirmation', [
          `Booking: ${savedBooking.booking_reference || savedBooking.booking_id}`,
          `Customer: ${savedBooking.full_name} (${savedBooking.email})`,
          `Reason: ${emailResult.reason || 'unknown'}`,
          '',
          'They have paid and the booking exists. Send it by hand.'
        ]);
      }
    } catch (error) {
      console.error('[webhook] confirmation email threw:', error);
    }
  }

  // ============================================================
  // OS OUTROS EVENTOS
  //
  // O webhook só tratava o checkout.session.completed. Faltavam os
  // três que custam dinheiro: um pagamento que falha depois de
  // aprovado, um reembolso feito no painel do Stripe, e uma disputa
  // — que é perdida por omissão se ninguém responder em sete dias.
  // ============================================================

  /**
   * Já tratámos este evento?
   *
   * O Stripe reenvia até receber 200. Se a nossa resposta se perder
   * na rede, ele volta — e sem esta verificação um reembolso de 50
   * euros era registado duas vezes.
   */
  const jaTratado = async (extra = {}) => {
    try {
      const { data } = await supabase.rpc('payment_event_seen', {
        p_event_id: event.id,
        p_type: event.type,
        p_booking_id: extra.booking_id || null,
        p_intent: extra.intent || null,
        p_amount: extra.amount != null ? extra.amount / 100 : null,
        p_currency: extra.currency || null,
        p_payload: event.data.object
      });

      return data === true;
    } catch (e) {
      // Falhar aqui não deve travar o tratamento: repetir um
      // reembolso no registo é menos grave do que ignorar uma
      // disputa.
      console.error('[webhook] seen check failed:', e.message);
      return false;
    }
  };

  /**
   * Marcar o evento como tratado.
   *
   * Num try, não num .catch: o construtor do Supabase é um
   * "thenable" — tem .then, e o await funciona, mas nem todas as
   * versões expõem .catch.
   *
   * Aqui isso é pior do que noutro sítio: se esta chamada
   * rebentar, o evento do Stripe fica por tratar e volta a ser
   * entregue. Uma reserva criada duas vezes, ou um reembolso
   * repetido.
   */
  const marcarFeito = async (erro) => {
    try {
      await supabase.rpc('payment_event_done', {
        p_event_id: event.id,
        p_error: erro || null
      });
    } catch (e) {
      console.error('payment_event_done:', e.message);

      telegramTaskFailed('stripe webhook',
        `Could not mark event ${event.id} as done: ${e.message}. ` +
        'Stripe will retry it.'
      ).catch(() => {});
    }
  };

  /** A reserva a que este pagamento pertence. */
  const reservaDoIntent = async (intentId) => {
    if (!intentId) return null;

    const { data } = await supabase
      .from('bookings')
      .select('*')
      .eq('stripe_payment_intent_id', intentId)
      .maybeSingle();

    return data;
  };

  // ---------- pagamento falhado ----------
  if (event.type === 'payment_intent.payment_failed') {
    const intent = event.data.object;
    const booking = await reservaDoIntent(intent.id);

    if (await jaTratado({
      booking_id: booking?.id,
      intent: intent.id,
      amount: intent.amount,
      currency: intent.currency
    })) {
      return res.json({ received: true, duplicate: true });
    }

    try {
      const motivo = intent.last_payment_error?.message || 'The payment was declined.';

      if (booking) {
        await supabase.from('bookings').update({
          payment_status: 'failed',
          last_charge_error: motivo,
          updated_at: new Date().toISOString()
        }).eq('id', booking.id);

        /**
         * O cliente tem de saber, e depressa.
         *
         * Um pagamento que falha silenciosamente é uma viagem que
         * ninguém vai fazer — e o cliente só descobre no aeroporto.
         */
        try {
          /**
           * O sendChargeFailed espera { attempt, willRetry }.
           *
           * Este caminho é diferente do charge-due: aqui o Stripe
           * já recusou, e não há tentativa automática a seguir — o
           * cliente tem de vir mudar o cartão.
           */
          await sendChargeFailed(booking, { attempt: 1, willRetry: false });
        } catch (e) {
          console.error('[webhook] charge-failed email:', e.message);
        }
      }

      await notifyOps('Payment failed', [
        `Intent: ${intent.id}`,
        booking
          ? `Booking: ${refDe(booking)}`
          : 'No booking found for this intent.',
        `Amount: ${(intent.amount / 100).toFixed(2)} ${String(intent.currency).toUpperCase()}`,
        `Reason: ${motivo}`
      ]);

      await marcarFeito();
    } catch (e) {
      await marcarFeito(e.message);
      console.error('[webhook] payment_failed:', e.message);
    }

    return res.json({ received: true });
  }

  // ---------- reembolso ----------
  if (event.type === 'charge.refunded') {
    const charge = event.data.object;
    const booking = await reservaDoIntent(charge.payment_intent);

    if (await jaTratado({
      booking_id: booking?.id,
      intent: charge.payment_intent,
      amount: charge.amount_refunded,
      currency: charge.currency
    })) {
      return res.json({ received: true, duplicate: true });
    }

    try {
      const devolvido = charge.amount_refunded / 100;
      const total = charge.amount / 100;
      const parcial = charge.amount_refunded < charge.amount;

      if (booking) {
        /**
         * Um reembolso pode vir do painel do Stripe, sem passar por
         * aqui. Sem este evento, a reserva ficava "paga" na nossa
         * base e reembolsada no Stripe — e os números deixavam de
         * bater sem ninguém perceber porquê.
         */
        await supabase.from('bookings').update({
          refunded_amount: devolvido,
          refunded_at: new Date().toISOString(),
          payment_status: parcial ? 'partially_refunded' : 'refunded',
          // Um reembolso total cancela a viagem. Um parcial não:
          // pode ser um desconto acordado depois da reserva.
          status: parcial ? booking.status : 'cancelled',
          updated_at: new Date().toISOString()
        }).eq('id', booking.id);
      }

      await notifyOps(parcial ? 'Partial refund' : 'Refund', [
        booking
          ? `Booking: ${refDe(booking)}`
          : 'No booking found.',
        `Refunded: ${devolvido.toFixed(2)} of ${total.toFixed(2)} ` +
          String(charge.currency).toUpperCase(),
        booking && parcial ? 'The booking is still active.' : '',
        'Made in the Stripe dashboard or by our own refund route.'
      ].filter(Boolean));

      await marcarFeito();
    } catch (e) {
      await marcarFeito(e.message);
      console.error('[webhook] charge.refunded:', e.message);
    }

    return res.json({ received: true });
  }

  // ---------- disputa ----------
  if (event.type === 'charge.dispute.created' ||
      event.type === 'charge.dispute.updated' ||
      event.type === 'charge.dispute.closed') {
    const dispute = event.data.object;
    const booking = await reservaDoIntent(dispute.payment_intent);

    if (await jaTratado({
      booking_id: booking?.id,
      intent: dispute.payment_intent,
      amount: dispute.amount,
      currency: dispute.currency
    })) {
      return res.json({ received: true, duplicate: true });
    }

    try {
      // O prazo vem em segundos desde 1970.
      const prazo = dispute.evidence_details?.due_by
        ? new Date(dispute.evidence_details.due_by * 1000)
        : null;

      const aberta = event.type === 'charge.dispute.created';
      const fechada = event.type === 'charge.dispute.closed';

      if (booking) {
        await supabase.from('bookings').update({
          dispute_status: dispute.status,
          dispute_reason: dispute.reason,
          dispute_amount: dispute.amount / 100,
          dispute_due_by: prazo ? prazo.toISOString() : null,
          dispute_opened_at: aberta
            ? new Date().toISOString()
            : booking.dispute_opened_at,
          updated_at: new Date().toISOString()
        }).eq('id', booking.id);
      }

      /**
       * Uma disputa é o evento mais caro que existe.
       *
       * O Stripe dá um prazo para responder com provas. Passado sem
       * resposta, perde-se por omissão — e além do valor da viagem
       * cobram uma taxa de disputa que ronda os 15 euros.
       *
       * Por isso o email é diferente dos outros: diz o prazo em
       * dias, e diz o que fazer.
       */
      const dias = prazo
        ? Math.max(0, Math.ceil((prazo - Date.now()) / 86400000))
        : null;

      const titulo = fechada
        ? `Dispute ${dispute.status}`
        : aberta
          ? 'DISPUTE OPENED — action needed'
          : `Dispute updated: ${dispute.status}`;

      // No telemóvel também: uma disputa perde-se por omissão, e o
      // prazo é curto.
      telegramDispute(booking, dispute, dias).catch(() => {});

      await notifyOps(titulo, [
        booking
          ? `Booking: ${refDe(booking)}`
          : 'No booking found for this charge.',
        booking ? `Customer: ${booking.full_name} (${booking.email})` : '',
        booking ? `Trip: ${booking.pickup} to ${booking.dropoff} on ${booking.booking_date}` : '',
        `Amount: ${(dispute.amount / 100).toFixed(2)} ${String(dispute.currency).toUpperCase()}`,
        `Reason given: ${dispute.reason}`,
        `Status: ${dispute.status}`,
        '',
        fechada
          ? (dispute.status === 'won'
              ? 'We kept the money.'
              : 'The money is gone, plus the dispute fee.')
          : dias != null
            ? `RESPOND WITHIN ${dias} DAY${dias === 1 ? '' : 'S'}. ` +
              'Without a reply the dispute is lost by default, and the ' +
              'dispute fee is charged on top of the amount.'
            : 'Check the deadline in the Stripe dashboard.',
        '',
        aberta
          ? 'Evidence to send: the booking confirmation email, the driver ' +
            'assignment, and anything showing the trip happened.'
          : '',
        `https://dashboard.stripe.com/disputes/${dispute.id}`
      ].filter(Boolean));

      await marcarFeito();
    } catch (e) {
      await marcarFeito(e.message);
      console.error('[webhook] dispute:', e.message);
    }

    return res.json({ received: true });
  }

  /**
   * Os que não tratamos ficam registados na mesma.
   *
   * Quando um dia alguém perguntar "porque é que este pagamento
   * está assim", o registo responde — mesmo para eventos que nunca
   * chegámos a programar.
   */
  if (event.type !== 'checkout.session.completed') {
    await jaTratado().catch(() => {});
    await marcarFeito();
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
 * Todas as rotas de tarefa, de uma vez.
 *
 * Envolver cada uma à mão seria cinco edições e cinco
 * oportunidades de me enganar. Isto apanha qualquer rota
 * /api/tasks/ — incluindo as que ainda não existem.
 *
 * Lê a resposta que a rota vai enviar: se for um erro, ou trouxer
 * um campo "failures" com conteúdo, avisa. Se for um sucesso
 * depois de uma falha, avisa também.
 */
async function tarefa(nome, fn) {
  try {
    const r = await fn();

    /**
     * Uma tarefa pode devolver falhas sem lançar exceção.
     *
     * O support_tick corre sete rotinas em blocos separados, para
     * que uma falha não trave as outras — e devolve o que correu
     * mal num campo "failures". Ninguém o lia.
     */
    const falhas = r?.failures;

    if (Array.isArray(falhas) && falhas.length) {
      await telegramTaskFailed(nome,
        falhas.map((f) => `${f.part}: ${f.error}`).join('\n')).catch(() => {});

      return r;
    }

    await telegramTaskRecovered(nome).catch(() => {});
    return r;
  } catch (error) {
    console.error(`[task] ${nome}:`, error.message);

    await telegramTaskFailed(nome, error.message,
      error.stack?.slice(0, 200)).catch(() => {});

    throw error;
  }
}


/**
 * A referência que se diz ao telefone.
 *
 * A coluna booking_reference está vazia em todas as reservas — 32
 * de 32. O que se vê no painel vem do booking_id, que tem o
 * "AL2633934" e o "-R" nas voltas.
 *
 * Esta função escolhe a que existir. Enquanto a coluna morta não
 * for removida, comparar por ela falha em silêncio.
 */
function refDe(b) {
  if (!b) return '';
  return b.booking_id || b.booking_reference || String(b.id || '').slice(0, 8);
}


/**
 * O pagamento de uma reserva, venha de onde vier.
 *
 * Uma ida e volta é um pagamento só, guardado na ida — a coluna do
 * payment_intent é única e não aceita dois registos com o mesmo
 * valor. E é bem que não aceite: dois registos seriam dois
 * reembolsos possíveis do mesmo dinheiro.
 *
 * As duas pernas partilham o trip_group_id. Isto vai lá buscar.
 */
async function intentDe(booking) {
  if (booking.stripe_payment_intent_id) {
    return booking.stripe_payment_intent_id;
  }

  /**
   * O trip_group_id liga as duas pernas.
   *
   * Já existia — é gerado no checkout e viaja nos metadados, para
   * que o webhook a chegar duas vezes não crie dois grupos.
   *
   * Inventei um "return_of" antes de reparar nele. Este é melhor:
   * uma ida e volta é um grupo, não uma perna que aponta para
   * outra.
   */
  if (!booking.trip_group_id) return null;

  const { data: ida } = await supabase
    .from('bookings')
    .select('stripe_payment_intent_id')
    .eq('trip_group_id', booking.trip_group_id)
    .eq('leg', 1)
    .maybeSingle();

  return ida?.stripe_payment_intent_id || null;
}


/**
 * Cobrar a espera, no cartão que já está guardado./**
 * Cobrar a espera, no cartão que já está guardado./**
 * Cobrar a espera, no cartão que já está guardado.
 *
 * Chamada quando o cliente aceita, no momento do código. Ele está
 * ali, viu o valor, e concordou — não é uma surpresa no extrato.
 *
 * Se falhar, a viagem começa na mesma. Um cliente deixado no
 * aeroporto por causa de quinze euros é uma disputa e uma avaliação
 * de uma estrela; a dívida resolve-se depois, com calma.
 */
app.post('/api/internal/charge-extra', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { booking_id } = req.body || {};
  if (!booking_id) return res.status(400).json({ error: 'Send booking_id.' });

  try {
    const { data: booking } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', booking_id)
      .maybeSingle();

    if (!booking) return res.status(404).json({ error: 'Booking not found.' });

    if (!booking.extra_amount || booking.extra_charged_at) {
      return res.json({ ok: true, skipped: true });
    }

    /**
     * Sem cartão guardado não há como cobrar.
     *
     * Acontece nos que pagaram à cabeça: o Stripe não guarda o
     * método a menos que se peça. Fica registado como dívida e o
     * apoio resolve — não vale a pena pedir o cartão ao cliente no
     * passeio.
     */
    if (!booking.stripe_payment_method_id || !booking.stripe_customer_id) {
      await supabase.from('bookings').update({
        extra_charge_failed: 'no_saved_card',
        updated_at: new Date().toISOString()
      }).eq('id', booking_id);

      await notifyOps('Waiting charge could not be taken', [
        `Booking: ${refDe(booking)}`,
        `Customer: ${booking.full_name} (${booking.email})`,
        `Amount: ${Number(booking.extra_amount).toFixed(2)} ${booking.currency || 'EUR'}`,
        `Waiting: ${booking.extra_minutes} minutes past the free time`,
        '',
        'No saved card. The passenger accepted the charge — somebody ' +
        'should follow up.'
      ]);

      return res.json({ ok: false, reason: 'no_saved_card' });
    }

    const currency = booking.currency || 'EUR';
    const amount = toStripeAmount(Number(booking.extra_amount), currency);

    const intent = await stripe.paymentIntents.create({
      amount,
      currency: currency.toLowerCase(),
      customer: booking.stripe_customer_id,
      payment_method: booking.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      description: `Waiting time — ${refDe(booking)}`,
      metadata: {
        booking_id: String(booking.id),
        kind: 'waiting_time',
        minutes: String(booking.extra_minutes || 0)
      }
    });

    await supabase.from('bookings').update({
      extra_charged_at: new Date().toISOString(),
      extra_charge_failed: null,
      updated_at: new Date().toISOString()
    }).eq('id', booking_id);

    console.log('[extra] charged', refDe(booking),
      Number(booking.extra_amount).toFixed(2), currency);

    return res.json({ ok: true, intent: intent.id });
  } catch (error) {
    /**
     * O cartão recusou.
     *
     * Sem saldo, banco a bloquear por ser estrangeiro, cartão
     * expirado entre a reserva e a viagem. Fica registado e as
     * operações são avisadas.
     */
    console.error('[extra] charge failed:', error.message);

    await supabase.from('bookings').update({
      extra_charge_failed: error.message,
      updated_at: new Date().toISOString()
    }).eq('id', booking_id).catch(() => {});

    await notifyOps('Waiting charge declined', [
      `Booking: ${booking_id}`,
      `Reason: ${error.message}`,
      '',
      'The passenger accepted the charge and the trip went ahead. ' +
      'Somebody should follow up.'
    ]).catch(() => {});

    return res.json({ ok: false, reason: error.message });
  }
});


/**
 * Alterar uma reserva.
 *
 * Até 24 horas antes, altera-se tudo. Depois disso, fala-se com o
 * apoio.
 *
 * O preço é recalculado AQUI, com a rota medida de novo. Aceitar
 * um preço vindo do browser seria aceitar um preço que qualquer
 * pessoa pode editar.
 */
app.post('/api/booking/change', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Not signed in' });

  const { booking_id, changes } = req.body || {};

  if (!booking_id || !changes || !Object.keys(changes).length) {
    return res.status(400).json({ error: 'Send booking_id and what to change.' });
  }

  /**
   * As mesmas regras da criação.
   *
   * Uma reserva criada com data válida podia ser alterada para
   * ontem — a validação estava só na criação, e o browser é que
   * verificava aqui.
   *
   * Só se verifica o que vem: uma alteração que mude só a morada
   * não tem de trazer a data.
   */
  const SO_ESTES = ['booking_date', 'booking_time', 'passengers',
                    'pickup', 'dropoff', 'flight_number', 'notes'];

  /**
   * E os dados do passageiro, só para agências.
   *
   * Quem reserva para si próprio tem o telefone no perfil — é lá
   * que se muda, e serve para todas as reservas.
   *
   * Uma agência é diferente: o passageiro não é ela. Mudar de
   * passageiro numa reserva é uma coisa que acontece — o cliente
   * dela cancela e outro vai no lugar — e o motorista precisa de
   * saber quem espera.
   */
  const agente = await getApprovedAgent(user).catch(() => null);

  if (agente) {
    SO_ESTES.push('passenger_name', 'passenger_phone');
  }

  for (const k of Object.keys(changes)) {
    if (!SO_ESTES.includes(k)) {
      /**
       * O que não está na lista sai.
       *
       * Sem isto, uma alteração podia trazer "price" ou "status" e
       * o apply_booking_change escrevia-os. Uma reserva de 300
       * euros passava a 5 com um pedido bem feito.
       */
      delete changes[k];
    }
  }

  if (!Object.keys(changes).length) {
    return res.status(400).json({ error: 'Nothing that can be changed.', field_error: true });
  }

  if (changes.booking_date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(changes.booking_date))) {
      return res.status(400).json({ error: 'That date is not valid.', field_error: true });
    }
  }

  if (changes.booking_time !== undefined) {
    if (!/^\d{2}:\d{2}$/.test(String(changes.booking_time))) {
      return res.status(400).json({ error: 'That time is not valid.', field_error: true });
    }
  }

  /**
   * E a data nova não pode ser no passado.
   *
   * A verificação usa a data nova quando ela vem, e a antiga
   * quando só muda a hora — senão, mudar a hora de uma reserva de
   * amanhã seria recusado por causa da data de hoje.
   */
  if (changes.booking_date !== undefined || changes.booking_time !== undefined) {
    const { data: atual } = await supabase
      .from('bookings')
      .select('booking_date, booking_time')
      .eq('id', booking_id)
      .maybeSingle();

    const d = changes.booking_date ?? atual?.booking_date;
    const h = changes.booking_time ?? atual?.booking_time ?? '00:00';

    const quando = new Date(`${d}T${h}:00`);

    if (Number.isNaN(quando.getTime())) {
      return res.status(400).json({ error: 'That date and time are not valid.' });
    }

    if (quando.getTime() < Date.now() + 2 * 3600000) {
      return res.status(400).json({
        error: 'We need at least two hours to arrange a driver.'
      });
    }
  }

  if (changes.passengers !== undefined) {
    const pax = Number(changes.passengers);

    if (!Number.isInteger(pax) || pax < 1 || pax > 16) {
      return res.status(400).json({ error: 'Passengers must be between 1 and 16.' });
    }
  }

  for (const campo of ['pickup', 'dropoff']) {
    if (changes[campo] !== undefined &&
        String(changes[campo]).trim().length < 4) {
      return res.status(400).json({ error: 'That address is too short.', field_error: true });
    }
  }

  /**
   * O telefone do passageiro, com a mesma regra da criação.
   *
   * Seis dígitos. É o número que o motorista marca no dia — um
   * campo com três dígitos é pior do que um vazio, porque parece
   * preenchido.
   */
  if (changes.passenger_phone !== undefined) {
    const digitos = String(changes.passenger_phone).replace(/\D/g, '');

    if (digitos.length < 6) {
      return res.status(400).json({
        error: 'That phone number is too short. The driver calls it on the day.'
      });
    }
  }

  if (changes.passenger_name !== undefined &&
      String(changes.passenger_name).trim().length < 2) {
    return res.status(400).json({
      error: 'The passenger name is too short — the driver holds a sign with it.',
      field_error: true
    });
  }

  if (changes.flight_number) {
    const voo = String(changes.flight_number).trim().toUpperCase();

    if (!/^[A-Z0-9]{2,3}\s?\d{1,4}[A-Z]?$/.test(voo)) {
      return res.status(400).json({ error: 'That flight number does not look right.' });
    }

    changes.flight_number = voo;
  }

  // E o tamanho, como na criação.
  for (const [campo, max] of [['pickup', 300], ['dropoff', 300], ['notes', 500]]) {
    if (changes[campo]) {
      changes[campo] = String(changes[campo]).slice(0, max);
    }
  }

  try {
    const { data: booking } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', booking_id)
      .maybeSingle();

    if (!booking) return res.status(404).json({ error: 'Booking not found.' });

    // A reserva é dele, ou é um agente.
    const { user: admin } = await requireAdmin(req).catch(() => ({ user: null }));

    if (booking.user_id !== user.id && !admin) {
      return res.status(403).json({ error: 'That booking is not yours.' });
    }

    // A janela, antes de fazer trabalho nenhum.
    const { data: pode } = await supabase.rpc('can_change_booking', {
      p_booking_id: booking_id
    });

    if (!pode?.ok) {
      return res.status(400).json({
        error: pode?.message || 'This booking can no longer be changed.',
        reason: pode?.reason,
        hours_left: pode?.hours_left
      });
    }

    /**
     * O preço, se a rota ou os passageiros mudaram.
     *
     * Medir a rota custa uma chamada ao Google. Só se faz quando a
     * morada mudou — mudar a hora não muda a distância.
     */
    let novoPreco = null;
    let novoKm = null;

    const mudouRota = changes.pickup || changes.dropoff;
    const mudouPax = changes.passengers != null;

    if (mudouRota || mudouPax) {
      const de = changes.pickup || booking.pickup;
      const para = changes.dropoff || booking.dropoff;
      const pax = Number(changes.passengers) || booking.passengers || 1;

      const rota = mudouRota
        ? await getDistanceAndDuration(de, para)
        : { distanceKm: booking.distance_km, isPortugalRoute: null };

      novoKm = rota.distanceKm;

      /**
       * A assinatura certa.
       *
       * Estava a passar um objeto único, e a função espera quatro
       * argumentos. O distanceKm chegava como objeto e o preço
       * saía sempre o mínimo — 24 euros para qualquer alteração.
       */
      novoPreco = computePriceEUR(
        rota.distanceKm,
        pax,
        rota.isPortugalRoute,
        {
          vehicleClass: booking.vehicle_class,
          pickupText: de,
          dropoffText: para,
          pickupTime: changes.booking_time || booking.booking_time
        }
      );
    }

    const { data: result, error } = await supabase.rpc('apply_booking_change', {
      p_booking_id: booking_id,
      p_changes: changes,
      p_new_price: novoPreco,
      p_new_km: novoKm
    });

    if (error) throw error;

    if (result?.ok === false) {
      return res.status(400).json({ error: result.message || 'Could not change it.' });
    }

    const diferenca = Number(result?.price_difference || 0);

    /**
     * O dinheiro.
     *
     * Sobe: cobra-se no cartão guardado. Desce: reembolsa-se. As
     * duas sem esperar — a alteração já foi feita, e o cliente não
     * deve ficar à espera do Stripe para ver a reserva atualizada.
     */
    if (diferenca > 0.5) {
      acertarDiferenca(booking, diferenca, 'charge').catch((e) =>
        console.error('[change] charge failed:', e.message));
    } else if (diferenca < -0.5) {
      acertarDiferenca(booking, Math.abs(diferenca), 'refund').catch((e) =>
        console.error('[change] refund failed:', e.message));
    }

    /**
     * O motorista, quando a data ou a rota mudam.
     *
     * Ele aceitou uma viagem num dia e num percurso. Se qualquer
     * dos dois mudar, recebe outra coisa — e deve poder devolvê-la
     * sem penalização.
     */
    if (result?.notify_partner) {
      avisarParceiroDaMudanca(booking, result).catch((e) =>
        console.error('[change] partner notice failed:', e.message));
    }

    // E a agenda acompanha.
    const { data: atualizada } = await supabase
      .from('bookings').select('*').eq('id', booking_id).maybeSingle();

    if (atualizada) calendarUpsert(atualizada).catch(() => {});

    return res.json({
      success: true,
      price_difference: diferenca,
      new_price: novoPreco ?? booking.price,
      partner_notified: Boolean(result?.notify_partner)
    });
  } catch (error) {
    console.error('booking/change:', error);
    return res.status(500).json({ error: 'Could not change the booking.' });
  }
});


/** Cobrar ou devolver a diferença de uma alteração. */
async function acertarDiferenca(booking, valor, tipo) {
  const currency = booking.currency || 'EUR';
  const amount = toStripeAmount(valor, currency);

  if (tipo === 'charge') {
    if (!booking.stripe_payment_method_id || !booking.stripe_customer_id) {
      await notifyOps('Booking change needs a payment', [
        `Booking: ${refDe(booking)}`,
        `Customer: ${booking.full_name} (${booking.email})`,
        `Owed: ${valor.toFixed(2)} ${currency}`,
        '',
        'No saved card. Somebody should follow up.'
      ]);
      return;
    }

    await stripe.paymentIntents.create({
      amount,
      currency: currency.toLowerCase(),
      customer: booking.stripe_customer_id,
      payment_method: booking.stripe_payment_method_id,
      off_session: true,
      confirm: true,
      description: `Booking change — ${refDe(booking)}`,
      metadata: { booking_id: String(booking.id), kind: 'change_difference' }
    });

    console.log('[change] charged', valor.toFixed(2), currency);
    return;
  }

  /**
   * O reembolso.
   *
   * Só se houver pagamento para reembolsar. Num pay-later ainda não
   * cobrado, a diferença sai da cobrança futura sozinha — o preço
   * já foi atualizado.
   */
  const intent = await intentDe(booking);

  // Sem pagamento não há o que devolver. Num pay later ainda não
  // cobrado, a diferença sai da cobrança futura sozinha.
  if (!intent) return;

  await stripe.refunds.create({
    payment_intent: intent,
    amount,
    metadata: { booking_id: String(booking.id), kind: 'change_difference' }
  });

  console.log('[change] refunded', valor.toFixed(2), currency);
}


/**
 * O motorista soube que a viagem mudou.
 *
 * Com um botão para a devolver. Devolver não penaliza: ele aceitou
 * uma coisa e recebeu outra, e contar isso contra ele ensinaria os
 * parceiros a não aceitar nada que pudesse mudar.
 */
async function avisarParceiroDaMudanca(booking, result) {
  const { data: partner } = await supabase
    .from('driver_partners')
    .select('id, email, trading_name, legal_name')
    .eq('id', result.partner_id)
    .maybeSingle();

  if (!partner?.email) return;

  const { data: nova } = await supabase
    .from('bookings').select('*').eq('id', booking.id).maybeSingle();

  await sendRideChanged(partner, nova || booking, {
    date_changed: result.date_changed,
    route_changed: result.route_changed,
    old_date: booking.booking_date,
    old_pickup: booking.pickup,
    old_dropoff: booking.dropoff
  });
}


/**
 * O motorista chegou: avisar o cliente.
 *
 * Chamada pelo portal de motoristas. O email vive aqui porque é
 * aqui que estão as credenciais do Resend.
 */
app.post('/api/internal/driver-arrived', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { booking_id } = req.body || {};
  if (!booking_id) return res.status(400).json({ error: 'Send booking_id.' });

  try {
    const { data: booking } = await supabase
      .from('bookings')
      .select('*')
      .eq('id', booking_id)
      .maybeSingle();

    if (!booking) return res.status(404).json({ error: 'Booking not found.' });

    /**
     * Os dados do motorista, se estiverem atribuídos.
     *
     * Muitos parceiros pequenos não registam motoristas — são eles
     * próprios que conduzem. Nesse caso o email diz só que o carro
     * chegou, e isso chega.
     */
    let driver = null;

    if (booking.assigned_driver_id) {
      const [{ data: d }, { data: v }] = await Promise.all([
        supabase.from('drivers')
          .select('full_name, phone')
          .eq('id', booking.assigned_driver_id)
          .maybeSingle(),

        booking.assigned_vehicle_id
          ? supabase.from('partner_vehicles')
              .select('make, model, plate')
              .eq('id', booking.assigned_vehicle_id)
              .maybeSingle()
          : Promise.resolve({ data: null })
      ]);

      if (d) {
        driver = {
          name: d.full_name,
          phone: d.phone,
          vehicle: v ? `${v.make} ${v.model}` : null,
          plate: v?.plate
        };
      }
    }

    if (!driver && booking.manual_driver_name) {
      driver = {
        name: booking.manual_driver_name,
        phone: booking.manual_driver_phone,
        vehicle: booking.manual_vehicle,
        plate: booking.manual_vehicle_plate
      };
    }

    const result = await sendDriverArrived(booking, driver);

    return res.json({ ok: true, ...result });
  } catch (error) {
    console.error('driver-arrived:', error);
    return res.status(500).json({ error: error.message });
  }
});


/**
 * A hora de aterragem, quando ela faz falta.
 *
 * Chamada pelo portal de motoristas antes de calcular a espera —
 * ao abrir o ecrã e ao dar o código.
 *
 * Estava presa ao botão de "cheguei", e isso era um erro: um
 * motorista que fosse direto ao código nunca a disparava, e o
 * cliente de um voo atrasado pagava espera que não devia.
 *
 * Agora o sistema vai buscar a informação quando precisa dela, não
 * quando alguém lhe diz.
 */
app.post('/api/internal/flight-landing', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { booking_id } = req.body || {};
  if (!booking_id) return res.status(400).json({ error: 'Send booking_id.' });

  try {
    const { data: booking } = await supabase
      .from('bookings')
      .select('id, booking_reference, flight_number, booking_date, flight_landed_at')
      .eq('id', booking_id)
      .maybeSingle();

    if (!booking) return res.status(404).json({ error: 'Booking not found.' });

    // Já sabemos, ou não há voo. Em qualquer dos casos não se
    // gasta uma consulta.
    if (booking.flight_landed_at) {
      return res.json({ ok: true, cached: true, landed_at: booking.flight_landed_at });
    }

    if (!booking.flight_number) {
      return res.json({ ok: true, no_flight: true });
    }

    const voo = await flightLanding(booking.flight_number, booking.booking_date);

    /**
     * Só se grava a hora CONFIRMADA.
     *
     * Uma previsão muda, e cobrar espera com base numa previsão
     * seria injusto — o cliente pagaria por um atraso que afinal
     * não aconteceu.
     */
    if (voo?.landed_at && voo.confirmed) {
      await supabase.from('bookings')
        .update({ flight_landed_at: voo.landed_at })
        .eq('id', booking.id);

      console.log('[flights]', refDe(booking),
        booking.flight_number, 'landed', voo.landed_at);

      return res.json({ ok: true, landed_at: voo.landed_at });
    }

    return res.json({ ok: true, not_landed_yet: true, status: voo?.status });
  } catch (error) {
    console.error('flight-landing:', error);
    return res.json({ ok: false, reason: error.message });
  }
});


/**
 * Reatribuir uma viagem que voltou à fila.
 *
 * Chamada quando um parceiro devolve uma viagem alterada. A
 * cascata recomeça do zero — e ele próprio pode voltar a ser
 * oferecido, porque a razão para recusar pode ter desaparecido.
 */
app.post('/api/internal/reassign', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { booking_id } = req.body || {};
  if (!booking_id) return res.status(400).json({ error: 'Send booking_id.' });

  try {
    const { data: booking } = await supabase
      .from('bookings').select('*').eq('id', booking_id).maybeSingle();

    if (!booking) return res.status(404).json({ error: 'Booking not found.' });

    await atribuir(booking);

    return res.json({ ok: true });
  } catch (error) {
    console.error('reassign:', error);
    return res.status(500).json({ error: error.message });
  }
});


/**
 * As reservas futuras que não estão na agenda.
 *
 * O evento é criado quando a reserva nasce. Se o Google estiver em
 * baixo nesse momento — ou o token expirado, como aconteceu — a
 * reserva fica sem evento e ninguém dá por isso.
 *
 * Isto passa por todas as reservas dos próximos trinta dias e
 * garante o evento. O upsert não duplica: procura pelo booking_id
 * antes de criar.
 *
 * Uma vez por dia chega. O evento certo no dia seguinte é melhor
 * do que nenhum.
 */
app.post('/api/tasks/calendar-sweep', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const hoje = new Date().toISOString().slice(0, 10);

    /**
     * Um ano à frente.
     *
     * Eram trinta dias, e isso deixava de fora as reservas feitas
     * com muita antecedência — que são precisamente as que mais
     * tempo têm para se perder de vista.
     *
     * Uma ida e volta marcada em setembro para outubro caía a 35
     * dias e nunca chegava à agenda.
     */
    const limite = new Date();
    limite.setFullYear(limite.getFullYear() + 1);

    const { data: reservas, error } = await supabase
      .from('bookings')
      .select('*')
      .gte('booking_date', hoje)
      .lte('booking_date', limite.toISOString().slice(0, 10))
      .neq('status', 'cancelled')
      .order('booking_date')
      /**
       * Mais fundo, agora que a janela é um ano.
       *
       * Duzentas reservas eram muitas para trinta dias e são
       * poucas para trezentos e sessenta e cinco. As que ficassem
       * de fora nunca chegariam à agenda, porque o sweep começa
       * sempre pelas mais próximas.
       */
      .limit(1000);

    if (error) throw error;

    let feitas = 0;
    let falhadas = 0;
    const erros = [];

    /**
     * Um limite de tempo.
     *
     * Com um ano de janela são até mil reservas, e mil chamadas ao
     * Google levam três minutos — mais do que o Render espera
     * antes de cortar.
     *
     * Cinquenta segundos e para. O que ficar por fazer fica para a
     * próxima corrida, e a resposta diz quantas foram.
     */
    const pararAs = Date.now() + 50000;
    let porFazer = 0;

    for (const b of reservas || []) {
      if (Date.now() > pararAs) {
        porFazer += 1;
        continue;
      }

      try {
        const r = await calendarUpsert(b);

        if (r?.ok) {
          feitas += 1;
        } else {
          /**
           * Não lançou, mas também não fez.
           *
           * O calendarUpsert nunca lança — devolve { ok: false } com
           * a razão. Contar isso como sucesso silencioso foi o que
           * fez o sweep dizer "synced: 0" sem explicar porquê.
           */
          falhadas += 1;

          if (erros.length < 3) {
            erros.push(`${refDe(b)}: ${r?.reason || 'unknown'}`);
          }
        }
      } catch (e) {
        falhadas += 1;
        if (erros.length < 3) erros.push(`${refDe(b)}: ${e.message}`);
      }
    }

    console.log('[calendar] swept', feitas, 'of', reservas?.length || 0);

    return res.json({
      ok: falhadas === 0,
      checked: reservas?.length || 0,
      synced: feitas,
      failed: falhadas,

      /**
       * As que ficaram para a próxima.
       *
       * Não é erro: é o tempo a acabar. Se este número for sempre
       * maior que zero, vale a pena correr o cron mais vezes por
       * dia em vez de o tornar mais lento.
       */
      remaining: porFazer,
      // As razões, sempre. Um "synced: 0" sem explicação é uma hora
      // a adivinhar.
      reasons: erros,

      // O middleware das tarefas lê isto e avisa no Telegram.
      failures: erros.length
        ? erros.map((e) => ({ part: 'calendar', error: e }))
        : undefined
    });
  } catch (error) {
    console.error('[calendar] sweep failed:', error.message);
    return res.status(500).json({ error: error.message });
  }
});


/**
 * Um alarme vindo do serviço de drivers.
 *
 * Esse serviço não tem Telegram — e não deve ter: duas cópias das
 * credenciais é um sítio a mais onde podem vazar.
 *
 * Manda o alarme para aqui, e daqui vai para o canal. Uma chamada
 * a mais numa coisa que só acontece quando algo corre mal.
 */
app.post('/api/internal/alarm', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { task, error, detail, recovered } = req.body || {};

  if (!task) return res.status(400).json({ error: 'Send task.' });

  if (recovered) {
    await telegramTaskRecovered(task).catch(() => {});
  } else {
    await telegramTaskFailed(task, error || 'unknown', detail).catch(() => {});
  }

  return res.json({ ok: true });
});


/**
 * A configuração do mapa, servida pelo servidor.
 *
 * A chave anónima estava escrita na página. Isso obriga a
 * republicar o site sempre que ela muda — e quando o Supabase
 * mudou o formato das chaves, a página ficou com uma antiga e
 * respondia "Invalid API key" sem dizer porquê.
 *
 * Vindo daqui, muda-se numa variável de ambiente.
 */
app.get('/api/maps/config.js', (req, res) => {
  const cfg = {
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    apiUrl: process.env.RENDER_EXTERNAL_URL || 'https://airportlink.onrender.com'
  };

  res.type('application/javascript');

  // Sem cache: uma chave errada em cache é uma hora a perguntar
  // porque é que não funciona.
  res.set('Cache-Control', 'no-store');

  res.send('window.MAP_CFG = ' + JSON.stringify(cfg) + ';');
});


/**
 * O funil de um aeroporto.
 *
 * Quem já contactámos, o que se disse, e em que ponto está. Sem
 * isto, dois vendedores ligam à mesma empresa na mesma semana — e
 * ela pensa que somos desorganizados.
 */
app.get('/api/maps/pipeline', async (req, res) => {
  try {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) {
      return res.status(403).json({
        error: adminError || 'Administrator access required.'
      });
    }

    if (!req.query.iata) {
      return res.status(400).json({ error: 'Send an airport code.' });
    }

    const { data, error } = await supabase.rpc('airport_pipeline', {
      p_iata: String(req.query.iata).toUpperCase()
    });

    if (error) throw error;

    return res.json(data || {});
  } catch (error) {
    console.error('pipeline:', error.message);
    return res.status(500).json({ error: error.message });
  }
});


/** Uma empresa nova para contactar. */
app.post('/api/maps/lead', async (req, res) => {
  try {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) {
      return res.status(403).json({
        error: adminError || 'Administrator access required.'
      });
    }

    const b = req.body || {};

    if (!b.company_name || !Array.isArray(b.airports) || !b.airports.length) {
      return res.status(400).json({
        error: 'Send a company name and at least one airport.'
      });
    }

    const { data, error } = await supabase.from('leads').insert({
      company_name: String(b.company_name).trim(),
      airports: b.airports.map((a) => String(a).toUpperCase()),
      country: b.country || null,
      contact_name: b.contact_name || null,
      email: b.email || null,
      phone: b.phone || null,
      website: b.website || null,
      fleet_note: b.fleet_note || null,
      sedans: Number(b.sedans) || null,
      vans: Number(b.vans) || null,
      source: b.source || null,

      // Quem a encontrou fica dono, até alguém a passar.
      owner_id: admin.id,
      created_by: admin.id
    }).select().maybeSingle();

    if (error) throw error;

    return res.json({ success: true, lead: data });
  } catch (error) {
    console.error('new lead:', error.message);
    return res.status(500).json({ error: error.message });
  }
});


/**
 * Registar um contacto.
 *
 * Uma chamada, um email, uma reunião. É isto que impede o trabalho
 * de se repetir.
 */
app.post('/api/maps/touch', async (req, res) => {
  try {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) {
      return res.status(403).json({
        error: adminError || 'Administrator access required.'
      });
    }

    const { lead_id, kind, note, stage, next_action } = req.body || {};

    if (!lead_id || !note) {
      return res.status(400).json({ error: 'Send lead_id and a note.' });
    }

    /**
     * Com o service_role, não com a sessão do utilizador.
     *
     * O server.js não tem o asUser do serviço de drivers. E o
     * log_touch usa auth.uid() para saber quem fez o contacto —
     * que com o service_role é nulo.
     *
     * Por isso o id vai explícito, e a função aceita-o.
     */
    const { data, error } = await supabase.rpc('log_touch', {
      p_lead_id: lead_id,
      p_kind: kind || 'call',
      p_note: note,
      p_new_stage: stage || null,
      p_next_action: next_action || null,
      p_agent_id: admin.id
    });

    if (error) throw error;

    if (data && data.ok === false) {
      const msg = {
        note_required: 'Write what was said. A contact without a note ' +
          'is no use to anybody — not even to you, two weeks from now.',
        not_found: 'That company is no longer in the list.',
        not_allowed: 'Administrator access required.'
      };

      return res.status(400).json({ error: msg[data.reason] || 'Could not save.' });
    }

    return res.json({ success: true, ...(data || {}) });
  } catch (error) {
    console.error('touch:', error.message);
    return res.status(500).json({ error: error.message });
  }
});


/** O que tenho para fazer hoje. */
app.get('/api/maps/my-pipeline', async (req, res) => {
  try {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) {
      return res.status(403).json({
        error: adminError || 'Administrator access required.'
      });
    }

    const { data, error } = await supabase.rpc('my_pipeline', {
      p_user_id: admin.id
    });

    if (error) throw error;

    return res.json(data || {});
  } catch (error) {
    console.error('my pipeline:', error.message);
    return res.status(500).json({ error: error.message });
  }
});


/** Quem trata de um aeroporto. */
app.post('/api/maps/owner', async (req, res) => {
  try {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) {
      return res.status(403).json({
        error: adminError || 'Administrator access required.'
      });
    }

    const { iata, owner_id } = req.body || {};
    if (!iata) return res.status(400).json({ error: 'Send an airport code.' });

    if (owner_id === null) {
      await supabase.from('airport_owners').delete()
        .eq('iata', String(iata).toUpperCase());

      return res.json({ success: true, cleared: true });
    }

    const { error } = await supabase.from('airport_owners').upsert({
      iata: String(iata).toUpperCase(),
      owner_id: owner_id || admin.id,
      assigned_at: new Date().toISOString()
    }, { onConflict: 'iata' });

    if (error) throw error;

    return res.json({ success: true });
  } catch (error) {
    console.error('owner:', error.message);
    return res.status(500).json({ error: error.message });
  }
});


/**
 * As três listas do topo.
 *
 * Quem espera aprovação, onde recrutar a seguir, e quem já temos.
 * A árvore serve para procurar; estas servem para decidir — e é
 * isso que se faz ao abrir a página.
 */
app.get('/api/maps/summary', async (req, res) => {
  try {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) {
      return res.status(403).json({
        error: adminError || 'Administrator access required.'
      });
    }

    const { data, error } = await supabase.rpc('coverage_summary');
    if (error) throw error;

    return res.json(data || {});
  } catch (error) {
    console.error('coverage summary:', error.message);
    return res.status(500).json({ error: error.message });
  }
});


/**
 * A árvore de cobertura: continentes e países.
 *
 * Uma lista de 801 aeroportos não se navega. Por continente e
 * país, com os números de cada um, navega-se — e carrega-se só o
 * que se abre.
 */
app.get('/api/maps/tree', async (req, res) => {
  try {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) {
      return res.status(403).json({
        error: adminError || 'Administrator access required.'
      });
    }

    const { data, error } = await supabase.rpc('coverage_tree');
    if (error) throw error;

    return res.json(data || {});
  } catch (error) {
    console.error('coverage tree:', error.message);
    return res.status(500).json({ error: error.message });
  }
});


/**
 * Os aeroportos de um país, com as empresas de cada um.
 *
 * Pedido quando alguém abre um país no menu. Traz tudo o que é
 * preciso para desenhar essa secção — incluindo as empresas em
 * análise, que são o que distingue um aeroporto âmbar de um
 * vermelho.
 */
app.get('/api/maps/country', async (req, res) => {
  try {
    const { user: admin, error: adminError } = await requireAdmin(req);
    if (!admin) {
      return res.status(403).json({
        error: adminError || 'Administrator access required.'
      });
    }

    if (!req.query.name) {
      return res.status(400).json({ error: 'Send a country name.' });
    }

    const { data, error } = await supabase.rpc('airports_in', {
      p_country: req.query.name
    });

    if (error) throw error;

    return res.json({ airports: data || [] });
  } catch (error) {
    console.error('country airports:', error.message);
    return res.status(500).json({ error: error.message });
  }
});


/**
 * Os dados do mapa./**
 * Os dados do mapa./**
 * Os dados do mapa.
 *
 * Três camadas — cobertura, reservas e parceiros — numa chamada.
 * Três chamadas seriam três esperas no plano gratuito do Render.
 *
 * Só para administradores: isto mostra a nossa cobertura inteira,
 * e um concorrente que a visse saberia exatamente onde atacar.
 */
app.get('/api/maps/data', async (req, res) => {
  try {
    const { user: admin, error: adminError } = await requireAdmin(req);

    if (!admin) {
      return res.status(403).json({
        error: adminError || 'Administrator access required.'
      });
    }

    const { data, error } = await supabase.rpc('map_data');

    if (error) throw error;

    return res.json(data || {});
  } catch (error) {
    console.error('maps data:', error.message);
    return res.status(500).json({ error: error.message });
  }
});


/**
 * ---------------------------------------------------------------
 * OS ERROS DO BROWSER
 *
 * Os alarmes cobrem tarefas e rotas — o que corre no servidor. Um
 * erro no JavaScript do cliente não deixa rasto nenhum: a página
 * parte, ele desiste, e nós ficamos a achar que ninguém quis
 * reservar naquele dia.
 *
 * Foi exatamente o que aconteceu hoje com o pintarVistas
 * duplicado: o painel não abria e só soubemos porque alguém
 * reclamou.
 *
 * O QUE ISTO NÃO É
 *
 * Não é o Sentry. Não agrupa, não tem interface, não guarda
 * histórico além da tabela. Manda um alarme quando um erro novo
 * aparece, e cala-se quando é o mesmo repetido.
 * ---------------------------------------------------------------
 */
app.post('/api/client-error', async (req, res) => {
  /**
   * Vinte por hora e por endereço.
   *
   * Um erro dentro de um ciclo dispara centenas de vezes por
   * segundo. Sem limite, o primeiro cliente com um problema
   * enchia a base e o Telegram.
   */
  if (limitar('clienterr', req, res, { max: 20, segundos: 3600 })) {
    return;
  }

  try {
    const { message, source, line, column, stack, url, ua } = req.body || {};

    if (!message) return res.json({ ok: true });

    /**
     * A impressão digital do erro.
     *
     * Mesma mensagem, mesmo ficheiro, mesma linha: é o mesmo erro,
     * mesmo que venha de mil browsers. Sem isto, um bug numa
     * página popular manda mil alarmes iguais.
     */
    const digital = [
      String(message).slice(0, 200),
      String(source || '').split('/').pop().split('?')[0],
      line || 0
    ].join('|');

    const { data } = await supabase.rpc('log_client_error', {
      p_fingerprint: digital,
      p_message: String(message).slice(0, 500),
      p_source: String(source || '').slice(0, 300),
      p_line: Number(line) || null,
      p_stack: String(stack || '').slice(0, 2000),
      p_url: String(url || '').slice(0, 300),
      p_user_agent: String(ua || req.headers['user-agent'] || '').slice(0, 300)
    });

    /**
     * Só o primeiro de cada tipo avisa.
     *
     * A função devolve is_new quando é a estreia. Os seguintes
     * contam-se em silêncio, e o contador diz depois quantos
     * foram.
     */
    if (data?.is_new) {
      telegramTaskFailed('browser error',
        `${String(message).slice(0, 150)}\n` +
        `${String(source || '').split('/').pop()}:${line || '?'}\n` +
        `on ${String(url || '').slice(0, 80)}`
      ).catch(() => {});
    }

    return res.json({ ok: true });
  } catch (error) {
    /**
     * Um erro a registar erros não faz barulho.
     *
     * Se esta rota falhar, o pior que acontece é perdermos um
     * relatório. Fazer barulho aqui podia criar um ciclo.
     */
    console.error('client-error:', error.message);
    return res.json({ ok: true });
  }
});


/**
 * ---------------------------------------------------------------
 * MUDAR A PALAVRA-PASSE
 *
 * A conta existia e não se geria. Quem quisesse mudar tinha de
 * fingir que se tinha esquecido — sair, pedir o email de
 * recuperação, esperar, clicar.
 *
 * Serve os quatro: clientes, agências, parceiros e agentes. É a
 * mesma tabela de utilizadores por trás dos quatro portais.
 * ---------------------------------------------------------------
 */
/**
 * ---------------------------------------------------------------
 * DEFINIR A PALAVRA-PASSE, COM UM CÓDIGO NOSSO
 *
 * O resetPasswordForEmail do Supabase depende do serviço de email
 * deles, que no plano gratuito manda poucos por hora e recusa em
 * silêncio. Foi por isso que o "esqueci-me" não funcionou.
 *
 * Isto gera um código nosso, manda-o pelo Resend — que já leva
 * todos os outros emails — e troca-o por uma sessão.
 * ---------------------------------------------------------------
 */
app.post('/api/account/reset-request', async (req, res) => {
  if (limitar('reset', req, res, { max: 4, segundos: 900 })) return;

  const email = String(req.body?.email || '').trim().toLowerCase();

  if (!email) {
    return res.status(400).json({ error: 'Send an email address.', field_error: true });
  }

  try {
    const { data: lista } = await supabase.auth.admin.listUsers();

    const u = (lista?.users || []).find(
      (x) => x.email?.toLowerCase() === email
    );

    /**
     * A resposta é a mesma exista ou não a conta.
     *
     * Dizer "não há conta com esse email" diz a quem pergunta
     * quais os emails registados — e isso é uma lista que não
     * queremos dar.
     */
    if (!u) {
      console.log('[reset] pedido para email sem conta:', email);
      return res.json({ ok: true });
    }

    /**
     * Um código de seis dígitos, válido por trinta minutos.
     *
     * Seis dígitos são 1 em 900 mil. Com quatro tentativas por
     * quinze minutos, adivinhar leva séculos — e é curto o
     * suficiente para se escrever à mão de um telemóvel para um
     * computador.
     */
    const codigo = String(Math.floor(100000 + Math.random() * 900000));

    const { error: erroGuardar } = await supabase
      .from('password_resets')
      .insert({
        user_id: u.id,
        email,
        code: codigo,
        expires_at: new Date(Date.now() + 30 * 60000).toISOString()
      });

    if (erroGuardar) throw erroGuardar;

    const parceiro = Boolean(
      (await supabase.from('driver_partners').select('id')
        .eq('id', u.id).maybeSingle()).data
    );

    await sendResetCode({
      email,
      name: u.user_metadata?.full_name || null,
      code: codigo,
      partner: parceiro
    });

    console.log('[reset] código enviado para', email);

    return res.json({ ok: true });
  } catch (e) {
    console.error('[reset] falhou para', email, e.message);

    telegramTaskFailed('password reset',
      `${email} pediu um código e falhou: ${e.message}`
    ).catch(() => {});

    return res.status(500).json({
      error: 'We could not send the code. Try again in a moment.'
    });
  }
});


/**
 * O código, trocado por uma palavra-passe nova.
 */
app.post('/api/account/reset-confirm', async (req, res) => {
  if (limitar('resetconfirm', req, res, { max: 8, segundos: 900 })) return;

  const email = String(req.body?.email || '').trim().toLowerCase();
  const codigo = String(req.body?.code || '').trim();
  const nova = String(req.body?.password || '');

  if (!email || !codigo) {
    return res.status(400).json({
      error: 'Send the email and the code.', field_error: true
    });
  }

  if (nova.length < 8) {
    return res.status(400).json({
      error: 'The password needs at least 8 characters.', field_error: true
    });
  }

  try {
    const { data: pedido } = await supabase
      .from('password_resets')
      .select('id, user_id, expires_at, used_at')
      .eq('email', email)
      .eq('code', codigo)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (!pedido) {
      return res.status(400).json({
        error: 'That code is not right. Check it, or ask for a new one.',
        field_error: true
      });
    }

    if (pedido.used_at) {
      return res.status(400).json({
        error: 'That code was already used. Ask for a new one.',
        field_error: true
      });
    }

    if (new Date(pedido.expires_at) < new Date()) {
      return res.status(400).json({
        error: 'That code has expired. Ask for a new one.',
        field_error: true
      });
    }

    const { error } = await supabase.auth.admin.updateUserById(
      pedido.user_id,
      {
        password: nova,

        /**
         * E o email fica confirmado.
         *
         * Quem recebeu o código naquele endereço provou que é dele.
         * Deixá-lo por confirmar era bloquear o login logo a
         * seguir a definir a palavra-passe.
         */
        email_confirm: true
      }
    );

    if (error) throw error;

    // O código não serve mais.
    await supabase
      .from('password_resets')
      .update({ used_at: new Date().toISOString() })
      .eq('id', pedido.id);

    console.log('[reset] palavra-passe definida para', email);

    sendPasswordChanged(email).catch(() => {});

    return res.json({ ok: true });
  } catch (e) {
    console.error('[reset-confirm]', e.message);
    return res.status(500).json({ error: e.message });
  }
});


app.post('/api/account/password', async (req, res) => {
  if (limitar('password', req, res, { max: 5, segundos: 900 })) return;

  try {
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({ error: 'Sign in first.' });
    }

    const { current_password, new_password } = req.body || {};

    if (!new_password || String(new_password).length < 8) {
      return res.status(400).json({
        error: 'The new password needs at least 8 characters.',
        field_error: true
      });
    }

    /**
     * A atual é obrigatória.
     *
     * Sem ela, quem apanhasse um portátil desbloqueado mudava a
     * palavra-passe e ficava com a conta. Com ela, precisa de
     * saber a antiga — que é o ponto.
     */
    if (!current_password) {
      return res.status(400).json({
        error: 'Enter your current password.',
        field_error: true
      });
    }

    /**
     * Confirmar a antiga tentando entrar com ela.
     *
     * O Supabase não tem uma forma de "verificar esta password".
     * Um signIn com as credenciais é o que existe — e falha se
     * estiver errada, que é o que queremos saber.
     */
    const { error: erroLogin } = await supabase.auth.signInWithPassword({
      email: user.email,
      password: String(current_password)
    });

    if (erroLogin) {
      return res.status(400).json({
        error: 'That is not your current password.',
        field_error: true
      });
    }

    if (String(new_password) === String(current_password)) {
      return res.status(400).json({
        error: 'The new password is the same as the current one.',
        field_error: true
      });
    }

    const { error } = await supabase.auth.admin.updateUserById(user.id, {
      password: String(new_password)
    });

    if (error) throw error;

    console.log('[account] password changed:', user.email);

    /**
     * E um email a avisar.
     *
     * Se não foi ele, é assim que fica a saber — e ainda vai a
     * tempo de recuperar a conta. Uma mudança de password em
     * silêncio é a última coisa que um dono de conta quer.
     */
    sendPasswordChanged(user.email).catch((e) =>
      console.error('password email:', e.message));

    return res.json({
      success: true,
      message: 'Password changed. Your other devices stay signed in.'
    });
  } catch (error) {
    console.error('password change:', error.message);
    return res.status(500).json({ error: error.message });
  }
});


/**
 * ---------------------------------------------------------------
 * APAGAR A CONTA
 *
 * Obrigação do RGPD, e prometida na política de privacidade desde
 * o primeiro dia.
 *
 * Duas rotas: pedir e confirmar. Entre elas, um email — porque um
 * botão que apaga tudo a um clique é um botão que se carrega por
 * engano, e isto não tem volta.
 * ---------------------------------------------------------------
 */
app.post('/api/account/delete-request', async (req, res) => {
  if (limitar('delete', req, res, { max: 3, segundos: 3600 })) return;

  try {
    /**
     * Só a própria pessoa.
     *
     * Com sessão iniciada, e o email da sessão — não o que vier no
     * corpo do pedido. Sem isto, qualquer um podia mandar apagar a
     * conta de outro.
     */
    const user = await getUserFromRequest(req);

    if (!user) {
      return res.status(401).json({ error: 'Sign in first.' });
    }

    const { data, error } = await supabase.rpc('request_deletion', {
      p_email: user.email,
      p_kind: req.body?.kind || 'customer'
    });

    if (error) throw error;

    if (data?.ok === false) {
      /**
       * Bloqueada: dizer porquê, com o número.
       *
       * "Não pode apagar" sem explicação leva a um email para o
       * apoio. "Tem duas viagens marcadas" resolve-se sozinho.
       */
      if (data.blocked) {
        return res.status(409).json({
          error: data.blocked.message || 'Your account cannot be closed yet.',
          reason: data.blocked.reason,
          count: data.blocked.count,
          amount: data.blocked.amount
        });
      }

      return res.status(400).json({ error: 'Could not start it.' });
    }

    // O email com o link. Sem ele, nada acontece.
    await sendDeletionConfirm({
      email: data.email,
      token: data.token
    }).catch((e) => console.error('deletion email:', e.message));

    return res.json({
      success: true,
      message: 'Check your email. The link works for 24 hours.'
    });
  } catch (error) {
    console.error('delete request:', error.message);
    return res.status(500).json({ error: error.message });
  }
});


/**
 * O link do email.
 *
 * Um GET, porque vem de um clique num email. Não leva sessão: o
 * token é a prova, e dura 24 horas.
 */
app.get('/api/account/delete-confirm', async (req, res) => {
  if (limitar('deleteconfirm', req, res, { max: 10, segundos: 3600 })) return;

  const token = String(req.query.token || '');

  if (!token) {
    return res.status(400).send('Missing token.');
  }

  try {
    const { data, error } = await supabase.rpc('confirm_deletion', {
      p_token: token
    });

    if (error) throw error;

    if (data?.ok === false) {
      const msg = data.blocked
        ? (data.blocked.message || 'Your account cannot be closed yet.')
        : 'That link has expired or has already been used.';

      return res.status(410).send(paginaSimples('Not done', msg));
    }

    /**
     * E a conta de autenticação.
     *
     * O SQL não lhe toca — o auth.users é gerido pela API de
     * administração do Supabase, e é aqui que se chama.
     *
     * Feito no fim: se falhar, os dados já saíram e o pior que
     * acontece é ficar uma conta vazia, que não identifica
     * ninguém.
     */
    if (data.user_id) {
      try {
        await supabase.auth.admin.deleteUser(data.user_id);
      } catch (e) {
        console.error('auth delete failed:', e.message);

        telegramTaskFailed('account deletion',
          `Data removed but auth user ${data.user_id} remains: ${e.message}`
        ).catch(() => {});
      }
    }

    console.log('[gdpr] account deleted:', data.email);

    return res.send(paginaSimples(
      'Your account is closed',
      'Your personal details have been removed. Bookings are kept ' +
      'without your name, because tax law requires it.'
    ));
  } catch (error) {
    console.error('delete confirm:', error.message);

    return res.status(500).send(paginaSimples(
      'Something went wrong',
      'Write to us and we will do it by hand.'
    ));
  }
});


/**
 * Uma página inteira numa função.
 *
 * O link do email abre no browser, e devolver JSON a um clique de
 * email é mostrar chavetas a alguém que esperava uma confirmação.
 */
function paginaSimples(titulo, texto) {
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${titulo} · Airportlink</title>
<style>
  body{margin:0;min-height:100vh;display:flex;align-items:center;
    justify-content:center;background:#FAFAF8;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif;
    color:#1A1A17;padding:24px}
  .box{max-width:440px;text-align:center}
  h1{font-size:22px;font-weight:600;margin:0 0 12px}
  p{font-size:15px;line-height:1.6;color:#6B6B63;margin:0 0 24px}
  a{display:inline-block;padding:11px 22px;border-radius:10px;
    background:#0D9488;color:#fff;text-decoration:none;
    font-size:14px;font-weight:600}
</style>
</head><body>
  <div class="box">
    <h1>${titulo}</h1>
    <p>${texto}</p>
    <a href="${process.env.SITE_ORIGIN || 'https://www.airportlink.app'}">Back to the site</a>
  </div>
</body></html>`;
}


/** Confirmar que a consulta de voos funciona. *//** Confirmar que a consulta de voos funciona. *//** Confirmar que a consulta de voos funciona. *//** Confirmar que a consulta de voos funciona. */
app.get('/api/tasks/flights-test', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  return res.json(await flightsTest());
});


/**
 * Confirmar que o calendário está ligado.
 *
 * Com ?keep=1 o evento fica, para se ver como aparece de verdade:
 * o título, as cores, os lembretes. Sem isso apaga-se logo, que é
 * o certo para um teste automático.
 */
app.get('/api/tasks/calendar-test', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const ficar = req.query.keep === '1';

  if (!ficar) {
    return res.json(await calendarTest());
  }

  /**
   * Um evento de exemplo, com dados a sério.
   *
   * Um teste que só diz "funciona" não mostra nada. Este cria uma
   * reserva plausível para amanhã e deixa-a lá, para se ver o
   * título na vista de mês, a cor, e o que a descrição leva.
   */
  const amanha = new Date();
  amanha.setDate(amanha.getDate() + 1);

  const exemplo = {
    id: 'test-' + Date.now(),
    booking_reference: 'TEST-001',
    booking_date: amanha.toISOString().slice(0, 10),
    booking_time: '14:30',
    duration_minutes: 45,

    full_name: 'Test Passenger',
    email: 'test@example.com',
    passenger_phone: '+351 912 345 678',

    pickup: 'Faro Airport, 8006-901 Faro, Portugal',
    dropoff: 'Albufeira, Portugal',
    passengers: 3,
    vehicle_class: 'sedan',
    flight_number: 'TP1234',
    preferred_language: 'pt',

    price: 55,
    currency: 'EUR',
    amount_total: 5500,
    notes: 'This is a test event. Delete it when you have seen it.',

    status: 'confirmed'
  };

  const result = await calendarUpsert(exemplo);

  return res.json({
    ...result,
    kept: true,
    note: 'A test event was created for tomorrow at 14:30. Turquoise, ' +
      'because it has no driver. Delete it by hand when you have seen it.'
  });
});


/**
 * ---------------------------------------------------------------
 * REENVIAR AS CONFIRMAÇÕES QUE NUNCA SAÍRAM
 *
 * A função de envio era um stub que devolvia { sent: true } sem
 * enviar nada. Durante semanas, quem se registou não recebeu o
 * email — e sem ele não entra, e não entrando não envia
 * documentos.
 *
 * Isto manda a cada um o link de confirmação. Uma vez, à mão.
 *
 * Corre com:
 *   curl -H "x-cron-secret: SEGREDO" \
 *     "https://airportlink.onrender.com/api/tasks/resend-verification"
 *
 * Acrescenta ?dry=1 para ver a lista sem enviar nada.
 * ---------------------------------------------------------------
 */
/**
 * ---------------------------------------------------------------
 * OS AVISOS PEDIDOS PELO SERVIÇO DOS DRIVERS
 *
 * O telegram.js vive só aqui. O outro serviço pede por esta rota,
 * como já faz para os emails.
 *
 * Uma cópia do telegram.js lá seriam dois sítios a manter — e o
 * dia em que divergissem, um canal ficava calado sem ninguém
 * saber.
 * ---------------------------------------------------------------
 */
app.post('/api/internal/alert', async (req, res) => {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured.' });
  }

  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    console.warn('internal/alert called with a bad secret');
    return res.status(403).json({ error: 'Forbidden' });
  }

  const { tipo, dados } = req.body || {};

  const AVISOS = {
    new_chat: telegramNewChat,
    new_account: telegramNewAccount,
    new_agency: telegramNewAgency,
    new_partner: telegramNewPartner
  };

  const fn = AVISOS[tipo];

  if (!fn) {
    return res.status(400).json({
      error: `Unknown alert: ${tipo}`,
      allowed: Object.keys(AVISOS)
    });
  }

  try {
    await fn(dados || {});
    return res.json({ sent: true });
  } catch (e) {
    console.error('internal/alert:', tipo, e.message);
    return res.status(500).json({ error: e.message });
  }
});


/**
 * ---------------------------------------------------------------
 * MANDAR UM EMAIL DE TESTE A UM ENDEREÇO
 *
 * Sem passar pela tabela de parceiros. Serve para ver se o link
 * funciona antes de o mandar a nove pessoas — que foi o que
 * faltou fazer à primeira.
 *
 *   /api/tasks/test-verify?email=x@y.com&kind=partner
 * ---------------------------------------------------------------
 */
/**
 * ---------------------------------------------------------------
 * RECUPERAR UMA RESERVA QUE NAO FOI CRIADA
 *
 * O cliente pagou, o webhook correu, e o insert rebentou — por
 * falta de contacto, por uma coluna em falta, pelo que for.
 *
 * O dinheiro esta no Stripe e nao ha reserva nenhuma. Isto vai
 * buscar a sessao ao Stripe e reconstroi a reserva a partir dos
 * metadados.
 *
 *   /api/tasks/rebuild?session=cs_live_xxxxx
 *
 * Ou, sem sessao, percorre os pagamentos das ultimas 48 horas e
 * repara os que nao tem reserva:
 *
 *   /api/tasks/rebuild?since=48
 * ---------------------------------------------------------------
 */
/**
 * ---------------------------------------------------------------
 * LIGAR UM CARTAO GUARDADO A UM CLIENTE DO STRIPE
 *
 * As reservas de "pagar depois" criadas antes desta correcao tem
 * o cartao guardado mas nenhum cliente — a sessao usava
 * customer_email, que guarda o cartao e nao cria cliente nenhum.
 *
 * Sem cliente, o charge-due nao cobra: ele precisa dos dois.
 *
 *   /api/tasks/fix-customer?booking=AL1806844
 *
 * Ou todas as que estao nessa situacao:
 *
 *   /api/tasks/fix-customer?all=1
 * ---------------------------------------------------------------
 */
app.get('/api/tasks/fix-customer', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    let query = supabase
      .from('bookings')
      .select('id, booking_id, email, full_name, phone, stripe_payment_method_id, stripe_setup_intent_id, stripe_customer_id')
      .eq('payment_mode', 'later')
      .is('charged_at', null)
      .is('stripe_customer_id', null)
      .not('stripe_payment_method_id', 'is', null);

    if (req.query.booking) {
      query = query.eq('booking_id', String(req.query.booking));
    }

    const { data: reservas, error } = await query;
    if (error) throw error;

    const out = { encontradas: reservas?.length || 0, ligadas: [], falhas: [] };

    for (const r of (reservas || [])) {
      try {
        /**
         * Um cliente por reserva, com o cartao ligado.
         *
         * O attach pega no metodo de pagamento que ja existe e
         * liga-o ao cliente novo. O cartao e o mesmo — o que muda
         * e passar a haver a quem cobrar.
         */
        const cliente = await stripe.customers.create({
          email: r.email,
          name: r.full_name || undefined,
          phone: r.phone || undefined,
          metadata: { booking_id: r.booking_id, created_via: 'fix_customer' }
        });

        await stripe.paymentMethods.attach(r.stripe_payment_method_id, {
          customer: cliente.id
        });

        const { error: erroGravar } = await supabase
          .from('bookings')
          .update({ stripe_customer_id: cliente.id })
          .eq('id', r.id);

        if (erroGravar) throw erroGravar;

        out.ligadas.push({ booking: r.booking_id, customer: cliente.id });

        console.log('[fix-customer]', r.booking_id, '->', cliente.id);
      } catch (e) {
        out.falhas.push({ booking: r.booking_id, erro: e.message });
        console.error('[fix-customer]', r.booking_id, e.message);
      }
    }

    return res.json(out);
  } catch (e) {
    console.error('fix-customer:', e.message);
    return res.status(500).json({ error: e.message });
  }
});


app.get('/api/tasks/rebuild', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  try {
    const uma = String(req.query.session || '').trim();

    if (uma) {
      const session = await stripe.checkout.sessions.retrieve(uma);

      if (!session) {
        return res.status(404).json({ error: 'Sessao nao encontrada no Stripe.' });
      }

      await repairBookingFromSession(session);

      const { data } = await supabase
        .from('bookings')
        .select('id, booking_id, email, price_eur')
        .eq('stripe_checkout_session_id', uma)
        .maybeSingle();

      return res.json({
        session: uma,
        pago: session.payment_status,
        reserva: data || null,
        ok: Boolean(data)
      });
    }

    /**
     * Sem sessao: as ultimas horas.
     *
     * O Stripe devolve as sessoes por ordem inversa. Cem chegam
     * para dois dias — mais do que isso e melhor ir ao painel
     * deles.
     */
    const horas = Math.min(Number(req.query.since) || 48, 168);
    const desde = Math.floor((Date.now() - horas * 3600 * 1000) / 1000);

    const lista = await stripe.checkout.sessions.list({
      limit: 100,
      created: { gte: desde }
    });

    const out = { vistas: 0, pagas: 0, reparadas: [], ja_existiam: 0 };

    for (const session of (lista.data || [])) {
      out.vistas += 1;

      // Só as completas: uma sessao aberta ou expirada e alguem
      // que desistiu, nao alguem que reservou.
      if (session.status !== 'complete') continue;

      if (session.payment_status !== 'paid' && session.mode !== 'setup') continue;
      out.pagas += 1;

      const { data: existe } = await supabase
        .from('bookings')
        .select('id')
        .eq('stripe_checkout_session_id', session.id)
        .maybeSingle();

      if (existe) { out.ja_existiam += 1; continue; }

      try {
        await repairBookingFromSession(session);

        const { data: nova } = await supabase
          .from('bookings')
          .select('booking_id, email')
          .eq('stripe_checkout_session_id', session.id)
          .maybeSingle();

        out.reparadas.push({
          session: session.id,
          email: session.metadata?.email || session.customer_details?.email,
          criada: Boolean(nova),
          booking_id: nova?.booking_id || null
        });
      } catch (e) {
        out.reparadas.push({ session: session.id, erro: e.message });
      }
    }

    console.log('[rebuild]', JSON.stringify(out));

    return res.json(out);
  } catch (e) {
    console.error('rebuild:', e.message);
    return res.status(500).json({ error: e.message });
  }
});


app.get('/api/tasks/test-verify', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const email = String(req.query.email || '').trim();
  const kind = req.query.kind === 'customer' ? 'customer' : 'partner';

  if (!email) {
    return res.status(400).json({ error: 'Manda ?email=' });
  }

  try {
    /**
     * A conta tem de existir.
     *
     * O generateLink cria um token para um utilizador; se ele não
     * existir, devolve um erro que não diz isso claramente.
     */
    const { data: lista } = await supabase.auth.admin.listUsers();
    const existe = (lista?.users || []).find(
      (u) => u.email?.toLowerCase() === email.toLowerCase()
    );

    if (!existe) {
      return res.status(404).json({
        error: `Não há conta com ${email}. O generateLink precisa de uma.`
      });
    }

    const r = await sendVerification(email, req.query.name || null, kind);

    /**
     * O "duplicate" explicado.
     *
     * O anti-duplicados devolve isso quando já foi enviado um
     * email igual hoje. A palavra sozinha não diz o que fazer.
     */
    const nota = r.reason === 'duplicate'
      ? 'Já foi enviado um hoje. O anti-duplicados deixa passar um ' +
        'por dia e por endereço — amanhã passa, ou apaga a linha do ' +
        'email_log para forçar.'
      : 'O link vai no registo do Render, procura por [verify]';

    return res.json({
      ...r,
      email,
      kind,
      confirmado: Boolean(existe.email_confirmed_at),
      nota
    });
  } catch (e) {
    console.error('test-verify:', e.message);
    return res.status(500).json({ error: e.message });
  }
});


app.get('/api/tasks/resend-verification', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    /**
     * Um 403 que diz porquê.
     *
     * "Forbidden" sozinho não distingue um segredo errado de um
     * segredo em falta, nem de um espaço a mais colado sem querer.
     *
     * Isto não revela o segredo: diz só o comprimento e os
     * primeiros caracteres, que chega para perceber se é o valor
     * certo mal copiado.
     */
    const recebido = req.headers['x-cron-secret'];

    console.warn('[cron] segredo recusado. recebido:',
      recebido ? `${recebido.length} chars` : 'nenhum',
      '| esperado:', process.env.CRON_SECRET
        ? `${process.env.CRON_SECRET.length} chars` : 'NÃO CONFIGURADO');

    return res.status(403).json({
      error: 'Forbidden',
      pista: !process.env.CRON_SECRET
        ? 'CRON_SECRET não está configurado no servidor'
        : !recebido
          ? 'não enviaste o cabeçalho x-cron-secret'
          : recebido.length !== process.env.CRON_SECRET.length
            ? `enviaste ${recebido.length} caracteres, o servidor espera ` +
              `${process.env.CRON_SECRET.length}`
            : 'o comprimento bate mas o valor não — confirma que copiaste do Render'
    });
  }

  const ensaio = req.query.dry === '1';

  /**
   * Um só, para testar.
   *
   * ?only=alguem@exemplo.com manda a esse e salta os outros.
   *
   * Testar num de cada vez vale mais do que mandar nove e
   * descobrir que o link não funciona — foi o que aconteceu à
   * primeira.
   */
  const apenas = String(req.query.only || '').trim().toLowerCase();

  try {
    /**
     * Os parceiros que ainda não confirmaram.
     *
     * Só os que estão em draft ou pending: quem já foi aprovado
     * entrou de alguma maneira, e mandar-lhe um email de
     * confirmação agora seria confuso.
     */
    const { data: parceiros, error } = await supabase
      .from('driver_partners')
      .select('id, email, contact_name, trading_name, legal_name, status, created_at')
      .in('status', ['draft', 'pending'])
      .order('created_at');

    if (error) throw error;

    const out = { total: parceiros?.length || 0, enviados: 0, falhas: [], lista: [] };

    for (const p of (parceiros || [])) {
      if (!p.email) continue;

      // Com ?only=, os outros ficam de fora.
      if (apenas && p.email.toLowerCase() !== apenas) continue;

      /**
       * Já confirmou?
       *
       * Alguns podem ter confirmado por outra via — ou o SQL de
       * recuperação pode já ter marcado o email como confirmado.
       * Mandar outro link a esses é ruído.
       */
      const { data: u } = await supabase.auth.admin.getUserById(p.id);

      /**
       * O email confirmado não quer dizer que ele consiga entrar.
       *
       * A lógica antiga saltava quem já tinha o email confirmado,
       * e mandava o link só aos outros. Mas confirmar o email é
       * uma coisa e saber a palavra-passe é outra.
       *
       * Estes registaram-se há semanas e nunca receberam nada.
       * Confirmado ou não, o que precisam é do mesmo: um email a
       * dizer que a conta existe e como definir a palavra-passe.
       *
       * Um email a mais a quem já entrou é ruído. Nenhum email a
       * quem não consegue entrar é um parceiro perdido.
       */
      if (ensaio) {
        out.lista.push({
          email: p.email,
          estado: u?.user?.email_confirmed_at
            ? 'ia receber (email já confirmado)'
            : 'ia receber'
        });
        continue;
      }

      await confirmarEmailDe(p.id, p.email);

      const r = await sendPartnerAccessLink({
        email: p.email,
        name: p.contact_name,
        company: p.trading_name || p.legal_name
      });

      if (r?.sent) {
        out.enviados += 1;
        out.lista.push({ email: p.email, estado: 'enviado' });
      } else {
        out.falhas.push({ email: p.email, porque: r?.reason || 'desconhecido' });
      }

      /**
       * Meio segundo entre cada um.
       *
       * O Resend tem limites por segundo, e uma lista de trinta
       * de uma vez pode levar com um 429 a meio — e aí metade
       * continua sem receber.
       */
      await new Promise((r2) => setTimeout(r2, 500));
    }

    console.log('[resend-verification]', JSON.stringify(out));

    return res.json({ ...out, ensaio, apenas: apenas || null });
  } catch (e) {
    console.error('resend-verification:', e.message);
    return res.status(500).json({ error: e.message });
  }
});


app.get('/api/tasks/telegram-test', async (req, res) => {
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  const result = await telegramTest();
  return res.json(result);
});


app.post('/api/tasks/daily-emails', async (req, res) => {
  if (!process.env.CRON_SECRET) {
    return res.status(500).json({ error: 'CRON_SECRET is not configured.' });
  }
  if (req.headers['x-cron-secret'] !== process.env.CRON_SECRET) {
    return res.status(403).json({ error: 'Forbidden' });
  }

  /**
   * O trabalho de fundo ainda corre?
   *
   * O cron chama o support-tick de minuto a minuto. Se parar,
   * ninguém é avisado de conversas à espera, as ofertas de viagem
   * não avançam, e as disputas ficam por tratar.
   *
   * Nada disto dá erro: as coisas simplesmente deixam de
   * acontecer. É o pior tipo de falha — a silenciosa.
   *
   * O telegramTickDown existia há semanas e nunca era chamado. O
   * verificar.py apanhou-o.
   */
  try {
    const { data: ultimo } = await supabase
      .from('support_tick_log')
      .select('ran_at')
      .order('ran_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    if (ultimo?.ran_at) {
      const minutos = Math.round((Date.now() - new Date(ultimo.ran_at)) / 60000);

      // Uma hora sem correr: o cron parou ou o serviço adormeceu e
      // ninguém o acordou.
      if (minutos > 60) {
        await telegramTickDown(minutos);
      }
    }
  } catch (e) {
    console.error('tick check:', e.message);
  }

  /**
   * O site está a receber reservas?
   *
   * O alarme mais simples e o mais útil. Se algo estiver partido
   * de uma maneira que não dá erro — a calculadora fechada, o
   * botão morto, o checkout a recusar — nota-se pela ausência.
   *
   * A 10 de setembro a calculadora esteve horas a recusar toda a
   * gente. Ninguém soube até um cliente tentar reservar.
   *
   * Um dia mau tem poucas reservas. Um dia partido tem zero.
   */
  try {
    const desde = new Date(Date.now() - 18 * 3600 * 1000).toISOString();

    const { count } = await supabase
      .from('bookings')
      .select('id', { count: 'exact', head: true })
      .gte('created_at', desde);

    if (count === 0) {
      await telegramSemReservas(18);
    }
  } catch (e) {
    console.error('no-bookings check:', e.message);
  }

  const out = {
    driver_details: 0, held: 0, no_driver: 0, reminders: 0,
    expiring: 0, expired: 0, unclaimed: 0, errors: []
  };

  const day = (offset) => {
    const d = new Date();
    d.setDate(d.getDate() + offset);
    return d.toISOString().slice(0, 10);
  };

  // ---------- 1. o motorista, na véspera ----------
  try {
    // Sem filtro por assigned_partner_id: uma viagem com motorista
    // manual pode não ter parceiro nenhum, e é precisamente essa que
    // interessa não esquecer.
    const { data: rides } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_date', day(1))
      .neq('status', 'cancelled')
      .is('driver_details_sent_at', null);

    for (const ride of (rides || [])) {
      if (ride.driver_email_hold) {
        out.held += 1;
        continue;
      }

      const result = await sendDriverDetailsFor(ride);

      if (result.sent) out.driver_details += 1;
      else if (result.reason === 'no-driver') out.no_driver += 1;
    }
  } catch (error) {
    out.errors.push('driver_details: ' + error.message);
  }

  // ---------- 1b. o lembrete ao cliente, 24 horas antes ----------
  //
  // Quem reservou há três semanas não recebe nada até o motorista
  // aparecer. Esse silêncio é o que gera as chamadas de "confirmam
  // que está tudo bem?".
  //
  // E é a última oportunidade de apanhar um erro: uma morada
  // errada, um voo mudado, um telefone que já não serve.
  try {
    const { data: amanha } = await supabase
      .from('bookings')
      .select('*')
      .eq('booking_date', day(1))
      .neq('status', 'cancelled')
      .is('reminder_sent_at', null);

    for (const b of (amanha || [])) {
      if (!b.email) continue;

      /**
       * O motorista, se já estiver escolhido.
       *
       * Com ele, o lembrete vale o dobro: saber o nome e a
       * matrícula antes de chegar tira a parte pior de uma chegada
       * nocturna. Sem ele, o email diz que virá depois.
       */
      let driver = null;

      if (b.assigned_driver_id) {
        const { data: d } = await supabase
          .from('drivers')
          .select('full_name, phone')
          .eq('id', b.assigned_driver_id)
          .maybeSingle();

        const { data: v } = b.assigned_vehicle_id
          ? await supabase
              .from('partner_vehicles')
              .select('make, model, plate')
              .eq('id', b.assigned_vehicle_id)
              .maybeSingle()
          : { data: null };

        if (d) {
          driver = {
            name: d.full_name,
            phone: d.phone,
            vehicle: v ? `${v.make} ${v.model}` : null,
            plate: v?.plate
          };
        }
      }

      const result = await sendTripReminder(b, driver);

      if (result.sent) {
        out.reminders = (out.reminders || 0) + 1;

        // Marcar depois de enviar. Se o email falhar, a passagem de
        // amanhã tenta outra vez — e amanhã já é o dia da viagem,
        // por isso é a última hipótese.
        await supabase.from('bookings')
          .update({ reminder_sent_at: new Date().toISOString() })
          .eq('id', b.id);
      }
    }
  } catch (error) {
    out.errors.push('reminders: ' + error.message);
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

        /**
         * O registo da cobranca, com o erro lido.
         *
         * Se este insert falhar em silencio, ficas com dinheiro
         * cobrado no Stripe e nenhum registo de o teres cobrado —
         * e a proxima passagem do charge-due pode tentar outra
         * vez.
         *
         * A cobranca ja aconteceu e nao se desfaz. O que se pode
         * fazer e gritar.
         */
        const { error: erroRegisto } = await supabase
          .from('charge_attempts').insert({
            booking_id: booking.id, attempt_no: attemptNo, outcome: 'succeeded',
            amount: Number(booking.price || 0), currency, stripe_id: intent.id
          });

        if (erroRegisto) {
          console.error('[charge] cobrado mas sem registo:',
            booking.booking_id, intent.id, erroRegisto.message);

          telegramTaskFailed('charge registado',
            `${booking.booking_id} foi COBRADO no Stripe (${intent.id}) mas o ` +
            `registo falhou: ${erroRegisto.message}. Confirmar antes de ` +
            'qualquer nova tentativa.'
          ).catch(() => {});
        }

        results.charged += 1;
        console.log('Scheduled charge succeeded:', booking.booking_id || booking.id);
        await sendChargeSucceeded(booking);

        /**
         * O cadeado fecha na agenda.
         *
         * Um pay-later que já foi cobrado não é diferente de um
         * pago à cabeça — e o título tem de o dizer, senão o
         * calendário mente sobre o que ainda está por receber.
         */
        calendarUpsert({ ...booking, amount_total: Math.round(Number(booking.price || 0) * 100) })
          .catch(() => {});
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
            `Reference: ${refDe(booking)}`,
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

/**
 * O último apanhador, depois de todas as rotas.
 *
 * Um erro que escape a uma rota chega aqui. Sem isto, o Express
 * responde com a página de erro por omissão — HTML, sem
 * cabeçalhos de CORS — e o browser mostra "Failed to fetch", que
 * não diz nada sobre a causa.
 *
 * Isto aconteceu no checkout: quinze pontos da função podiam
 * lançar fora de um try, e qualquer um deles dava um erro de CORS
 * que parecia um problema de configuração.
 */
app.use((err, req, res, next) => {
  console.error('[erro não tratado]', req.method, req.path, err);

  telegramTaskFailed(`${req.method} ${req.path}`,
    `Unhandled: ${err.message}`
  ).catch(() => {});

  if (res.headersSent) return next(err);

  /**
   * Os cabeçalhos de CORS, à mão.
   *
   * O middleware do cors() já correu quando um erro chega aqui, e
   * a resposta de erro sai sem eles. Repô-los é a diferença entre
   * o cliente ver a mensagem e ver "Failed to fetch".
   */
  const origin = req.headers.origin;

  if (origin && originAllowed(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }

  return res.status(500).json({
    error: 'Something went wrong on our side. Please try again.'
  });
});


app.listen(PORT, async () => {
  // Uma leitura qualquer confirma que a chave é a certa. Mais vale
  // descobrir aqui do que na primeira reserva, com um cliente à
  // espera e um "permission denied" no log.
  await checkConnection();

  console.log(`Server running on ${PORT}`);
  await loadExchangeRates();
});

/**
 * O aviso de arranque saiu.
 *
 * O plano gratuito do Render adormece aos 15 minutos e acorda a
 * cada visita — o que dava dezenas de avisos por dia, todos a
 * dizer o mesmo.
 *
 * Um aviso que chega dezenas de vezes deixa de ser lido, e leva
 * consigo os que interessam.
 */
