const express = require("express");
const { sequelize, Document } = require("../models");
const { requireAuth, requireWorkspaceRole } = require("../auth");
const { broadcastToRoom } = require("../../websocket");
const { docRoom } = require("../rooms");
const { requireUuid } = require("./helpers");

const router = express.Router();

router.use(requireAuth);
router.param("id", requireUuid("id"));

// The workspace isn't in the path here, so load the document first and let
// requireWorkspaceRole read the id off req.workspaceId.
async function loadDocument(req, res, next) {
  try {
    const doc = await Document.findByPk(req.params.id);
    if (!doc) return res.status(404).json({ error: "Document not found" });

    req.document = doc;
    req.workspaceId = doc.WorkspaceId;
    next();
  } catch (err) {
    next(err);
  }
}

router.get("/:id", loadDocument, requireWorkspaceRole(), (req, res) => {
  res.json(req.document);
});

router.put(
  "/:id",
  loadDocument,
  requireWorkspaceRole("owner", "editor"),
  async (req, res) => {
    try {
      const { id } = req.params;
      const { content, title, version } = req.body || {};

      if (!Number.isInteger(version)) {
        return res
          .status(400)
          .json({ error: "version (int) is required for optimistic locking" });
      }

      const fields = { version: sequelize.literal('"version" + 1') };
      if (typeof content === "string") fields.content = content;
      if (typeof title === "string") fields.title = title;

      // Same optimistic-concurrency contract as the DOCUMENT_UPDATE frame:
      // the write lands only if the caller's version is still current.
      const [updatedRowsCount] = await Document.update(fields, {
        where: { id, version },
      });

      const currentDoc = await Document.findByPk(id);

      if (updatedRowsCount === 0) {
        return res.status(409).json({
          error: "CONFLICT_DETECTED",
          message:
            "The document was modified by another user. Please pull latest changes and retry.",
          currentVersion: currentDoc ? currentDoc.version : null,
        });
      }

      // Keep open sockets in sync with edits that arrived over HTTP.
      await broadcastToRoom(docRoom(id), {
        type: "DOCUMENT_UPDATED",
        documentId: id,
        content: currentDoc.content,
        version: currentDoc.version,
        updatedBy: req.user.id,
      });

      res.json(currentDoc);
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: err.message });
    }
  },
);

router.delete(
  "/:id",
  loadDocument,
  requireWorkspaceRole("owner", "editor"),
  async (req, res) => {
    try {
      await req.document.destroy();
      res.status(204).end();
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  },
);

module.exports = router;
