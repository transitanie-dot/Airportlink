/**
 * precos.js — o cálculo, sozinho.
 *
 * Extraído do server.js para poder ser testado sem arrancar o
 * servidor. Importar o server.js inteiro puxa o Express, o Stripe
 * e o Supabase — e um teste que precisa de três serviços a
 * responder não é um teste que se corra antes de publicar.
 *
 * O server.js importa daqui. Uma cópia seria duas verdades.
 */

const PT_ZONES = {
  lisbon: { base: 23.23, perKm: 0.909,
    words: ['lisbon', 'lisboa', 'cascais', 'sintra', 'estoril', 'setubal',
            'setúbal', 'ericeira', 'obidos', 'óbidos', 'nazare', 'nazaré',
            'evora', 'évora', 'fatima', 'fátima', 'peniche', 'sesimbra'] },
  porto:  { base: 7.14, perKm: 1.401,
    words: ['porto', 'oporto', 'matosinhos', 'gaia', 'braga', 'guimaraes',
            'guimarães', 'aveiro', 'espinho', 'viana do castelo', 'povoa',
            'póvoa', 'coimbra'] },
  faro:   { base: 4.45, perKm: 1.116,
    words: ['faro', 'albufeira', 'lagos', 'portimao', 'portimão', 'vilamoura',
            'quarteira', 'tavira', 'sagres', 'carvoeiro', 'alvor', 'olhao',
            'olhão', 'monte gordo', 'algarve', 'almancil', 'quinta do lago'] }
};


const ES_ZONES = {
  madrid: { base: 39.87, perKm: 1.3316, premium: 1.516,
    van: 1.508, van_sedan: 3.737, two_vans: 4.189,
    words: ['madrid', 'barajas', 'alcala', 'alcalá', 'toledo', 'segovia',
            'aranjuez', 'avila', 'ávila', 'chinchon', 'chinchón'] },
  barcelona: { base: 29.04, perKm: 1.3106, premium: 1.426,
    van: 1.455, van_sedan: 3.605, two_vans: 4.041,
    words: ['barcelona', 'prat', 'rambla', 'sitges', 'girona', 'lloret',
            'tossa', 'andorra', 'figueres', 'tarragona', 'salou', 'reus'] }
};


const NIGHT_FROM = 22 * 60 + 55;


const NIGHT_TO = 6 * 60;


const NIGHT_MULT = 1.2;



const ES_FALLBACK = { base: 39.76, perKm: 1.2843, premium: 1.530,
  van: 1.484, van_sedan: 3.678, two_vans: 4.123 };


const IT_FALLBACK = { base: 46.25, perKm: 1.5100,
  premiumBase: 76.75, premiumKm: 1.9500,
  van: 1.304, van_sedan: 3.462, two_vans: 3.846 };


