const express = require("express");
const {
  sequelize,
  User,
  Workspace,
  WorkspaceMember,
  Document,
} = require("../models");
const { requireAuth, requireWorkspaceRole } = require("../auth");
const { chatRateLimiter } = require("../middleware");
const { createMessage, getMessages } = require("../messages");
const { broadcastToRoom } = require("../../websocket");
const { chatRoom } = require("../rooms");
const { requireUuid } = require("./helpers");

const router = express.Router();

router.use(requireAuth);

// Every nested route addresses a workspace by UUID.
router.param("workspaceId", requireUuid("workspaceId"));

router.post("/", async (req, res) => {
  try {
    const { name } = req.body || {};
    if (!name) return res.status(400).json({ error: "name is required" });

    // Workspace and its owner membership must both exist or neither should.
    const workspace = await sequelize.transaction(async (transaction) => {
      const created = await Workspace.create({ name }, { transaction });
      await WorkspaceMember.create(
        { UserId: req.user.id, WorkspaceId: created.id, role: "owner" },
        { transaction },
      );
      return created;
    });

    res.status(201).json(workspace);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// Only the workspaces the caller belongs to.
router.get("/", async (req, res) => {
  try {
    const memberships = await WorkspaceMember.findAll({
      where: { UserId: req.user.id },
      include: [{ model: Workspace }],
    });

    res.json(
      memberships.map((m) => ({
        id: m.Workspace.id,
        name: m.Workspace.name,
        role: m.role,
      })),
    );
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/:workspaceId", requireWorkspaceRole(), async (req, res) => {
  const workspace = await Workspace.findByPk(req.params.workspaceId);
  if (!workspace) return res.status(404).json({ error: "workspace not found" });
  res.json({ ...workspace.toJSON(), role: req.membership.role });
});

router.get(
  "/:workspaceId/members",
  requireWorkspaceRole(),
  async (req, res) => {
    try {
      const members = await WorkspaceMember.findAll({
        where: { WorkspaceId: req.params.workspaceId },
        include: [{ model: User, attributes: ["id", "email", "name"] }],
      });

      res.json(
        members.map((m) => ({
          id: m.User.id,
          email: m.User.email,
          name: m.User.name,
          role: m.role,
        })),
      );
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

router.post(
  "/:workspaceId/members",
  requireWorkspaceRole("owner"),
  async (req, res) => {
    try {
      const { email, role = "editor" } = req.body || {};
      if (!email) return res.status(400).json({ error: "email is required" });
      if (!["owner", "editor", "viewer"].includes(role)) {
        return res.status(400).json({ error: "invalid role" });
      }

      const user = await User.findOne({ where: { email } });
      if (!user) return res.status(404).json({ error: "user not found" });

      const [member, created] = await WorkspaceMember.findOrCreate({
        where: { UserId: user.id, WorkspaceId: req.params.workspaceId },
        defaults: { role },
      });
      if (!created && member.role !== role) {
        await member.update({ role });
      }

      res
        .status(created ? 201 : 200)
        .json({ id: user.id, email: user.email, name: user.name, role: member.role });
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  },
);

router.get(
  "/:workspaceId/documents",
  requireWorkspaceRole(),
  async (req, res) => {
    try {
      const docs = await Document.findAll({
        where: { WorkspaceId: req.params.workspaceId },
        attributes: ["id", "title", "version", "createdById", "updatedAt"],
        order: [["updatedAt", "DESC"]],
      });
      res.json(docs);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

router.post(
  "/:workspaceId/documents",
  requireWorkspaceRole("owner", "editor"),
  async (req, res) => {
    try {
      const { title, content } = req.body || {};

      const doc = await Document.create({
        WorkspaceId: req.params.workspaceId,
        createdById: req.user.id,
        title: title || undefined,
        content: content || "",
        version: 1,
      });

      res.status(201).json(doc);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// Chat history for the workspace channel (read-through cached).
router.get(
  "/:workspaceId/messages",
  requireWorkspaceRole(),
  async (req, res) => {
    try {
      res.json(await getMessages(req.params.workspaceId));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

// REST fallback for clients not holding a socket open. Same write path as the
// CHAT_MESSAGE frame, and it still reaches connected sockets.
router.post(
  "/:workspaceId/messages",
  requireWorkspaceRole(),
  chatRateLimiter,
  async (req, res) => {
    try {
      const { content } = req.body || {};
      if (typeof content !== "string" || content.trim() === "") {
        return res
          .status(400)
          .json({ error: "content must be a non-empty string" });
      }

      const { workspaceId } = req.params;
      const message = await createMessage(
        workspaceId,
        req.user,
        content.trim(),
      );
      await broadcastToRoom(chatRoom(workspaceId), {
        type: "CHAT_MESSAGE",
        roomId: chatRoom(workspaceId),
        message,
      });

      res.status(201).json(message);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  },
);

module.exports = router;
