/**
 * airportlink-api/emailService.js
 * ---------------------------------------------------------------
 * Envio de emails transacionais através do Resend.
 *
 * Três decisões que valem a pena explicar:
 *
 * 1. A proteção contra duplicados está na BASE DE DADOS, não aqui.
 *    O Stripe repete webhooks quando não recebe resposta rápida; um
 *    registo em memória perder-se-ia no primeiro reinício. A chave
 *    única na email_log é o que garante que ninguém recebe duas
 *    confirmações da mesma reserva.
 *
 * 2. Um email que falha NUNCA quebra o que o desencadeou. Se a
 *    confirmação não sair, a reserva continua paga e válida. Todas
 *    as funções apanham os seus próprios erros.
 *
 * 3. O fornecedor está isolado numa função. Trocar de Resend para
 *    outro é reescrever deliver(), e mais nada.
 * ---------------------------------------------------------------
 */

const RESEND_URL = 'https://api.resend.com/emails';

/**
 * O remetente.
 *
 * Aceita os dois nomes porque o servidor já usa EMAIL_FROM_BOOKINGS,
 * e esse é o melhor nome: deixa espaço para um EMAIL_FROM_PARTNERS
 * quando os motoristas tiverem os seus próprios emails, sem que os
 * dois se confundam.
 *
 * O domínio TEM de ser mail.airportlink.app — é esse que está
 * verificado no Resend. Enviar da raiz falha, porque a raiz não tem
 * os registos de autenticação.
 */
const FROM = process.env.EMAIL_FROM_BOOKINGS
  || process.env.EMAIL_FROM
  || 'Airportlink <bookings@mail.airportlink.app>';

const REPLY_TO = process.env.EMAIL_REPLY_TO || 'support@airportlink.app';
const SITE = process.env.SITE_ORIGIN || 'https://www.airportlink.app';

// Para onde vão os avisos internos: viagem sem parceiro, cobrança
// falhada em definitivo, candidatura nova.
const OPS = process.env.EMAIL_OPERATIONS || null;

/**
 * Um aviso para dentro de casa. Não tem chave de idempotência porque
 * não é para o cliente: se chegarem dois avisos de que uma viagem
 * não tem motorista, ninguém se incomoda. Perder um é que era mau.
 */
export async function notifyOps(subject, lines) {
  if (!OPS) return { sent: false, reason: 'no-ops-address' };

  try {
    const html = wrap({
      preheader: subject,
      heading: subject,
      blocks: [{ html: lines.map((l) => esc(l)).join('<br>') }]
    });

    await deliver({ to: OPS, subject: `[ops] ${subject}`, html });
    return { sent: true };
  } catch (error) {
    console.error('[email] ops notice failed:', error.message);
    return { sent: false };
  }
}

let supabase = null;

/** Chamado uma vez pelo server.js, para não haver dois clientes. */
export function initEmail(client) {
  supabase = client;
}

// ============================================================
// APRESENTAÇÃO
// ============================================================

function esc(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(amount, currency) {
  const value = Number(amount || 0);
  const code = String(currency || 'EUR').toUpperCase();
  try {
    return new Intl.NumberFormat('en-GB', { style: 'currency', currency: code }).format(value);
  } catch {
    return `${value.toFixed(2)} ${code}`;
  }
}

function longDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(`${dateStr}T12:00:00`);
  if (Number.isNaN(d.getTime())) return String(dateStr);
  return d.toLocaleDateString('en-GB', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
  });
}

function shortTime(timeStr) {
  return timeStr ? String(timeStr).slice(0, 5) : '';
}

/**
 * O invólucro de todos os emails.
 *
 * Tabelas e estilos em linha, de propósito. O Outlook ignora
 * stylesheets e trata flexbox como se não existisse — é feio de
 * escrever mas é o que aparece igual em todo o lado.
 */
