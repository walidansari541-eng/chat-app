const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// router.param guard: reject a malformed id before it reaches Postgres, which
// would otherwise raise a cast error as a 500.
function requireUuid(name) {
  return (req, res, next, value) => {
    if (!UUID_RE.test(value)) {
      return res.status(400).json({ error: `${name} must be a UUID` });
    }
    next();
  };
}

module.exports = { UUID_RE, requireUuid };
