/**
 * telegram.js — avisos no telemóvel
 * ---------------------------------------------------------------
 * O email de operações não serve para o que é urgente. Chega a uma
 * caixa que se lê quando se lê, e mais um email entre vinte não
 * chama a atenção de ninguém.
 *
 * O Telegram é gratuito, sem limite de mensagens, e a notificação
 * é nativa do telemóvel. Custa cinco minutos a montar: fala-se com
 * o @BotFather, ele dá um token, e daqui faz-se um POST.
 *
 * DOIS CANAIS, de propósito:
 *
 *   vendas    uma venda nova, um parceiro que se registou. Coisas
 *             boas que se leem quando der.
 *
 *   alarmes   uma viagem amanhã sem motorista, uma disputa, o cron
 *             parado. Coisas que acordam.
 *
 * Assim silencia-se o primeiro à noite e o segundo não. Num canal
 * só, ou se silencia tudo ou nada.
 *
 * COMO CONFIGURAR:
 *
 *   1. No Telegram, fala com @BotFather e cria um bot.
 *      Ele devolve um token: 1234567890:AAF...
 *
 *   2. Cria dois grupos ou canais e acrescenta o bot a cada um.
 *
 *   3. Manda uma mensagem em cada e abre:
 *      https://api.telegram.org/bot<TOKEN>/getUpdates
 *      O chat.id de cada um está lá. Os de grupo são negativos.
 *
 *   4. No Render:
 *      TELEGRAM_BOT_TOKEN=1234567890:AAF...
 *      TELEGRAM_SALES_CHAT=-1001234567890
 *      TELEGRAM_ALERTS_CHAT=-1009876543210
 *
 * Sem as variáveis, tudo isto não faz nada e não dá erro. É o
 * comportamento certo: um aviso que falha não deve travar uma
 * reserva.
 * ---------------------------------------------------------------
 */

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SALES = process.env.TELEGRAM_SALES_CHAT;
const ALERTS = process.env.TELEGRAM_ALERTS_CHAT;

const API = TOKEN ? `https://api.telegram.org/bot${TOKEN}` : null;


/**
 * Escapar o que o Telegram trata como formatação.
 *
 * Uma morada com um underscore ou um parêntesis quebra a mensagem
 * inteira em MarkdownV2 — e a mensagem não chega, sem erro nenhum
 * do nosso lado.
 */
function esc(v) {
  return String(v == null ? '' : v)
    .replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (c) => '\\' + c);
}


/**
 * Mandar uma mensagem.
 *
 * Nunca lança. Um aviso que falha não deve travar uma reserva, nem
 * fazer o webhook devolver erro ao Stripe — o Stripe reenviaria o
 * evento e a reserva seria criada duas vezes.
 */