function wrap({ preheader, heading, intro, blocks = [], cta, footNote }) {
  const rows = blocks.map((b) => {
    if (b.type === 'facts') {
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
        style="border-collapse:separate;border-spacing:0 8px;margin:8px 0 4px">
        ${b.items.filter((i) => i.value).map((i) => `
        <tr>
          <td style="padding:10px 14px;background:#F3F4F0;border-radius:10px 0 0 10px;
            font:600 11px/1.4 'IBM Plex Mono',monospace;letter-spacing:.08em;
            text-transform:uppercase;color:#606A7B;width:38%">${esc(i.label)}</td>
          <td style="padding:10px 14px;background:#F3F4F0;border-radius:0 10px 10px 0;
            font:500 15px/1.5 Arial,sans-serif;color:#141A28">${esc(i.value)}</td>
        </tr>`).join('')}
      </table>`;
    }

    if (b.type === 'route') {
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
        style="margin:14px 0;border:1px solid #E2E5E0;border-radius:14px">
        <tr><td style="padding:16px 18px">
          <div style="font:600 10px/1.4 'IBM Plex Mono',monospace;letter-spacing:.1em;
            text-transform:uppercase;color:#0F766E;margin-bottom:4px">Pick-up</div>
          <div style="font:500 15px/1.5 Arial,sans-serif;color:#141A28;margin-bottom:14px">${esc(b.from)}</div>
          <div style="font:600 10px/1.4 'IBM Plex Mono',monospace;letter-spacing:.1em;
            text-transform:uppercase;color:#606A7B;margin-bottom:4px">Drop-off</div>
          <div style="font:500 15px/1.5 Arial,sans-serif;color:#141A28">${esc(b.to)}</div>
        </td></tr></table>`;
    }

    if (b.type === 'note') {
      const colours = {
        ok: ['#ECFDF5', '#A7F3D0', '#065F46'],
        warn: ['#FDF6E7', '#F0D9A8', '#8A5A12'],
        bad: ['#FFF1F2', '#FDA29B', '#B42318']
      };
      const [bg, border, text] = colours[b.tone] || colours.ok;
      return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0"
        style="margin:14px 0"><tr><td style="padding:14px 16px;background:${bg};
        border:1px solid ${border};border-radius:12px;font:400 14px/1.6 Arial,sans-serif;
        color:${text}">${b.html}</td></tr></table>`;
    }

    return `<p style="margin:0 0 14px;font:400 15px/1.65 Arial,sans-serif;color:#3B4354">${b.html}</p>`;
  }).join('');

  return `<!DOCTYPE html>
<html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(heading)}</title></head>
<body style="margin:0;padding:0;background:#E8EBE7">
<div style="display:none;max-height:0;overflow:hidden;opacity:0">${esc(preheader || '')}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#E8EBE7">
<tr><td align="center" style="padding:28px 14px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
    style="max-width:560px;background:#FBFBF8;border-radius:18px;overflow:hidden">

    <tr><td style="padding:20px 26px;background:#141A28">
      <span style="font:800 18px/1 Arial,sans-serif;letter-spacing:-.5px;color:#FFFFFF">AIRPORT<span style="color:#E8A33D">LINK</span></span>
    </td></tr>

    <tr><td style="padding:28px 26px 8px">
      <h1 style="margin:0 0 12px;font:700 23px/1.2 Arial,sans-serif;
        letter-spacing:-.5px;color:#141A28">${esc(heading)}</h1>
      ${intro ? `<p style="margin:0 0 16px;font:400 15px/1.65 Arial,sans-serif;color:#3B4354">${intro}</p>` : ''}
      ${rows}
      ${cta ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:22px 0 6px">
        <tr><td style="background:#0F766E;border-radius:12px">
          <a href="${esc(cta.href)}" style="display:inline-block;padding:14px 26px;
            font:600 12px/1 'IBM Plex Mono',monospace;letter-spacing:.09em;
            text-transform:uppercase;color:#FFFFFF;text-decoration:none">${esc(cta.label)}</a>
        </td></tr></table>` : ''}
    </td></tr>

    <tr><td style="padding:18px 26px 26px">
      ${footNote ? `<p style="margin:0 0 14px;font:400 13px/1.6 Arial,sans-serif;color:#606A7B">${footNote}</p>` : ''}
      <div style="border-top:1px solid #E2E5E0;padding-top:16px;
        font:400 12px/1.7 Arial,sans-serif;color:#8A93A3">
        Questions? Reply to this email or open a chat at
        <a href="${SITE}/support" style="color:#0F766E">airportlink.app/support</a>.<br>
        Airportlink &middot; private airport transfers
      </div>
    </td></tr>

  </table>
