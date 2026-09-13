const { DataTypes } = require("sequelize");
const sequelize = require("./db");

// 1. User Model
const User = sequelize.define(
  "User",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    email: { type: DataTypes.STRING, allowNull: false, unique: true },
    name: { type: DataTypes.STRING, allowNull: false },
    password: { type: DataTypes.STRING, allowNull: false },
  },
  {
    // The password hash must never reach a response body. Login reads it back
    // explicitly via User.scope("withPassword").
    defaultScope: { attributes: { exclude: ["password"] } },
    scopes: { withPassword: { attributes: {} } },
  },
);

// 2. Workspace Model
const Workspace = sequelize.define("Workspace", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  name: { type: DataTypes.STRING, allowNull: false },
});

// 3. Workspace Membership Model (Junction Table for Permissions)
const WorkspaceMember = sequelize.define("WorkspaceMember", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  role: {
    type: DataTypes.ENUM("owner", "editor", "viewer"),
    allowNull: false,
    defaultValue: "editor",
  },
});

// 4. Document Model
const Document = sequelize.define("Document", {
  id: {
    type: DataTypes.UUID,
    defaultValue: DataTypes.UUIDV4,
    primaryKey: true,
  },
  title: { type: DataTypes.STRING, defaultValue: "Untitled Document" },
  content: { type: DataTypes.TEXT, defaultValue: "" },
  version: { type: DataTypes.INTEGER, defaultValue: 1, allowNull: false },
});

// 5. Chat Message Model (one chat channel per workspace)
const Message = sequelize.define(
  "Message",
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    content: { type: DataTypes.TEXT, allowNull: false },
  },
  {
    indexes: [{ fields: ["WorkspaceId", "createdAt"] }],
  },
);

// Relationships
User.hasMany(WorkspaceMember);
WorkspaceMember.belongsTo(User);

Workspace.hasMany(WorkspaceMember);
WorkspaceMember.belongsTo(Workspace);

Workspace.hasMany(Document, { onDelete: "CASCADE" });
Document.belongsTo(Workspace);

User.hasMany(Document, { foreignKey: "createdById" });
Document.belongsTo(User, { foreignKey: "createdById" });

Workspace.hasMany(Message, { onDelete: "CASCADE" });
Message.belongsTo(Workspace);

User.hasMany(Message);
Message.belongsTo(User);

module.exports = {
  sequelize,
  User,
  Workspace,
  WorkspaceMember,
  Document,
  Message,
};
