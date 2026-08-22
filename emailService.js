const { Resend } = require('resend');

const resend = new Resend(process.env.RESEND_API_KEY);

async function sendBookingConfirmation({ to, booking }) {
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY não está configurada.');
  }

  if (!process.env.EMAIL_FROM_BOOKINGS) {
    throw new Error('EMAIL_FROM_BOOKINGS não está configurada.');
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
      { name: 'booking_id', value: String(booking.id) }
    ]
  });

  if (error) {
    throw new Error(`Falha Resend: ${error.message}`);
  }

  return data;
}

module.exports = {
  sendBookingConfirmation
};
