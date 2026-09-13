const { Sequelize } = require("sequelize");
require("dotenv").config();

// Connect using environment variables or a fallback connection string
const sequelize = new Sequelize(
  process.env.DATABASE_URL ||
    "postgres://postgres:postgres123@localhost:5432/chat_app",
  {
    dialect: "postgres",
    logging: false, // Set to console.log to see the generated raw SQL queries in terminal
  },
);

module.exports = sequelize;
