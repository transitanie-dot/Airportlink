/**
 * calendar.js — as viagens na agenda
 * ---------------------------------------------------------------
 * Cada reserva vira um evento no Google Calendar, com cor conforme
 * o estado:
 *
 *   turquesa      ainda sem motorista
 *   azul escuro   motorista atribuído
 *   vermelho      cancelada
 *
 * E um cadeado no título quando já está paga. Sem cadeado é uma
 * conta por fechar — que é o que se procura ao olhar para o mês.
 *
 * A cor muda sozinha quando a cascata encontra parceiro. Assim o
 * calendário conta a história sem ninguém lhe tocar — um mês
 * inteiro visto de relance diz onde faltou cobertura.
 *
 * O Telegram trata do imediato; isto trata do panorama.
 *
 * COMO CONFIGURAR:
 *
 *   1. console.cloud.google.com — projeto novo, Calendar API
 *      ativada, credenciais OAuth de aplicação Web com o
 *      redirecionamento para developers.google.com/oauthplayground
 *
 *   2. No OAuth Playground, com "Use your own OAuth credentials"
 *      marcado e o âmbito calendar.events, obter o refresh token
 *
 *   3. No Google Calendar, criar um calendário só para isto e
 *      copiar o ID das definições dele
 *
 *   4. No Render:
 *      GOOGLE_CALENDAR_CLIENT_ID
 *      GOOGLE_CALENDAR_CLIENT_SECRET
 *      GOOGLE_CALENDAR_REFRESH_TOKEN
 *      GOOGLE_CALENDAR_ID
 *
 * Sem as variáveis, tudo isto não faz nada e não dá erro. Um
 * evento que falha não deve travar uma reserva.
 * ---------------------------------------------------------------
 */

const CLIENT_ID = process.env.GOOGLE_CALENDAR_CLIENT_ID;
const CLIENT_SECRET = process.env.GOOGLE_CALENDAR_CLIENT_SECRET;
const REFRESH_TOKEN = process.env.GOOGLE_CALENDAR_REFRESH_TOKEN;
const CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID;

const ligado = Boolean(CLIENT_ID && CLIENT_SECRET && REFRESH_TOKEN && CALENDAR_ID);

/**
 * As cores do Google, por número.
 *
 * São onze e os nomes não são óbvios. Turquesa é a 7 (Peacock),
 * azul escuro é a 9 (Blueberry). Os números não mudam.
 */
const COR = {
  sem_motorista: '7',   // turquesa (Peacock)
  com_motorista: '9',   // azul escuro (Blueberry)
  cancelada: '11'       // vermelho (Tomato)
};

/**
 * O fuso das viagens.
 *
 * Uma reserva às 14:30 em Faro é às 14:30 em Faro, não em UTC. Sem
 * isto, o Google interpretaria a hora no fuso do calendário e o
 * evento aparecia três horas trocado.
 *
 * Por agora todas as viagens são na Europa Ocidental. Quando
 * houver noutros fusos, isto passa a vir da zona da reserva.
 */
const FUSO = 'Europe/Lisbon';


/**
 * Um token de acesso, a partir do de atualização.
 *
 * Os de acesso duram uma hora; o de atualização não expira. Pede-se
 * um novo a cada chamada — é mais simples do que guardar e ver se
 * ainda serve, e o Google não se importa.
 */
async function token() {
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: CLIENT_ID,
      client_secret: CLIENT_SECRET,
      refresh_token: REFRESH_TOKEN,
      grant_type: 'refresh_token'
    })
  });

  const data = await res.json();

  if (!data.access_token) {
    /**
     * O token de atualização foi revogado.
     *
     * Acontece quando se muda a senha do Google, se retira o acesso
     * à app, ou passam seis meses sem uso. E nada avisa: os eventos
     * simplesmente deixam de aparecer.
     *
     * Por isso o erro é explícito — quem ler os registos percebe o
     * que fazer.
     */
    throw new Error(
      'Google refused the refresh token: ' + (data.error_description || data.error) +
      '. Get a new one at developers.google.com/oauthplayground.'
    );
  }

  return data.access_token;
}


