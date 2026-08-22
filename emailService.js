import { Resend } from 'resend';

const resend = new Resend(process.env.RESEND_API_KEY);

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatMoney(amountMinor, currency) {
  const amount = Number(amountMinor || 0) / 100;
  const code = String(currency || 'EUR').toUpperCase();

  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency: code
    }).format(amount);
  } catch {
    return `${amount.toFixed(2)} ${code}`;
  }
}

function formatBookingDateTime(date, time) {
  if (!date) return 'To be confirmed';

  const raw = `${date}T${time || '00:00'}`;
  const value = new Date(raw);

  if (Number.isNaN(value.getTime())) {
    return time ? `${date} at ${time}` : date;
  }

  return new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: 'Europe/Lisbon'
  }).format(value);
}

function bookingReference(booking) {
  const stripeSessionId = String(booking.stripe_checkout_session_id || '');

  if (stripeSessionId) {
    return stripeSessionId.slice(-10).toUpperCase();
  }

  return String(booking.id || 'PENDING').slice(-10).toUpperCase();
}

function buildBookingConfirmationEmail(booking) {
  const name = escapeHtml(booking.full_name || 'Customer');
  const reference = escapeHtml(bookingReference(booking));
  const pickup = escapeHtml(booking.pickup || 'To be confirmed');
  const dropoff = escapeHtml(booking.dropoff || 'To be confirmed');
  const dateTime = escapeHtml(
    formatBookingDateTime(booking.booking_date, booking.booking_time)
  );
  const passengers = escapeHtml(booking.passengers || '—');
  const payment = escapeHtml(
    formatMoney(booking.amount_total, booking.currency)
  );

  const flightNumber = booking.flight_number
    ? escapeHtml(booking.flight_number)
    : '';

  const appUrl = process.env.SITE_ORIGIN || 'https://www.airportlink.app';
  const myAccountUrl = `${appUrl}/myaccount`;
  const supportUrl = `${appUrl}/support`;

  const flightRow = flightNumber
    ? `
      <tr>
        <td style="padding:8px 0;color:#6b7280;">Flight number</td>
        <td style="padding:8px 0;text-align:right;font-weight:600;color:#111827;">${flightNumber}</td>
      </tr>
    `
    : '';

  const html = `
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Booking confirmed</title>
</head>
<body style="margin:0;padding:0;background:#E8EBE7;font-family:Arial,Helvetica,sans-serif;color:#111827;">
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;background:#E8EBE7;padding:32px 16px;">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="max-width:640px;background:#ffffff;border-radius:20px;overflow:hidden;">
          <tr>
            <td style="background:#333B50;padding:28px 32px;">
              <div style="font-size:24px;line-height:1.2;font-weight:700;color:#ffffff;">Airportlink</div>
              <div style="margin-top:6px;font-size:14px;color:#E8EBE7;">Private airport transfers</div>
            </td>
          </tr>

          <tr>
            <td style="padding:32px;">
              <div style="width:52px;height:52px;line-height:52px;text-align:center;background:#ecfdf5;color:#047857;border-radius:50%;font-size:28px;font-weight:700;">✓</div>

              <h1 style="margin:20px 0 10px;font-size:28px;line-height:1.2;color:#333B50;">Your booking is confirmed</h1>

              <p style="margin:0 0 22px;font-size:16px;line-height:1.6;color:#4b5563;">
                Hi ${name}, thank you for choosing Airportlink. Your payment was successful and your transfer is confirmed.
              </p>

              <div style="margin:0 0 22px;padding:16px 18px;background:#f5f7f5;border-left:4px solid #333B50;border-radius:8px;">
                <div style="font-size:12px;color:#6b7280;text-transform:uppercase;letter-spacing:.08em;">Booking reference</div>
                <div style="margin-top:5px;font-size:18px;font-weight:700;color:#333B50;">${reference}</div>
              </div>

              <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="width:100%;border-top:1px solid #e5e7eb;border-bottom:1px solid #e5e7eb;">
                <tr>
                  <td style="padding:14px 0;color:#6b7280;">Pick-up</td>
                  <td style="padding:14px 0;text-align:right;font-weight:600;color:#111827;">${pickup}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#6b7280;">Destination</td>
                  <td style="padding:8px 0;text-align:right;font-weight:600;color:#111827;">${dropoff}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#6b7280;">Date and time</td>
                  <td style="padding:8px 0;text-align:right;font-weight:600;color:#111827;">${dateTime}</td>
                </tr>
                <tr>
                  <td style="padding:8px 0;color:#6b7280;">Passengers</td>
                  <td style="padding:8px 0;text-align:right;font-weight:600;color:#111827;">${passengers}</td>
                </tr>
                ${flightRow}
                <tr>
                  <td style="padding:14px 0;color:#6b7280;">Paid</td>
                  <td style="padding:14px 0;text-align:right;font-size:18px;font-weight:700;color:#333B50;">${payment}</td>
                </tr>
              </table>

              <p style="margin:24px 0 0;font-size:15px;line-height:1.6;color:#4b5563;">
                Please review your transfer details. You can manage your booking from your Airportlink account.
              </p>

              <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin-top:24px;">
                <tr>
                  <td style="background:#333B50;border-radius:8px;">
                    <a href="${myAccountUrl}" style="display:inline-block;padding:13px 20px;font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;">
                      View my booking
                    </a>
                  </td>
                </tr>
              </table>

              <p style="margin:24px 0 0;font-size:14px;line-height:1.6;color:#6b7280;">
                Need help? Visit <a href="${supportUrl}" style="color:#333B50;font-weight:700;text-decoration:none;">Airportlink Support</a>.
              </p>
            </td>
          </tr>

          <tr>
            <td style="padding:20px 32px;background:#f5f7f5;font-size:12px;line-height:1.5;color:#6b7280;">
              This is a transactional email regarding your Airportlink booking. Please keep this email for your records.
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`.trim();

  const text = [
    'Airportlink — Booking confirmed',
    '',
    `Hi ${booking.full_name || 'Customer'},`,
    'Your payment was successful and your transfer is confirmed.',
    '',
    `Booking reference: ${bookingReference(booking)}`,
    `Pick-up: ${booking.pickup || 'To be confirmed'}`,
    `Destination: ${booking.dropoff || 'To be confirmed'}`,
    `Date and time: ${formatBookingDateTime(booking.booking_date, booking.booking_time)}`,
    `Passengers: ${booking.passengers || '—'}`,
    booking.flight_number ? `Flight number: ${booking.flight_number}` : null,
    `Paid: ${formatMoney(booking.amount_total, booking.currency)}`,
    '',
    `Manage your booking: ${myAccountUrl}`,
    `Support: ${supportUrl}`
  ].filter(Boolean).join('\n');

  return {
    subject: `Booking confirmed — ${reference}`,
    html,
    text
  };
}

export async function sendBookingConfirmation({ to, booking }) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY is not configured');
  }

  if (!process.env.EMAIL_FROM_BOOKINGS) {
    throw new Error('EMAIL_FROM_BOOKINGS is not configured');
  }

  if (!to) {
    throw new Error('Booking recipient email is missing');
  }

  const { subject, html, text } = buildBookingConfirmationEmail(booking);

  const { data, error } = await resend.emails.send({
    from: process.env.EMAIL_FROM_BOOKINGS,
    to: [to],
    subject,
    html,
    text,
    tags: [
      { name: 'type', value: 'booking-confirmation' },
      {
        name: 'booking-id',
        value: String(booking.id || booking.stripe_checkout_session_id || 'unknown')
      }
    ]
  });

  if (error) {
    throw new Error(`Resend failed: ${error.message}`);
  }

  return data;
}