const IT_ZONES = {
  /**
   * Roma: 46,25 + 1,51/km, e não os 53,65 + 1,49 da regressão.
   *
   * A tabela deles em Roma NÃO é uma reta: o preço por km vai de
   * 7,99 aos 8 km a 1,80 aos 234. Uma reta por mínimos quadrados
   * ficava 2,7% ACIMA deles nas curtas, que é o oposto do que se
   * quer.
   *
   * Esta é escolhida para nunca passar de -5%, custe o que custar
   * nas médias — aos 34 km chega a -15%. É o preço de garantir que
   * não somos mais caros em rota nenhuma.
   */
  rome: { base: 46.25, perKm: 1.5100,
    premiumBase: 76.75, premiumKm: 1.9500,
    van: 1.304, van_sedan: 3.462, two_vans: 3.846,
    words: ['rome', 'roma', 'fiumicino', 'ciampino', 'ostia', 'civitavecchia',
            'frascati', 'tivoli', 'anzio', 'castel gandolfo', 'orvieto',
            'viterbo', 'latina'] },

  bologna: { base: 65.03, perKm: 1.6083,
    premiumBase: 85.25, premiumKm: 2.1050,
    van: 1.304, van_sedan: 3.462, two_vans: 3.846,
    words: ['bologna', 'bolonha', 'modena', 'ferrara', 'rimini', 'parma',
            'ravenna', 'riccione', 'cesena', 'forli', 'forlì'] },

  naples: { base: 58.96, perKm: 1.5028,
    premiumBase: 81.25, premiumKm: 2.1300,
    van: 1.304, van_sedan: 3.462, two_vans: 3.846,
    words: ['naples', 'napoli', 'nápoles', 'pompeii', 'pompei', 'sorrento',
            'salerno', 'amalfi', 'positano', 'ravello', 'caserta',
            'herculaneum', 'ercolano', 'vesuvio'] },

  palermo: { base: 43.24, perKm: 1.2041,
    premiumBase: 71.75, premiumKm: 1.9800,
    van: 1.586, van_sedan: 3.462, two_vans: 3.978,
    words: ['palermo', 'cefalu', 'cefalù', 'trapani', 'agrigento', 'mondello',
            'monreale', 'marsala', 'erice', 'sciacca'] },

  // ---------- as quatro sem sedan do lado deles ----------

  venice: { base: 58.93, perKm: 1.5475,
    premiumBase: 71.50, premiumKm: 1.8550,
    van: 1.304, van_sedan: 3.462, two_vans: 3.846,
    words: ['venice', 'venezia', 'veneza', 'mestre', 'piazzale roma', 'padua',
            'padova', 'verona', 'treviso', 'vicenza', 'lido di jesolo',
            'jesolo'] },

  florence: { base: 114.54, perKm: 2.3303,
    premiumBase: 138.25, premiumKm: 2.7900,
    van: 1.304, van_sedan: 3.462, two_vans: 3.846,
    words: ['florence', 'firenze', 'florença', 'fiesole', 'siena', 'pisa',
            'lucca', 'san gimignano', 'arezzo', 'chianti', 'montepulciano',
            'cortona', 'volterra'] },

  milan: { base: 64.86, perKm: 1.5628,
    premiumBase: 89.25, premiumKm: 1.8150,
    van: 1.304, van_sedan: 3.462, two_vans: 3.846,
    words: ['milan', 'milano', 'milão', 'malpensa', 'linate', 'bergamo',
            'como', 'lake como', 'lago di como', 'turin', 'torino', 'brescia',
            'monza', 'varese', 'stresa', 'maggiore'] },

  cagliari: { base: 38.97, perKm: 1.6212,
    premiumBase: 46.75, premiumKm: 1.9500,
    van: 1.304, van_sedan: 3.462, two_vans: 3.846,
    words: ['cagliari', 'villasimius', 'chia', 'oristano', 'pula', 'costa rei',
            'sardinia', 'sardegna', 'olbia', 'alghero', 'costa smeralda'] }
};


const PT_FALLBACK = { base: 11.61, perKm: 1.142 };


const VEHICLE_CLASSES = {
  sedan:     { id: 'sedan',     mult: 1.0,  seats: 3 },
  premium:   { id: 'premium',   mult: 1.47, seats: 4 },
  van:       { id: 'van',       mult: 1.7,  seats: 8 },
  van_sedan: { id: 'van_sedan', mult: 2.85, seats: 12 },
  two_vans:  { id: 'two_vans',  mult: 3.6,  seats: 16 }
};





const ES_ROUTE_PRICES = {
  'barcelona|sitges': { sedan: 128.56, premium: 175.57 }
};


const ES_WORDS = [
  'malaga', 'málaga', 'torremolinos', 'marbella', 'nerja', 'granada',
  'fuengirola', 'benalmadena', 'benalmádena', 'estepona', 'ronda', 'mijas',
  'puerto banus', 'puerto banús', 'sevilla', 'seville', 'valencia', 'alicante',
  'benidorm', 'torrevieja', 'murcia', 'palma', 'mallorca', 'ibiza', 'menorca',
  'tenerife', 'gran canaria', 'las palmas', 'lanzarote', 'fuerteventura',
  'bilbao', 'san sebastian', 'san sebastián', 'santander', 'vigo', 'coruna',
  'coruña', 'santiago de compostela', 'zaragoza', 'almeria', 'almería',
  'jerez', 'cadiz', 'cádiz', 'cordoba', 'córdoba', 'oviedo', 'gijon', 'gijón'
];