async function send(chatId, text, options = {}) {
  if (!API || !chatId) return { sent: false, reason: 'not-configured' };

  try {
    const res = await fetch(`${API}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        parse_mode: 'MarkdownV2',
        // As pré-visualizações de link enchem o ecrã e escondem a
        // mensagem seguinte.
        disable_web_page_preview: true,
        // O silencioso serve para o canal de vendas à noite.
        disable_notification: options.silent === true
      })
    });

    const data = await res.json();

    if (!data.ok) {
      console.error('[telegram]', data.description);
      return { sent: false, reason: data.description };
    }

    return { sent: true, id: data.result?.message_id };
  } catch (error) {
    console.error('[telegram] send failed:', error.message);
    return { sent: false, reason: error.message };
  }
}


/**
 * Uma venda nova.
 *
 * Vai para o canal de vendas, que se pode silenciar. É uma coisa
 * boa e não precisa de acordar ninguém — mas ver as vendas a
 * entrar ao longo do dia diz mais sobre o negócio do que qualquer
 * relatório.
 */
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
 * Uma tarefa automática falhou.
 *
 * Vai para o canal de alarmes, com som. É a diferença entre saber
 * que uma coisa parou e descobri-lo uma semana depois — o que
 * aconteceu com o Google Calendar, cujo token expirou e ninguém
 * reparou até um cliente perguntar pela reserva.
 *
 * A chave evita repetir: um cron que falha de minuto a minuto
 * mandaria mil e quatrocentas mensagens por dia, e a milésima não
 * diz nada que a primeira não tenha dito.
 */
const avisadosRecentemente = new Map();

export async function telegramTaskFailed(tarefa, erro, detalhe) {
  const chave = `${tarefa}:${String(erro).slice(0, 60)}`;
  const agora = Date.now();

  /**
   * Uma hora de silêncio por erro repetido.
   *
   * Tempo suficiente para não encher o canal, curto para o
   * problema não passar despercebido um turno inteiro.
   */
  const ultimo = avisadosRecentemente.get(chave);

  if (ultimo && agora - ultimo < 3600000) return { skipped: true };

  avisadosRecentemente.set(chave, agora);

  // A memória não cresce sem fim: fora o que já passou de duas
  // horas.
  for (const [k, t] of avisadosRecentemente) {
    if (agora - t > 7200000) avisadosRecentemente.delete(k);
  }

  const linhas = [
    `⚠️ *${esc(tarefa)}* failed`,
    '',
    esc(String(erro).slice(0, 300))
  ];

  if (detalhe) {
    linhas.push('', esc(String(detalhe).slice(0, 300)));
  }

  /**
   * A data também passa pelo esc.
   *
   * "09 Sep, 14:32" tem uma vírgula e um ponto — ambos reservados
   * no MarkdownV2. Sem escapar, o Telegram recusa a mensagem
   * inteira com "can't parse entities", e o alarme perde-se
   * exatamente quando é preciso.
   */
  linhas.push('', `_${esc(new Date().toLocaleString('en-GB', {
    timeZone: 'America/Recife',
    day: '2-digit', month: 'short',
    hour: '2-digit', minute: '2-digit'
  }))}_`);

  return send(ALERTS, linhas.join('\n'), { silent: false });
}


/**
 * Uma tarefa voltou a funcionar.
 *
 * Só se tinha falhado antes. Saber que uma coisa se resolveu vale
 * tanto como saber que parou — sem isso, alguém vai investigar um
 * problema que já não existe.
 */
export async function telegramTaskRecovered(tarefa) {
  const tinhaFalhado = [...avisadosRecentemente.keys()]
    .some((k) => k.startsWith(tarefa + ':'));

  if (!tinhaFalhado) return { skipped: true };

  // Limpar, para o próximo problema avisar de imediato.
  for (const k of [...avisadosRecentemente.keys()]) {
    if (k.startsWith(tarefa + ':')) avisadosRecentemente.delete(k);
  }

  return send(ALERTS,
    `✅ *${esc(tarefa)}* is working again`,
    { silent: true });
}


export async function telegramNewBooking(booking, assignment) {
  /**
   * O valor em EUROS, não em cêntimos.
   *
   * O amount_total vem do Stripe em cêntimos — 16336 são 163,36 €.
   * Mostrá-lo cru dava "163366.00 EUR", um número absurdo que faz
   * duvidar de tudo o resto na mensagem.
   *
   * O price é o valor já em euros, e é o que se mostra. O
   * amount_total só serve de reserva, dividido por cem.
   */
  const valor = booking.price != null
    ? Number(booking.price)
    : (booking.amount_total != null ? Number(booking.amount_total) / 100 : null);

  const moeda = String(booking.currency || 'EUR').toUpperCase();

  /**
   * Pago agora ou pago depois.
   *
   * Muda o que temos de fazer: um pay-later é cobrado 48 horas
   * antes, e se o cartão falhar aí é preciso alguém falar com o
   * cliente.
   */
  const pagou = booking.amount_total != null || booking.payment_status === 'paid';

  /**
   * A classe de viatura.
   *
   * Nem sempre está na reserva: vem da metadata do Stripe e alguns
   * caminhos não a preenchem. Sem ela, deriva-se dos passageiros —
   * a mesma regra do site, para os números baterem.
   */
  const pax = Number(booking.passengers) || 1;

  const chave = booking.vehicle_class ||
    (pax <= 3 ? 'sedan' : pax <= 4 ? 'premium' : pax <= 8 ? 'van'
      : pax <= 13 ? 'van_sedan' : 'two_vans');

  const classe = {
    sedan: 'Sedan',
    premium: 'Premium sedan',
    van: 'Van',
    van_sedan: 'Van + sedan',
    two_vans: 'Two vans'
  }[chave] || chave;

  /**
   * Quando a reserva entrou.
   *
   * Diferente da data da viagem, e as duas confundem-se. Uma
   * reserva feita agora para daqui a três semanas e uma feita
   * ontem para amanhã pedem coisas diferentes — a segunda tem
   * pressa.
   *
   * A hora é a do Recife, que é onde estás. O created_at vem em
   * UTC — três horas à frente — e mostrá-lo cru faria uma reserva
   * das 21h aparecer como meia-noite do dia seguinte.
   */
  const quando = booking.created_at
    ? new Date(booking.created_at).toLocaleString('en-GB', {
        timeZone: 'America/Recife',
        day: '2-digit', month: 'short',
        hour: '2-digit', minute: '2-digit'
      })
    : null;

  const linhas = [
    '*New booking*',
    ...(quando ? [esc('booked ' + quando)] : []),
    '',

    // ---------- quem ----------
    `*${esc(booking.full_name || booking.passenger_name || 'No name')}*`,
    esc(booking.email || ''),
    esc(booking.passenger_phone || booking.phone_number || 'no phone'),
    '',

    // ---------- a viagem ----------
    `📍 ${esc(booking.pickup)}`,
    `🏁 ${esc(booking.dropoff)}`,
    '',

    /**
     * A data da VIAGEM, não a de hoje.
     *
     * Mostrava o created_at, e por isso uma reserva feita ontem
     * para daqui a três semanas aparecia com a data de hoje. A
     * data que interessa é quando o carro tem de estar lá.
     */
    /**
     * E a lua, quando é de noite.
     *
     * Um transfer às três da manhã é mais difícil de atribuir: há
     * menos motoristas disponíveis, e quem vir a mensagem sabe que
     * pode ter de procurar mais.
     */
    `📅 ${esc(booking.booking_date)} at ${esc(booking.booking_time || '—')}` +
      (booking.night_surcharge ? '  🌙 night' : ''),
    `👥 ${esc(booking.passengers)} passenger${booking.passengers === 1 ? '' : 's'}` +
      ` · ${esc(classe)}`,
    '',

    // ---------- o dinheiro ----------
    `💶 *${esc(valor != null ? valor.toFixed(2) : '?')} ${esc(moeda)}*` +
      ` · ${pagou ? 'paid now' : 'pay later'}`
  ];

  if (booking.flight_number) {
    linhas.push(`✈️ ${esc(booking.flight_number)}`);
  }

  if (booking.preferred_language) {
    linhas.push(`🗣 prefers ${esc(booking.preferred_language)}`);
  }

  linhas.push('');

  /**
   * A quem foi oferecida, se a cascata já correu.
   *
   * "Offered to X" é normal. "Nobody in the zone" é o que interessa
   * ver, porque é uma venda que não temos como servir.
   */
  if (assignment?.partner) {
    linhas.push(`→ Offered to *${esc(assignment.partner)}*`);
  } else if (assignment?.stage === 'open') {
    linhas.push('⚠️ *Nobody in the zone* — on the open board');
  }

  // A referência, se já foi gerada. Nos primeiros segundos pode
  // ainda não estar — o id serve na mesma para a procurar.
  const ref = booking.booking_id || refDe(booking);

  if (ref) linhas.push('', `\`${esc(ref)}\``);

  return send(SALES, linhas.join('\n'), { silent: false });
}


/**
 * Uma viagem sem motorista.
 *
 * Vai para os alarmes, com som. É o caso que custa dinheiro: uma
 * viagem que ninguém vai fazer, descoberta no dia, resolve-se com
 * um táxi pago por nós.
 */
export async function telegramNoDriver(bookings) {
  if (!bookings?.length) return { sent: false, reason: 'nothing' };

  const criticas = bookings.filter((b) => b.urgency === 'critical');

  const titulo = criticas.length
    ? `🚨 *${criticas.length} trip${criticas.length === 1 ? '' : 's'} within 12 hours with no driver*`
    : `⚠️ *${bookings.length} trip${bookings.length === 1 ? '' : 's'} with no driver*`;

  const linhas = [titulo, ''];

  // No máximo oito: uma lista de trinta não se lê no telemóvel, e
  // o que interessa está no topo porque vem ordenado por urgência.
  for (const b of bookings.slice(0, 8)) {
    const quando = b.hours_until < 24
      ? `in ${Math.round(b.hours_until)}h`
      : `${b.booking_date}`;

    linhas.push(
      `${b.urgency === 'critical' ? '🔴' : '🟠'} ` +
      `*${esc(quando)}* · ${esc(b.pickup)} → ${esc(b.dropoff)}`
    );
    linhas.push(
      `   ${esc(b.passengers)} pax · ${esc(b.offers_made)} offer` +
      `${b.offers_made === 1 ? '' : 's'} made · \`${esc(b.booking_reference || '')}\``
    );
  }

  if (bookings.length > 8) {
    linhas.push('', esc(`and ${bookings.length - 8} more`));
  }

  return send(ALERTS, linhas.join('\n'));
}


/**
 * O resumo do dia, à meia-noite.
 *
 * Duas coisas diferentes que se confundem: o que ENTROU hoje
 * (vendas) e o que se FEZ hoje (viagens operadas). Uma reserva
 * pode entrar hoje para daqui a três semanas, e uma viagem de hoje
 * pode ter sido vendida em agosto.
 *
 * Vai para o canal de vendas, silencioso — à meia-noite ninguém
 * precisa de acordar com isto. Só toca se amanhã ficar alguma
 * coisa por resolver.
 */
export async function telegramDaySummary(s) {
  if (!s) return { sent: false, reason: 'nothing' };

  const v = s.sales || {};
  const op = s.operated || {};
  const of = s.offers || {};
  const moeda = v.currency || 'EUR';

  const n = (x) => Number(x || 0).toFixed(0);
  const n2 = (x) => Number(x || 0).toFixed(2);

  const linhas = [`*${esc(s.day || '')}*`, ''];

  // ---------- o que se vendeu ----------
  if (v.count > 0) {
    /**
     * O VENDIDO primeiro, não o cobrado.
     *
     * O resumo somava o amount_total, que é nulo nos pay later —
     * uma noite com cinco reservas pay later mostrava "0 EUR", e
     * isso é pior do que não mostrar nada: parece que não se
     * vendeu.
     */
    linhas.push(
      `📥 *${esc(v.count)} booking${v.count === 1 ? '' : 's'}* · ` +
      `${esc(n(v.sold))} ${esc(moeda)}`
    );

    const detalhe = [];

    if (v.paid_now) detalhe.push(`${v.paid_now} paid`);

    // O que fica para cobrar, e quanto. É dinheiro que existe mas
    // ainda não entrou.
    if (v.pay_later) {
      detalhe.push(`${v.pay_later} pay later (${n(v.to_charge)})`);
    }

    if (v.from_agency) detalhe.push(`${v.from_agency} from agencies`);

    if (detalhe.length) linhas.push(`   ${esc(detalhe.join(' · '))}`);

    /**
     * O que sobrou depois da Stripe.
     *
     * A diferença entre o cobrado e o liquidado é a taxa — e é a
     * única despesa que se paga em cada venda, por isso vale a
     * linha.
     */
    if (v.stripe_fees > 0) {
      linhas.push(
        `   _${esc(n2(v.charged))} charged · ` +
        `${esc(n2(v.stripe_fees))} Stripe · ` +
        `${esc(n2(v.settled))} settled_`
      );
    }
  } else {
    linhas.push('📥 No bookings today');
  }

  // ---------- os pay later cobrados hoje ----------
  const c = s.charged_today || {};

  if (c.count > 0) {
    linhas.push('');
    linhas.push(
      `💳 *${esc(c.count)} pay later charged* · ${esc(n(c.amount))} ${esc(moeda)}`
    );
  }

  // ---------- os reembolsos ----------
  const r = s.refunds || {};

  if (r.count > 0) {
    linhas.push('');
    linhas.push(
      `↩️ *${esc(r.count)} refund${r.count === 1 ? '' : 's'}* · ` +
      `${esc(n(r.amount))} ${esc(moeda)}`
    );
  }

  // ---------- as rotas ----------
  const rotas = s.top_routes || [];

  if (rotas.length) {
    linhas.push('');
    linhas.push('🗺 *Where they are going*');

    rotas.forEach((x) => {
      linhas.push(
        `   ${esc(x.de || '?')} → ${esc(x.para || '?')} · ` +
        `${esc(x.n)}× · ${esc(n(x.valor))}`
      );
    });
  }

  // ---------- o que se fez ----------
  if (op.total > 0) {
    linhas.push('');
    linhas.push(
      `🚗 *${esc(op.total)} transfer${op.total === 1 ? '' : 's'} today*`
    );

    const partes = [];
    if (op.completed) partes.push(`${op.completed} done`);
    if (op.cancelled) partes.push(`${op.cancelled} cancelled`);
    if (op.no_shows) partes.push(`${op.no_shows} no-show`);
    if (op.no_driver) partes.push(`${op.no_driver} with no driver`);

    if (partes.length) linhas.push(`   ${esc(partes.join(' · '))}`);

    // O que se deve aos parceiros pelas de hoje.
    if (op.partner_payout > 0) {
      linhas.push(`   _${esc(n(op.partner_payout))} owed to partners_`);
    }

    /**
     * O custo dos táxis.
     *
     * É a margem que se perdeu por não ter cobertura. Se aparecer
     * todos os dias na mesma zona, é onde falta recrutar.
     */
    if (op.taxi_fallback > 0) {
      linhas.push(
        `   ⚠️ ${esc(op.taxi_fallback)} by taxi · ` +
        `${esc(n(op.taxi_cost))} ${esc(moeda)} out of margin`
      );
    }
  }

  // ---------- a cascata ----------
  if (of.made > 0) {
    linhas.push('');
    linhas.push(
      `📨 *${esc(of.made)} offer${of.made === 1 ? '' : 's'}* · ` +
      `${esc(of.accepted)} accepted`
    );

    const problemas = [];
    if (of.declined) problemas.push(`${of.declined} declined`);
    if (of.expired) problemas.push(`${of.expired} ignored`);

    if (problemas.length) linhas.push(`   ${esc(problemas.join(' · '))}`);

    if (of.active_partners) {
      linhas.push(`   _${esc(of.active_partners)} partners drove today_`);
    }
  }

  // ---------- o apoio ----------
  const ap = s.support || {};

  if (ap.conversations > 0) {
    linhas.push('');
    linhas.push(
      `💬 ${esc(ap.conversations)} conversation${ap.conversations === 1 ? '' : 's'}` +
      (ap.closed ? ` · ${esc(ap.closed)} closed` : '')
    );
  }

  /**
   * Amanhã, no fim.
   *
   * É a única linha sobre o futuro, e a que decide se alguém vai
   * trabalhar esta noite. Por isso fica no fim: é o que se lê por
   * último e o que fica na cabeça.
   */
  const am = s.tomorrow || {};

  if (am.total > 0) {
    linhas.push('');
    linhas.push(
      `📅 *Tomorrow:* ${esc(am.total)} transfer${am.total === 1 ? '' : 's'}` +
      (am.no_driver
        ? ` · *${esc(am.no_driver)} with no driver*`
        : ' · all covered')
    );
  }

  /**
   * Silencioso quando o dia correu bem.
   *
   * Um resumo às 23h59 não precisa de acordar ninguém. Mas se
   * houver viagens sem motorista amanhã, ou táxis a sair da
   * margem, isso é para agora.
   */
  const urgente = am.no_driver > 0 || op.no_driver > 0 || op.taxi_fallback > 0;

  return send(ALERTS, linhas.join('\n'), { silent: !urgente });
}


/** Uma disputa no Stripe. O prazo é curto e perde-se por omissão. */
export async function telegramDispute(booking, dispute, daysLeft) {
  const linhas = [
    '🚨 *Stripe dispute*',
    '',
    booking
      ? `${esc(booking.pickup)} → ${esc(booking.dropoff)}`
      : 'No booking found for this charge',
    `${esc((dispute.amount / 100).toFixed(2))} ` +
      esc(String(dispute.currency).toUpperCase()),
    `Reason: ${esc(dispute.reason)}`,
    ''
  ];

  if (daysLeft != null) {
    linhas.push(
      daysLeft <= 0
        ? '*The deadline has passed\\.*'
        : `*Respond within ${esc(daysLeft)} day${daysLeft === 1 ? '' : 's'}* ` +
          'or it is lost by default\\.'
    );
  }

  return send(ALERTS, linhas.join('\n'));
}


/** Um parceiro novo à espera de aprovação. */
export async function telegramNewPartner(partner) {
  return send(SALES, [
    '*New partner application*',
    '',
    esc(partner.trading_name || partner.legal_name),
    esc(partner.country || ''),
    esc(partner.email || '')
  ].join('\n'), { silent: false });
}


/**
 * Uma conversa de apoio nova.
 *
 * Vai para o canal de alarmes, não para o de vendas: alguém está à
 * espera de resposta, e isso é uma coisa a fazer, não uma coisa
 * boa que aconteceu.
 *
 * Silenciosa de propósito. Num dia com trinta conversas, trinta
 * apitos ensinam a ignorar o canal — e o que se quer é que os
 * apitos a sério continuem a valer alguma coisa.
 */
export async function telegramNewChat(chat) {
  const quem = {
    customer: '👤 Customer',
    agency: '🏢 Travel agent',
    partner: '🚗 Driver partner'
  }[chat.audience || 'customer'] || '👤 Customer';

  /**
   * O básico: quem, e a referência.
   *
   * O assunto e a primeira mensagem ficam no painel — é lá que se
   * responde, e ler a conversa no Telegram convida a decidir sem
   * ver o resto.
   *
   * O que a mensagem tem de fazer é uma coisa só: dizer que há
   * alguém à espera.
   */
  const linhas = [
    '💬 *New support ticket*',
    '',
    `${quem} · ${esc(chat.name || chat.email || 'no name')}`
  ];

  if (chat.ticket) {
    linhas.push('', `_${esc(chat.ticket)}_`);
  }

  return send(ALERTS, linhas.join('\n'), { silent: false });
}


/**
 * Uma conta de cliente nova.
 *
 * Para o canal de vendas: é alguém que pode vir a reservar, e o
 * número de contas por semana diz se o site está a converter.
 */
export async function telegramNewAccount(conta) {
  return send(SALES, [
    '✨ *New customer account*',
    '',
    esc(conta.full_name || conta.email || 'no name'),
    esc(conta.email || ''),

    /**
     * De onde veio, quando sabemos.
     *
     * Uma conta criada no checkout é diferente de uma criada do
     * nada — a primeira quase de certeza vai reservar.
     */
    conta.source ? '' : null,
    conta.source ? esc('via ' + conta.source) : null
  ].filter((l) => l !== null).join('\n'), { silent: false });
}


/**
 * Uma agência candidatou-se.
 *
 * Vale mais do que uma conta de cliente: uma agência aprovada traz
 * dezenas de reservas por mês.
 *
 * Esta apita. É o único registo que justifica interromper alguém.
 */
export async function telegramNewAgency(agencia) {
  const linhas = [
    '🏢 *New travel agent application*',
    '',
    `*${esc(agencia.agency_name || agencia.company_name || 'no name')}*`,
    esc(agencia.email || '')
  ];

  if (agencia.country) linhas.push(esc(agencia.country));
  if (agencia.phone) linhas.push(esc(agencia.phone));

  if (agencia.website) {
    linhas.push('', esc(agencia.website));
  }

  return send(SALES, linhas.join('\n'), { silent: false });
}


/** O trabalho de fundo parou. */
export async function telegramTickDown(minutes) {
  return send(ALERTS, [
    '🚨 *Background jobs stopped*',
    '',
    `Nothing has run for ${esc(minutes)} minutes\\.`,
    '',
    'Nobody is being alerted about waiting conversations, ' +
    'ride offers are not moving, and disputes are not being flagged\\.'
  ].join('\n'));
}


/**
 * Um teste, para confirmar que está tudo ligado.
 *
 * Chamado pela rota de diagnóstico. Manda para os dois canais, e
 * diz qual funcionou.
 */
export async function telegramTest() {
  const vendas = await send(SALES, '*Test* · sales channel is working', { silent: true });
  const alarmes = await send(ALERTS, '*Test* · alerts channel is working');

  return {
    configured: Boolean(TOKEN),
    sales: vendas,
    alerts: alarmes
  };
}
