const bcrypt = require("bcrypt");
const jwt = require("jsonwebtoken");
const { pool } = require("./db");

const JWT_SECRET = process.env.JWT_SECRET || "catchandfight-dev-secret";
const SALT_ROUNDS = 10;

class AuthManager {
  async register(username, password) {
    if (!username || !password) {
      return { success: false, error: "Username and password required" };
    }
    username = username.trim().substring(0, 20);
    if (username.length < 3) {
      return { success: false, error: "Username must be at least 3 characters" };
    }
    if (password.length < 4) {
      return { success: false, error: "Password must be at least 4 characters" };
    }

    try {
      const hash = await bcrypt.hash(password, SALT_ROUNDS);
      const result = await pool.query(
        "INSERT INTO users (username, password_hash) VALUES ($1, $2) RETURNING id, username",
        [username, hash]
      );
      const user = result.rows[0];
      const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: "7d" });

      await pool.query(
        "INSERT INTO quest_progress (user_id, quest_id, progress, completed) VALUES ($1, $2, 0, FALSE)",
        [user.id, "catch_10"]
      );

      return { success: true, token, userId: user.id, username: user.username };
    } catch (err) {
      if (err.code === "23505") {
        return { success: false, error: "Username already taken" };
      }
      console.error("Register error:", err.message);
      return { success: false, error: "Registration failed" };
    }
  }

  async login(username, password) {
    if (!username || !password) {
      return { success: false, error: "Username and password required" };
    }

    try {
      const result = await pool.query("SELECT id, username, password_hash FROM users WHERE username = $1", [username]);
      if (result.rows.length === 0) {
        return { success: false, error: "Invalid username or password" };
      }

      const user = result.rows[0];
      const valid = await bcrypt.compare(password, user.password_hash);
      if (!valid) {
        return { success: false, error: "Invalid username or password" };
      }

      const token = jwt.sign({ userId: user.id, username: user.username }, JWT_SECRET, { expiresIn: "7d" });
      return { success: true, token, userId: user.id, username: user.username };
    } catch (err) {
      console.error("Login error:", err.message);
      return { success: false, error: "Login failed" };
    }
  }

  verifyToken(token) {
    try {
      return jwt.verify(token, JWT_SECRET);
    } catch {
      return null;
    }
  }
}

module.exports = new AuthManager();
