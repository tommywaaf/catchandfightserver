const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

pool.on("error", (err) => {
  console.error("Unexpected DB pool error:", err.message);
});

async function initDB() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(20) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS creature_species (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        base_hp INTEGER NOT NULL DEFAULT 500,
        base_thermal INTEGER NOT NULL,
        base_density INTEGER NOT NULL,
        base_luminosity INTEGER NOT NULL,
        base_voltage INTEGER NOT NULL,
        base_stability INTEGER NOT NULL,
        base_magnetism INTEGER NOT NULL,
        base_speed INTEGER NOT NULL,
        stat_variance INTEGER NOT NULL DEFAULT 10
      );

      CREATE TABLE IF NOT EXISTS abilities (
        id SERIAL PRIMARY KEY,
        name VARCHAR(50) NOT NULL,
        base_damage INTEGER NOT NULL DEFAULT 100,
        ability_speed INTEGER NOT NULL,
        stat1 VARCHAR(20) NOT NULL,
        stat2 VARCHAR(20),
        description TEXT
      );

      CREATE TABLE IF NOT EXISTS species_abilities (
        species_id INTEGER REFERENCES creature_species(id) ON DELETE CASCADE,
        ability_id INTEGER REFERENCES abilities(id) ON DELETE CASCADE,
        PRIMARY KEY (species_id, ability_id)
      );

      CREATE TABLE IF NOT EXISTS player_creatures (
        id SERIAL PRIMARY KEY,
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        species_id INTEGER REFERENCES creature_species(id),
        nickname VARCHAR(20),
        current_hp INTEGER NOT NULL,
        thermal INTEGER NOT NULL,
        density INTEGER NOT NULL,
        luminosity INTEGER NOT NULL,
        voltage INTEGER NOT NULL,
        stability INTEGER NOT NULL,
        magnetism INTEGER NOT NULL,
        speed INTEGER NOT NULL,
        slot_type VARCHAR(10) NOT NULL DEFAULT 'party' CHECK (slot_type IN ('party', 'storage')),
        party_position INTEGER CHECK (party_position >= 0 AND party_position <= 4),
        created_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS creature_abilities (
        creature_id INTEGER REFERENCES player_creatures(id) ON DELETE CASCADE,
        ability_id INTEGER REFERENCES abilities(id) ON DELETE CASCADE,
        slot INTEGER NOT NULL CHECK (slot >= 0 AND slot <= 3),
        PRIMARY KEY (creature_id, slot)
      );

      CREATE TABLE IF NOT EXISTS quest_progress (
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        quest_id VARCHAR(50) NOT NULL,
        progress INTEGER NOT NULL DEFAULT 0,
        completed BOOLEAN NOT NULL DEFAULT FALSE,
        PRIMARY KEY (user_id, quest_id)
      );
    `);
    console.log("Database tables initialized");
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