/** Quando começa e acaba a viagem. */
function horas(booking) {
  const dia = booking.booking_date;
  const hora = (booking.booking_time || '12:00').slice(0, 5);

  const inicio = `${dia}T${hora}:00`;

  /**
   * A duração vem da rota, com uma hora por omissão.
   *
   * Um transfer de duas horas ocupar trinta minutos na agenda faria
   * o calendário mentir sobre o que se pode marcar por cima.
   */
  const minutos = Number(booking.duration_minutes) || 60;

  const fim = new Date(new Date(inicio).getTime() + minutos * 60000);
  const fimStr = fim.toISOString().slice(0, 19);

  return { inicio, fim: fimStr };
}


/** O que o evento diz. */
function corpo(booking, partner) {
  const { inicio, fim } = horas(booking);

  const pax = booking.passengers || 1;
  const temMotorista = Boolean(booking.assigned_partner_id || partner);

  /**
   * A classe de viatura.
   *
   * Nem sempre está na reserva — vem da metadata do Stripe e alguns
   * caminhos não a preenchem. Sem ela, deriva-se dos passageiros,
   * com a mesma regra do site.
   */
  const chave = booking.vehicle_class ||
    (pax <= 3 ? 'sedan' : pax <= 4 ? 'premium' : pax <= 8 ? 'van'
      : pax <= 13 ? 'van_sedan' : 'two_vans');

  const CARRO = {
    sedan: 'Sedan',
    premium: 'Premium',
    van: 'Van',
    van_sedan: 'Van+Sedan',
    two_vans: '2 Vans'
  };

  /**
   * A cidade, tirada da morada.
   *
   * As moradas completas não cabem no título de um evento — na
   * vista de mês vê-se meia dúzia de palavras. "Faro Airport,
   * 8006-901 Faro, Portugal" ocupa a linha toda e não diz mais do
   * que "Faro".
   *
   * A regra: o primeiro pedaço antes da vírgula, sem "Airport". É
   * uma aproximação, mas acerta na esmagadora maioria e falha de
   * forma inofensiva — mostra um pouco mais de texto.
   */
  const cidade = (t) => {
    if (!t) return '';

    let x = String(t).split(',')[0];

    // Códigos de aeroporto entre parênteses: (AGP), (FCO).
    x = x.replace(/\([A-Z]{3}\)/g, '');

    /**
     * As palavras de aeroporto, com as preposições que as
     * acompanham.
     *
     * "Aeroporto de Lisboa" tem de dar "Lisboa", não "de Lisboa" —
     * por isso o "de", "di", "of" e "d'" entram na mesma regra.
     */
    x = x.replace(
      /\b(airport|aeroporto|aeropuerto|aéroport|aeroporto)\b\s*(de|do|da|di|of|d')?\s*/gi,
      ''
    );

    /**
     * O número da porta, quando a morada começa por ele.
     *
     * "Via del Corso 12" é uma rua, não uma cidade — mas o título
     * fica melhor sem o número, e quem precisa da morada exata
     * abre o evento.
     */
    x = x.replace(/\s+\d+[a-zA-Z]?$/, '');

    x = x.replace(/\s+/g, ' ').trim();

    /**
     * Se sobrar de mais, corta-se.
     *
     * Uma morada sem vírgulas — acontece — enche o título e esconde
     * o resto. Vinte e dois caracteres é o que cabe antes de a
     * vista de mês truncar.
     */
    return x.length > 22 ? x.slice(0, 21).trim() + '…' : x;
  };

  const de = cidade(booking.pickup);
  const para = cidade(booking.dropoff);

  /**
   * O título é o que se lê na vista de mês.
   *
   * A hora e o dia já os dá o calendário. O que ele não mostra é o
   * carro, para onde vai, e se tem motorista — e é isso que aqui
   * está, por essa ordem de importância.
   */
  /**
   * Pago agora ou pago depois.
   *
   * A cor já está a dizer duas coisas — se tem motorista, e se foi
   * cancelada. Uma terceira não cabe: onze cores num calendário
   * deixam de significar nada.
   *
   * Um símbolo no início resolve, e lê-se na vista de mês sem
   * abrir nada. O aberto é uma conta por fechar; o fechado é
   * dinheiro que já entrou.
   */
  /**
   * Pago é pago, não é "tem um valor".
   *
   * Isto olhava para o amount_total — que está preenchido em todas
   * as reservas, incluindo as de pay later, porque é o preço da
   * viagem e não o que já entrou.
   *
   * Resultado: o cadeado aparecia fechado desde o primeiro momento
   * e nunca mudava. Um calendário que diz que está tudo pago não
   * serve para saber o que falta cobrar.
   *
   * O payment_status é o que sabe: só passa a 'paid' quando o
   * Stripe confirma.
   */
  const pago = booking.payment_status === 'paid'
    || booking.payment_status === 'succeeded'
    || Boolean(booking.charged_at);

  const cancelada = booking.status === 'cancelled';

  // O símbolo cola-se ao carro: um ponto entre eles seria ruído
  // numa linha que já tem três.
  /**
   * O cadeado só aparece quando está pago.
   *
   * Havia um aberto para o pay later, e isso era ruído: numa
   * agenda com vinte eventos, vinte símbolos não distinguem nada.
   *
   * O cadeado fechado passa a querer dizer uma coisa só — este
   * dinheiro já entrou. O que não o tem está por cobrar, e é isso
   * que se procura ao olhar para o mês.
   */
  const marca = cancelada
    ? 'CANCELLED'
    : `${pago ? '🔒 ' : ''}${CARRO[chave] || chave}`;

  /**
   * A perna, quando há duas.
   *
   * Uma ida e volta são dois eventos com a mesma referência e
   * moradas invertidas. Sem uma marca, quem olha para a agenda tem
   * de ler as moradas inteiras para saber qual é qual — e às sete
   * da manhã isso engana-se.
   *
   * Nas reservas de sentido único não aparece nada: uma marca que
   * está sempre lá não distingue nada.
   */
  const perna = booking.leg === 2 ? 'RETURN'
    : (booking.paired_booking_id || booking.trip_group_id) ? 'OUT'
    : null;

  /**
   * A referência fica na descrição, não no título.
   *
   * O título é para se ler de relance na vista de mês — o carro, o
   * percurso, se tem motorista. Um código de nove letras à frente
   * empurra tudo isso para fora do espaço visível.
   *
   * Quem precisa da referência abre o evento.
   */
  const titulo = [
    marca,
    perna,
    cancelada ? (CARRO[chave] || chave) : null,
    `${de} → ${para}`,
    `${pax}p`,
    cancelada
      ? null
      : (temMotorista ? (partner?.trading_name || 'assigned') : 'NO DRIVER')
  ].filter(Boolean).join(' · ');

  const linhas = [
    /**
     * A referência primeiro.
     *
     * É o que o cliente diz ao telefone e o que se procura no
     * painel. Estava só no título, onde o Google a corta quando o
     * evento é curto — e não estava de todo na descrição.
     */
    refDe(booking) ? `Ref: ${refDe(booking)}` : '',
    '',
    booking.full_name || booking.passenger_name || '',
    booking.passenger_phone || booking.phone_number || '',
    booking.email || '',
    '',
    `Passengers: ${pax}`,
    booking.flight_number ? `Flight: ${booking.flight_number}` : '',
    booking.preferred_language ? `Language: ${booking.preferred_language}` : '',
    '',
    `Price: ${Number(booking.price || 0).toFixed(2)} ${String(booking.currency || 'EUR').toUpperCase()}`,
    booking.amount_total != null ? 'Paid now' : 'Pay later',
    '',
    temMotorista
      ? `Partner: ${partner?.trading_name || partner?.legal_name || 'assigned'}`
      : 'NO DRIVER ASSIGNED',
    '',
    booking.notes ? `Notes: ${booking.notes}` : '',
    `Ref: ${refDe(booking)}`
  ].filter(Boolean);

  return {
    summary: titulo,
    description: linhas.join('\n'),

    // A morada de recolha vai no local: assim o telemóvel dá
    // direções com um toque.
    location: booking.pickup,

    start: { dateTime: inicio, timeZone: FUSO },
    end: { dateTime: fim, timeZone: FUSO },

    colorId: booking.status === 'cancelled'
      ? COR.cancelada
      : (temMotorista ? COR.com_motorista : COR.sem_motorista),

    /**
     * O id da reserva no evento.
     *
     * É o que permite encontrá-lo depois para mudar a cor quando o
     * motorista aparecer. Sem isto, a única forma seria guardar o
     * id do evento na nossa base — mais uma coluna e mais uma coisa
     * que pode ficar dessincronizada.
     */
    extendedProperties: {
      private: { booking_id: String(booking.id) }
    },

    reminders: {
      useDefault: false,
      overrides: [
        // Um dia antes, para haver tempo de resolver o que falta.
        { method: 'popup', minutes: 24 * 60 },
        // E duas horas antes, para o dia.
        { method: 'popup', minutes: 120 }
      ]
    }
  };
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
  return refDe(b) || String(b.id || '').slice(0, 8);
}


/**
 * Criar ou atualizar o evento de uma reserva.
 *
 * Procura primeiro: se já existe, atualiza — que é o que faz a cor
 * mudar quando o motorista é atribuído. Se não, cria.
 */
export async function calendarUpsert(booking, partner) {
  if (!ligado) return { ok: false, reason: 'not-configured' };
  if (!booking?.booking_date) return { ok: false, reason: 'no-date' };

  try {
    const t = await token();
    const cal = encodeURIComponent(CALENDAR_ID);

    // Já existe?
    const busca = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${cal}/events` +
      `?privateExtendedProperty=booking_id%3D${encodeURIComponent(booking.id)}` +
      `&maxResults=1&showDeleted=false`,
      { headers: { Authorization: `Bearer ${t}` } }
    );

    const encontrados = await busca.json();
    const existente = encontrados.items?.[0];

    const evento = corpo(booking, partner);

    const res = await fetch(
      existente
        ? `https://www.googleapis.com/calendar/v3/calendars/${cal}/events/${existente.id}`
        : `https://www.googleapis.com/calendar/v3/calendars/${cal}/events`,
      {
        method: existente ? 'PATCH' : 'POST',
        headers: {
          Authorization: `Bearer ${t}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(evento)
      }
    );

    const data = await res.json();

    if (data.error) {
      console.error('[calendar]', data.error.message);
      return { ok: false, reason: data.error.message };
    }

    console.log('[calendar]', existente ? 'updated' : 'created',
      refDe(booking),
      evento.colorId === COR.com_motorista ? '(blue)' : '(turquoise)');

    return { ok: true, id: data.id, updated: Boolean(existente) };
  } catch (error) {
    /**
     * Nunca lança para fora.
     *
     * Um evento que falha não deve travar uma reserva, nem fazer o
     * webhook devolver erro ao Stripe — o Stripe reenviaria e a
     * reserva seria criada duas vezes.
     */
    console.error('[calendar] upsert failed:', error.message);
    return { ok: false, reason: error.message };
  }
}


/**
 * Apagar o evento de uma reserva cancelada.
 *
 * Ou marcar como cancelado, que é o que fazemos: um evento
 * apagado desaparece sem rasto, e saber que houve uma reserva
 * cancelada naquele dia é informação.
 */
export async function calendarCancel(booking) {
  if (!ligado) return { ok: false, reason: 'not-configured' };

  return calendarUpsert({ ...booking, status: 'cancelled' });
}


/**
 * Confirmar que está tudo ligado.
 *
 * Cria um evento de teste amanhã e apaga-o a seguir. É a única
 * forma de saber que o token, o calendário e as permissões estão
 * todos certos.
 */
export async function calendarTest() {
  if (!ligado) {
    return {
      ok: false,
      configured: false,
      missing: [
        !CLIENT_ID && 'GOOGLE_CALENDAR_CLIENT_ID',
        !CLIENT_SECRET && 'GOOGLE_CALENDAR_CLIENT_SECRET',
        !REFRESH_TOKEN && 'GOOGLE_CALENDAR_REFRESH_TOKEN',
        !CALENDAR_ID && 'GOOGLE_CALENDAR_ID'
      ].filter(Boolean)
    };
  }

  try {
    const t = await token();
    const cal = encodeURIComponent(CALENDAR_ID);

    const amanha = new Date();
    amanha.setDate(amanha.getDate() + 1);
    const dia = amanha.toISOString().slice(0, 10);

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${cal}/events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${t}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          summary: 'Airportlink — connection test',
          description: 'If you can see this, the calendar is connected. ' +
            'It deletes itself in a moment.',
          start: { dateTime: `${dia}T09:00:00`, timeZone: FUSO },
          end: { dateTime: `${dia}T09:30:00`, timeZone: FUSO },
          colorId: COR.sem_motorista
        })
      }
    );

    const data = await res.json();

    if (data.error) {
      return { ok: false, configured: true, error: data.error.message };
    }

    // Apagar a seguir: um evento de teste que fica é lixo na
    // agenda de alguém.
    await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${cal}/events/${data.id}`,
      { method: 'DELETE', headers: { Authorization: `Bearer ${t}` } }
    );

    return {
      ok: true,
      configured: true,
      calendar: CALENDAR_ID,
      message: 'Created and deleted a test event. Everything works.'
    };
  } catch (error) {
    return { ok: false, configured: true, error: error.message };
  }
}