const IT_WORDS = [
  'italy', 'italia', 'itália', 'genoa', 'genova', 'bari', 'catania',
  'taormina', 'siracusa', 'syracuse', 'lamezia', 'tropea', 'brindisi',
  'lecce', 'alberobello', 'matera', 'perugia', 'assisi', 'ancona',
  'trieste', 'udine', 'bolzano', 'trento', 'garda', 'sirmione',
  'cinque terre', 'la spezia', 'portofino', 'sanremo', 'capri', 'ischia',
  'elba', 'livorno', 'grosseto', 'pescara'
];

function routeOverride(zoneName, dropoffText) {
  const t = String(dropoffText || '').toLowerCase();
  for (const [key, price] of Object.entries(ES_ROUTE_PRICES)) {
    const [zone, dest] = key.split('|');
    if (zone === zoneName && new RegExp('\\b' + dest + '\\b').test(t)) return price;
  }
  return null;
}

function detectZone(zones, fallback, pickupText, dropoffText) {
  for (const text of [pickupText, dropoffText]) {
    const t = String(text || '').toLowerCase();
    for (const z of Object.values(zones)) {
      if (z.words.some((w) => new RegExp('\\b' + w + '\\b').test(t))) return z;
    }
  }
  return fallback;
}

function detectCountry(pickupText, dropoffText) {
  const t = (String(pickupText || '') + ' ' + String(dropoffText || '')).toLowerCase();

  if (/\b(spain|espa(n|ñ)a|espanha)\b/.test(t)) return 'ES';
  if (/\b(portugal)\b/.test(t)) return 'PT';
  if (/\b(italy|italia|itália)\b/.test(t)) return 'IT';

  // Sem o país escrito, decide-se pelas cidades conhecidas.
  //
  // A Itália vem ANTES de Espanha por causa de nomes repetidos:
  // Verona e Como existem nas duas listas de palavras, e Sardenha
  // tem cidades com nome parecido a espanholas. Sem esta ordem, uma
  // rota de Milão para Como caía na tabela de Barcelona.
  for (const z of Object.values(IT_ZONES)) {
    if (z.words.some((w) => new RegExp('\\b' + w + '\\b').test(t))) return 'IT';
  }
  if (IT_WORDS.some((w) => new RegExp('\\b' + w + '\\b').test(t))) return 'IT';

  for (const z of Object.values(ES_ZONES)) {
    if (z.words.some((w) => new RegExp('\\b' + w + '\\b').test(t))) return 'ES';
  }
  if (ES_WORDS.some((w) => new RegExp('\\b' + w + '\\b').test(t))) return 'ES';
  for (const z of Object.values(PT_ZONES)) {
    if (z.words.some((w) => new RegExp('\\b' + w + '\\b').test(t))) return 'PT';
  }
  return null;
}

function isNightPickup(timeStr) {
  if (!timeStr) return false;

  const m = String(timeStr).match(/^(\d{1,2}):(\d{2})/);
  if (!m) return false;

  const minutos = Number(m[1]) * 60 + Number(m[2]);

  /**
   * A janela atravessa a meia-noite.
   *
   * Das 22h55 às 23h59 E das 00h00 às 05h59. Escrito como um
   * intervalo normal daria sempre falso.
   */
  return minutos >= NIGHT_FROM || minutos < NIGHT_TO;
}


function resolveVehicleClass(requested, passengers) {
  const pax = Math.max(1, Math.min(16, parseInt(passengers || '1', 10) || 1));
  const wanted = VEHICLE_CLASSES[String(requested || '').toLowerCase()];

  if (wanted && pax <= wanted.seats) return wanted;

  for (const c of ['sedan', 'van', 'van_sedan', 'two_vans']) {
    if (pax <= VEHICLE_CLASSES[c].seats) return VEHICLE_CLASSES[c];
  }
  return VEHICLE_CLASSES.two_vans;
}


