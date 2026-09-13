const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { WorkspaceMember } = require("./models");

const JWT_SECRET = process.env.JWT_SECRET || "dev-only-change-me";
const TOKEN_TTL = "7d";
const SALT_ROUNDS = 10;

function hashPassword(plain) {
  return bcrypt.hash(plain, SALT_ROUNDS);
}

function comparePassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

function signToken(user) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name },
    JWT_SECRET,
    { expiresIn: TOKEN_TTL },
  );
}

function verifyToken(token) {
  try {
    return jwt.verify(token, JWT_SECRET);
  } catch {
    return null;
  }
}

// Express middleware: Authorization: Bearer <jwt> -> req.user
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ error: "Missing bearer token" });
  }

  const payload = verifyToken(token);
  if (!payload) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }

  req.user = payload;
  next();
}

// Shared by REST and the WebSocket gateway so both agree on who a user is.
function getMembership(userId, workspaceId) {
  return WorkspaceMember.findOne({
    where: { UserId: userId, WorkspaceId: workspaceId },
  });
}

// Enforces the owner|editor|viewer enum on WorkspaceMember. Call with no roles
// to mean "any member".
function requireWorkspaceRole(...roles) {
  return async (req, res, next) => {
    try {
      const workspaceId = req.params.workspaceId || req.workspaceId;
      if (!workspaceId) {
        return res.status(400).json({ error: "workspaceId is required" });
      }

      const membership = await getMembership(req.user.id, workspaceId);
      if (!membership) {
        return res.status(403).json({ error: "Not a member of this workspace" });
      }
      if (roles.length && !roles.includes(membership.role)) {
        return res
          .status(403)
          .json({ error: `Requires role: ${roles.join(" or ")}` });
      }

      req.membership = membership;
      next();
    } catch (err) {
      next(err);
    }
  };
}

// WebSocket upgrade auth: returns the user payload or null.
function authenticateSocket(token) {
  if (!token) return null;
  return verifyToken(token);
}

module.exports = {
  hashPassword,
  comparePassword,
  signToken,
  verifyToken,
  requireAuth,
  requireWorkspaceRole,
  getMembership,
  authenticateSocket,
};
