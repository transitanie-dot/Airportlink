import express from "express";
import cors from "cors";
import Stripe from "stripe";
import { createClient } from "@supabase/supabase-js";

const app = express();

app.use(cors({
  origin: "*",
  methods: ["POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"]
}));

app.use(express.json());

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
  apiVersion: "2024-06-20",
});

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const cleanNumber = (value) => {
  if (!value) return null;
  const match = String(value).replace(",", ".").match(/[\d.]+/);
  return match ? Number(match[0]) : null;
};

const cleanInt = (value) => {
  const n = cleanNumber(value);
  return n === null ? null : Math.trunc(n);
};

app.post("/api/confirm-payment", async (req, res) => {
  try {
    const { session_id } = req.body;

    if (!session_id || !session_id.startsWith("cs_")) {
      return res.status(400).json({ error: "Invalid session_id" });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== "paid") {
      return res.status(200).json({
        payment_status: session.payment_status,
        booking_saved: false,
      });
    }

    const metadata = session.metadata || {};

    const payload = {
      user_id: metadata.user_id || null,
      pickup: metadata.pickup || null,
      dropoff: metadata.dropoff || null,
      booking_date: metadata.booking_date || null,
      passengers: Number(metadata.passengers || 1),
      price: cleanNumber(metadata.price),
      distance_km: cleanNumber(metadata.distance_km),
      duration_minutes: cleanInt(metadata.duration_minutes),
      status: metadata.status || "paid",
      stripe_checkout_session_id: session.id,
      stripe_payment_intent_id:
        typeof session.payment_intent === "string"
          ? session.payment_intent
          : null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };

    const { error } = await supabase
      .from("bookings")
      .upsert(payload, { onConflict: "stripe_checkout_session_id" });

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    return res.status(200).json({
      payment_status: session.payment_status,
      booking_saved: true,
    });
  } catch (error) {
    return res.status(500).json({
      error: error?.message || "Failed to confirm payment",
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