</td></tr></table>
</body></html>`;
}

// ============================================================
// ENVIO
// ============================================================

/**
 * A única função que fala com o fornecedor. Trocar de Resend para
 * outro é reescrever isto e mais nada.
 */
async function deliver({ to, subject, html, replyTo }) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  const response = await fetch(RESEND_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      from: FROM,
      to: [to],
      subject,
      html,
      reply_to: replyTo || REPLY_TO
    })
  });

  const text = await response.text();
  let data;

  try {
    data = JSON.parse(text);
  } catch {
    throw new Error(`Resend returned a non-JSON response (HTTP ${response.status})`);
  }

  if (!response.ok) {
    throw new Error(data.message || data.error || `Resend HTTP ${response.status}`);
  }

  return data.id || null;
}

/**
 * Envia uma vez e só uma.
 *
 * A chave única na email_log é o cadeado: se já lá estiver, o insert
 * falha e desistimos. Fazer a verificação antes do insert não
 * chegaria — entre a verificação e a escrita cabe outro webhook.
 */
async function sendOnce({ key, template, to, subject, html, bookingId, replyTo }) {
  if (!to) {
    console.warn(`[email] ${template}: no recipient, skipped`);
    return { sent: false, reason: 'no-recipient' };
  }

  if (!supabase) {
    console.error('[email] initEmail was never called');
    return { sent: false, reason: 'not-initialised' };
  }

  const { data: row, error: claimError } = await supabase
    .from('email_log')
    .insert({
      idempotency_key: key,
      template,
      recipient: to,
      subject,
      booking_id: bookingId || null,
      status: 'queued'
    })
    .select('id')
    .maybeSingle();

  if (claimError) {
    // 23505 é violação de unicidade: já foi enviado. Não é um erro,
    // é exatamente o que queremos que aconteça.
    if (claimError.code === '23505') {
      console.log(`[email] ${template} already sent for ${key}`);
      return { sent: false, reason: 'duplicate' };
    }
    console.error('[email] could not claim:', claimError.message);
    return { sent: false, reason: 'claim-failed' };
  }

  try {
    const providerId = await deliver({ to, subject, html, replyTo });

    await supabase.from('email_log').update({
      status: 'sent',
      provider_id: providerId,
      sent_at: new Date().toISOString(),
      attempts: 1
    }).eq('id', row.id);

    console.log(`[email] ${template} -> ${to}`);
    return { sent: true, id: providerId };
  } catch (error) {
    await supabase.from('email_log').update({
      status: 'failed',
      error: String(error.message).slice(0, 500),
      attempts: 1
    }).eq('id', row.id);

    console.error(`[email] ${template} failed:`, error.message);
    return { sent: false, reason: 'send-failed', error: error.message };
  }
}

function reference(booking) {
  return booking.booking_reference || booking.booking_id || String(booking.id || '').slice(0, 8);
}

// ============================================================
// OS EMAILS
//
// Cada um apanha os seus próprios erros: se a confirmação não sair,
// a reserva continua paga e válida. Nunca deixar um email partir o
// que o desencadeou.
// ============================================================

/** Pago na reserva. O mais importante de todos. */
export async function sendBookingConfirmation(booking) {
  try {
    const ref = reference(booking);

    const html = wrap({
      preheader: `Your transfer on ${longDate(booking.booking_date)} is confirmed.`,
      heading: 'Your transfer is confirmed',
      intro: `Everything is booked, ${esc(booking.full_name || 'there')}. Here is what will happen.`,
      blocks: [
        { type: 'facts', items: [
          { label: 'Reference', value: ref },
          { label: 'Date', value: longDate(booking.booking_date) },
          { label: 'Pick-up time', value: shortTime(booking.booking_time) },
          { label: 'Passengers', value: booking.passengers },
          { label: 'Flight', value: booking.flight_number },
          { label: 'Paid', value: money(booking.price, booking.currency) }
        ]},
        { type: 'route', from: booking.pickup, to: booking.dropoff },
        { type: 'note', tone: 'ok', html:
          '<strong>Free cancellation until 24 hours before pick-up.</strong><br>' +
          'Cancel from your account and the full amount goes back to your card, automatically.' },
        { html: 'The day before your trip we will send you the driver&rsquo;s name, ' +
          'phone number and vehicle. If you gave us a flight number we track it, so a delay ' +
          'moves the pick-up and never the price.' }
      ],
      cta: { href: `${SITE}/myaccount`, label: 'See my trip' }
    });

    return await sendOnce({
      key: `booking_confirmed:${ref}`,
      template: 'booking_confirmed',
      to: booking.passenger_email || booking.email,
      subject: `Transfer confirmed — ${longDate(booking.booking_date)} at ${shortTime(booking.booking_time)}`,
      html,
      bookingId: booking.id
    });
  } catch (error) {
    console.error('[email] confirmation build failed:', error);
    return { sent: false, reason: 'build-failed' };
  }
}

/** Reservado sem pagar: o cartão ficou guardado. */
export async function sendCardSaved(booking, chargeAt) {
  try {
    const ref = reference(booking);
    const when = chargeAt
      ? new Date(chargeAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'long' })
      : '48 hours before pick-up';

    const html = wrap({
      preheader: `Booked. We charge ${money(booking.price, booking.currency)} on ${when}.`,
      heading: 'Your transfer is booked',
      intro: 'Nothing has been charged yet. Your card is saved securely with Stripe and we will ' +
        'take the fare shortly before you travel.',
      blocks: [
        { type: 'facts', items: [
          { label: 'Reference', value: ref },
          { label: 'Date', value: longDate(booking.booking_date) },
          { label: 'Pick-up time', value: shortTime(booking.booking_time) },
          { label: 'Passengers', value: booking.passengers },
          { label: 'To be charged', value: money(booking.price, booking.currency) },
          { label: 'Charge date', value: when }
        ]},
        { type: 'route', from: booking.pickup, to: booking.dropoff },
        { type: 'note', tone: 'warn', html:
          `<strong>We charge ${esc(money(booking.price, booking.currency))} on ${esc(when)}.</strong><br>` +
          'Cancel before then and nothing is ever taken from your card. ' +
          'Make sure the card is still valid on that date.' }
      ],
      cta: { href: `${SITE}/myaccount`, label: 'See my trip' }
    });

    return await sendOnce({
      key: `card_saved:${ref}`,
      template: 'card_saved',
      to: booking.passenger_email || booking.email,
      subject: `Transfer booked — payment on ${when}`,
      html,
      bookingId: booking.id
    });
  } catch (error) {
    console.error('[email] card saved build failed:', error);
    return { sent: false, reason: 'build-failed' };
  }
}

/** A cobrança agendada correu bem. */
export async function sendChargeSucceeded(booking) {
  try {
    const ref = reference(booking);

    const html = wrap({
      preheader: `We have taken ${money(booking.price, booking.currency)} for your transfer.`,
      heading: 'Payment received',
      intro: 'Your transfer is fully paid and confirmed.',
      blocks: [
        { type: 'facts', items: [
          { label: 'Reference', value: ref },
          { label: 'Charged', value: money(booking.price, booking.currency) },
          { label: 'Date', value: longDate(booking.booking_date) },
          { label: 'Pick-up time', value: shortTime(booking.booking_time) }
        ]},
        { type: 'route', from: booking.pickup, to: booking.dropoff },
        { html: 'We will send the driver&rsquo;s details the day before you travel.' }
      ],
      cta: { href: `${SITE}/myaccount`, label: 'See my trip' }
    });

    return await sendOnce({
      key: `charge_succeeded:${ref}`,
      template: 'charge_succeeded',
      to: booking.passenger_email || booking.email,
      subject: `Payment received — transfer on ${longDate(booking.booking_date)}`,
      html,
      bookingId: booking.id
    });
  } catch (error) {
    console.error('[email] charge success build failed:', error);
    return { sent: false, reason: 'build-failed' };
  }
}

/**
 * A cobrança falhou. A chave inclui o número da tentativa: cada uma
 * é um email novo, senão a segunda e a terceira ficavam em silêncio.
 */
export async function sendChargeFailed(booking, { attempt, willRetry }) {
  try {
    const ref = reference(booking);

    const html = wrap({
      preheader: 'We could not take payment for your transfer.',
      heading: 'We could not take your payment',
      intro: `Your card was declined for the transfer on ${longDate(booking.booking_date)}.`,
      blocks: [
        { type: 'facts', items: [
          { label: 'Reference', value: ref },
          { label: 'Amount', value: money(booking.price, booking.currency) },
          { label: 'Date', value: longDate(booking.booking_date) },
          { label: 'Pick-up time', value: shortTime(booking.booking_time) }
        ]},
        { type: 'note', tone: willRetry ? 'warn' : 'bad', html: willRetry
          ? '<strong>We will try again in a few hours.</strong><br>' +
            'Check that the card is still valid and has funds available. If it will not work, ' +
            'reply to this email and we will send you a payment link.'
          : '<strong>This was our last attempt, so the booking has been cancelled.</strong><br>' +
            'No money was taken. If you still need the transfer, please book again ' +
            'or reply to this email.' },
        { html: willRetry
          ? 'Your booking is still held for now.'
          : 'We are sorry to do this, but we cannot send a driver to a trip that has not been paid.' }
      ],
      cta: { href: `${SITE}/myaccount`, label: willRetry ? 'Check my booking' : 'Book again' }
    });

    return await sendOnce({
      key: `charge_failed:${ref}:${attempt}`,
      template: 'charge_failed',
      to: booking.passenger_email || booking.email,
      subject: willRetry
        ? 'Payment problem with your transfer'
        : 'Your transfer has been cancelled — payment failed',
      html,
      bookingId: booking.id
    });
  } catch (error) {
    console.error('[email] charge failed build failed:', error);
    return { sent: false, reason: 'build-failed' };
  }
}

/** Cancelamento, com ou sem reembolso. */
export async function sendCancellation(booking, { refunded, amount }) {
  try {
    const ref = reference(booking);

    const html = wrap({
      preheader: 'Your transfer has been cancelled.',
      heading: 'Your transfer is cancelled',
      intro: `The transfer on ${longDate(booking.booking_date)} has been cancelled as you asked.`,
      blocks: [
        { type: 'facts', items: [
          { label: 'Reference', value: ref },
          { label: 'Was booked for', value: longDate(booking.booking_date) },
          { label: 'Pick-up time', value: shortTime(booking.booking_time) }
        ]},
        { type: 'note', tone: 'ok', html: refunded
          ? `<strong>${esc(money(amount, booking.currency))} is on its way back to your card.</strong><br>` +
            'We have issued the refund. Your bank usually takes 5 to 10 working days to show it.'
          : '<strong>Nothing was charged.</strong><br>' +
            'Your card was saved but never used, and we have now removed it.' },
        { html: 'If you need another transfer, we are here.' }
      ],
      cta: { href: `${SITE}/#book`, label: 'Book another transfer' }
    });

    return await sendOnce({
      key: `cancelled:${ref}`,
      template: 'cancelled',
      to: booking.passenger_email || booking.email,
      subject: `Transfer cancelled — ${ref}`,
      html,
      bookingId: booking.id
    });
  } catch (error) {
    console.error('[email] cancellation build failed:', error);
    return { sent: false, reason: 'build-failed' };
  }
}