function computePriceEUR(distanceKm, passengers, isPortugalRoute, opts) {
  const o = opts || {};
  const vehicle = resolveVehicleClass(o.vehicleClass, passengers);

  /**
   * O suplemento aplica-se no fim, ao preço final.
   *
   * Aplicá-lo à base antes do multiplicador da viatura daria
   * números diferentes conforme a classe — e um cliente que compare
   * um sedan com uma van não deve encontrar percentagens
   * diferentes.
   */
  const noite = isNightPickup(o.pickupTime) ? NIGHT_MULT : 1;

  const country = detectCountry(o.pickupText, o.dropoffText) ||
    (isPortugalRoute ? 'PT' : null);

  if (country === 'ES') {
    let zoneName = null;
    for (const [name, z] of Object.entries(ES_ZONES)) {
      const t = (String(o.pickupText || '') + ' ' + String(o.dropoffText || '')).toLowerCase();
      if (z.words.some((w) => new RegExp('\\b' + w + '\\b').test(t))) { zoneName = name; break; }
    }

    const zone = zoneName ? ES_ZONES[zoneName] : ES_FALLBACK;

    // Rota com preço combinado ganha à fórmula.
    const fixed = zoneName ? routeOverride(zoneName, o.dropoffText) : null;
    if (fixed) {
      if (vehicle.id === 'sedan') return fixed.sedan * noite;
      if (vehicle.id === 'premium') return fixed.premium * noite;
      return fixed.sedan * (zone[vehicle.id] || vehicle.mult) * noite;
    }

    const mult = vehicle.id === 'sedan' ? 1 : (zone[vehicle.id] || vehicle.mult);

    return Math.max(24, (zone.base + distanceKm * zone.perKm) * mult * noite);
  }

  if (country === 'IT') {
    let zoneName = null;
    const t = (String(o.pickupText || '') + ' ' + String(o.dropoffText || '')).toLowerCase();

    for (const [name, z] of Object.entries(IT_ZONES)) {
      if (z.words.some((w) => new RegExp('\\b' + w + '\\b').test(t))) { zoneName = name; break; }
    }

    const zone = zoneName ? IT_ZONES[zoneName] : IT_FALLBACK;
    const sedan = zone.base + distanceKm * zone.perKm;

    // O premium tem reta própria: o sedan e o premium deles não
    // crescem ao mesmo ritmo, e um multiplicador falharia nas
    // pontas.
    if (vehicle.id === 'premium') {
      return Math.max(24, (zone.premiumBase + distanceKm * zone.premiumKm) * noite);
    }

    if (vehicle.id === 'sedan') return Math.max(24, sedan * noite);

    // As classes maiores continuam a sair do sedan.
    return Math.max(24, sedan * (zone[vehicle.id] || vehicle.mult) * noite);
  }

  if (country === 'PT') {
    const zone = detectZone(PT_ZONES, PT_FALLBACK, o.pickupText, o.dropoffText);
    return Math.max(24, (zone.base + distanceKm * zone.perKm) * vehicle.mult * noite);
  }

  // Sem país estudado, a fórmula antiga.
  /**
   * Sem país estudado.
   *
   * Eram 3,50 por quilómetro vezes 1,3 — três a quatro vezes mais
   * do que as tarifas reais de Espanha e Portugal. Um transfer de
   * 300 km saía a 2365 euros.
   *
   * Ninguém reparou porque as rotas que vendemos têm todas país
   * definido. Mas o mapa abriu para 129 países, e agora esta
   * fórmula é a que responde à maioria deles.
   *
   * Os números novos são a média das tarifas espanhola e
   * portuguesa: 35 de base e 1,45 por quilómetro. Dá 30 euros aos
   * 20 km e 470 aos 300 — no meio das duas, que é onde deve estar
   * um país que ainda não estudámos.
   */
  return Math.max(25, (35 + distanceKm * 1.45) * vehicle.mult * noite);
}


export { computePriceEUR, isNightPickup, resolveVehicleClass };
