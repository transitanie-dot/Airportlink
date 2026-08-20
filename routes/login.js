import express from 'express';
import supabase from '../supabaseClient.js';

const router = express.Router();

router.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({
        success: false,
        error: "Email and password required"
      });
    }

    const { data, error } = await supabase.auth.signInWithPassword({
      email,
      password
    });

    if (error || !data?.session) {
      return res.status(401).json({
        success: false,
        error: error?.message || "Invalid credentials"
      });
    }

    res.json({
      success: true,
      email: data.user?.email || email
    });

  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({
      success: false,
      error: "An error occurred"
    });
  }
});

export default router;
