const path = require("path");
const Database = require("better-sqlite3");

const db = new Database(path.join(__dirname, "dropbeam.db"));

db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    name TEXT,
    email TEXT UNIQUE,
    password TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  )
`);

const createUser = (name, email, hashedPassword) => {
  const stmt = db.prepare(
    "INSERT INTO users (name, email, password) VALUES (?, ?, ?)"
  );
  const result = stmt.run(name, email, hashedPassword);
  return { id: result.lastInsertRowid, name, email };
};

const getUserByEmail = (email) => {
  const stmt = db.prepare("SELECT * FROM users WHERE email = ?");
  return stmt.get(email);
};

const getUserById = (id) => {
  const stmt = db.prepare("SELECT * FROM users WHERE id = ?");
  return stmt.get(id);
};

module.exports = { createUser, getUserByEmail, getUserById };
