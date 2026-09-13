const express = require("express");
const { User } = require("../models");
const {
  hashPassword,
  comparePassword,
  signToken,
  requireAuth,
} = require("../auth");

const router = express.Router();

const publicUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
});

router.post("/register", async (req, res) => {
  try {
    // Fields are picked explicitly; req.body is never handed to create().
    const { email, name, password } = req.body || {};

    if (!email || !name || !password) {
      return res
        .status(400)
        .json({ error: "email, name and password are required" });
    }
    if (String(password).length < 8) {
      return res
        .status(400)
        .json({ error: "password must be at least 8 characters" });
    }
    if (await User.findOne({ where: { email } })) {
      return res.status(409).json({ error: "email already registered" });
    }

    const user = await User.create({
      email,
      name,
      password: await hashPassword(String(password)),
    });

    res.status(201).json({ user: publicUser(user), token: signToken(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to register" });
  }
});

router.post("/login", async (req, res) => {
  try {
    const { email, password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: "email and password are required" });
    }

    const user = await User.scope("withPassword").findOne({ where: { email } });
    if (!user || !(await comparePassword(String(password), user.password))) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    res.json({ user: publicUser(user), token: signToken(user) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to log in" });
  }
});

router.get("/me", requireAuth, async (req, res) => {
  const user = await User.findByPk(req.user.id);
  if (!user) return res.status(404).json({ error: "user not found" });
  res.json(publicUser(user));
});

module.exports = router;
