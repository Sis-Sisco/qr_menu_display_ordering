
const app = require("../server/server");
const { connectDB } = require("../server/db");

let connectionPromise;

module.exports = async (req, res) => {
  try {
    if (!connectionPromise) {
      connectionPromise = connectDB().catch((error) => {
        connectionPromise = null;
        throw error;
      });
    }

    await connectionPromise;
    return app(req, res);
  } catch (error) {
    console.error("API initialization failed:", error);
    return res.status(500).json({
      error: "Database connection failed"
    });
  }
};
