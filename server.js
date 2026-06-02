const express = require('express');
const cors = require('cors');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);


const app = express();


app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  allowedHeaders: ['Content-Type']
}));


app.use(express.json());


app.get('/', (req, res) => {
  res.send('Backend is running');
});


app.post('/api/create-checkout-session', async (req, res) => {
  const { amount, currency, booking } = req.body;


  if (!amount || !currency || !booking) {
    return res.status(400).json({ error: 'Missing amount, currency or booking' });
  }


  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: currency.toLowerCase(),
            product_data: {
              name: `Transfer: ${booking.pickup} to ${booking.dropoff}`,
              description: `${booking.passengers} passengers, ${booking.distance}`
            },
            unit_amount: amount
          },
          quantity: 1
        }
      ],
      mode: 'payment',
      success_url: 'https://www.theepictours.com/calculator?success=true',
      cancel_url: 'https://www.theepictours.com/calculator?cancel=true',
      client_reference_id: `${booking.fullName}|${booking.email}`,
      customer_email: booking.email
    });


    res.json({ sessionId: session.id });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).json({ error: error.message });
  }
});


const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});