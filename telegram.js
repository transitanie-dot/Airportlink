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
export async function telegramNewBooking(booking, assignment) {
  const linhas = [
    '*New booking*',
    '',
    `${esc(booking.pickup)} → ${esc(booking.dropoff)}`,
    `${esc(booking.booking_date)} at ${esc(booking.booking_time)}`,
    `${esc(booking.passengers)} passenger${booking.passengers === 1 ? '' : 's'}` +
      ` · ${esc(Number(booking.amount_total || 0).toFixed(2))} ` +
      esc(String(booking.currency || 'EUR').toUpperCase()),
    ''
  ];

  /**
   * A quem foi oferecida, se a cascata já correu.
   *
   * É a informação que diz se há problema. "Offered to X" é
   * normal; "nobody in the zone" é o que interessa ver.
   */
  if (assignment?.partner) {
    linhas.push(`Offered to ${esc(assignment.partner)}`);
  } else if (assignment?.stage === 'open') {
    linhas.push('⚠️ *Nobody in the zone* — on the open board');
  }

  linhas.push('', `\`${esc(booking.booking_reference || booking.id)}\``);

  return send(SALES, linhas.join('\n'), { silent: true });
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

  const linhas = [`*${esc(s.date)}*`, ''];

  // ---------- o que entrou ----------
  if (s.new_bookings > 0) {
    linhas.push(
      `📥 *${esc(s.new_bookings)} new booking${s.new_bookings === 1 ? '' : 's'}* ` +
      `· ${esc(Number(s.revenue || 0).toFixed(2))} EUR`
    );
  } else {
    linhas.push('📥 No bookings today');
  }

  // ---------- o que se fez ----------
  if (s.trips_today > 0) {
    linhas.push('');
    linhas.push(`🚗 *${esc(s.trips_today)} transfer${s.trips_today === 1 ? '' : 's'} today*`);

    const partes = [];
    if (s.completed) partes.push(`${s.completed} completed`);
    if (s.cancelled) partes.push(`${s.cancelled} cancelled`);
    if (s.no_driver) partes.push(`${s.no_driver} with no driver`);

    if (partes.length) linhas.push(`   ${esc(partes.join(' · '))}`);

    /**
     * O custo dos táxis, quando houve.
     *
     * É a margem que se perdeu por não ter cobertura, e o número
     * que diz onde recrutar — melhor do que qualquer previsão,
     * porque é dinheiro que já saiu.
     */
    if (s.used_taxi > 0) {
      linhas.push(
        `   💸 ${esc(s.used_taxi)} needed a taxi · ` +
        `${esc(Number(s.taxi_cost || 0).toFixed(2))} EUR out of pocket`
      );
    }
  }

  // ---------- amanhã ----------
  if (s.tomorrow_total > 0) {
    linhas.push('');
    linhas.push(
      `📅 Tomorrow: ${esc(s.tomorrow_total)} transfer` +
      `${s.tomorrow_total === 1 ? '' : 's'}` +
      (s.tomorrow_without_driver > 0
        ? `, *${esc(s.tomorrow_without_driver)} still without a driver*`
        : ', all covered')
    );
  }

  return send(SALES, linhas.join('\n'), {
    silent: !(s.tomorrow_without_driver > 0)
  });
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
  ].join('\n'), { silent: true });
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
