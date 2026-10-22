// ---------------------------------------------------------------------------
// MongoDB Connection Manager, Collection Accessors & Index Initializer
// ---------------------------------------------------------------------------
const { MongoClient } = require("mongodb");
const path = require("path");
const fs = require("fs");

const MONGODB_URI = process.env.MONGODB_URI || "mongodb+srv://yadessasisay050_db_user:DMNTi2xDIXF4m2k3@cluster0.alngtmf.mongodb.net/";
const DB_NAME = process.env.DB_NAME || "restaurant_ordering";

let client = null;
let db = null;

async function connectDB() {
  if (db) return db;

  try {
    client = new MongoClient(MONGODB_URI, {
      maxPoolSize: 50,
      minPoolSize: 5,
      serverSelectionTimeoutMS: 5000,
      connectTimeoutMS: 10000,
    });

    await client.connect();
    db = client.db(DB_NAME);
    console.log(`[MongoDB] Connected successfully to database: '${DB_NAME}'`);

    await createDatabaseIndexes(db);
    return db;
  } catch (err) {
    console.error(`[MongoDB Connection Error] Failed to connect to '${MONGODB_URI}':`, err.message);
    throw err;
  }
}

function getDB() {
  if (!db) {
    throw new Error("Database not initialized. Please call connectDB() first.");
  }
  return db;
}

function getCollections() {
  const database = getDB();
  return {
    users: database.collection("users"),
    menuItems: database.collection("menu_items"),
    tables: database.collection("tables"),
    orders: database.collection("orders"),
    sessions: database.collection("sessions"),
    dailyCounters: database.collection("daily_counters"),
    auditLogs: database.collection("audit_logs"),
  };
}

// Ensure high-performance indexes on startup
async function createDatabaseIndexes(database) {
  try {
    const { users, menuItems, orders, sessions, dailyCounters, auditLogs } = {
      users: database.collection("users"),
      menuItems: database.collection("menu_items"),
      orders: database.collection("orders"),
      sessions: database.collection("sessions"),
      dailyCounters: database.collection("daily_counters"),
      auditLogs: database.collection("audit_logs"),
    };

    await users.createIndex({ username: 1 }, { unique: true });
    await dailyCounters.createIndex({ dateKey: 1 }, { unique: true });
    await sessions.createIndex({ sessionId: 1 }, { unique: true });

    // Orders indexes for Live Board, History & Date queries
    await orders.createIndex({ dateKey: 1, dailySeq: 1 });
    await orders.createIndex({ dateKey: 1, status: 1 });
    await orders.createIndex({ tableNumber: 1 });
    await orders.createIndex({ createdAt: -1 });

    // Menu indexes
    await menuItems.createIndex({ category: 1, available: 1 });

    // Audit logs index
    await auditLogs.createIndex({ iso: -1 });
    
    console.log("[MongoDB] Performance and unique indexes verified.");
  } catch (err) {
    console.warn("[MongoDB Index Warning]", err.message);
  }
}

async function closeDB() {
  if (client) {
    await client.close();
    client = null;
    db = null;
    console.log("[MongoDB] Connection closed gracefully.");
  }
}

module.exports = {
  connectDB,
  getDB,
  getCollections,
  closeDB,
};
