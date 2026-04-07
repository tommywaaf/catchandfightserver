try {
  require("dotenv").config();
} catch {
  /* optional; run: npm install dotenv — or set DATABASE_URL in the shell */
}

const { Pool } = require("pg");

if (!process.env.DATABASE_URL) {
  console.error(
    "DATABASE_URL is not set.\n" +
      "  • Create a .env file in this folder with: DATABASE_URL=postgresql://...\n" +
      '  • Or in PowerShell: $env:DATABASE_URL="postgresql://..."\n' +
      "See .env.example."
  );
  process.exit(1);
}

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
        base_speed INTEGER NOT NULL DEFAULT 40,
        primary_min INTEGER NOT NULL DEFAULT 1,
        nonprimary_max INTEGER NOT NULL DEFAULT 20,
        primary_stat1 VARCHAR(20),
        primary_side1 VARCHAR(10),
        primary_stat2 VARCHAR(20),
        primary_side2 VARCHAR(10),
        find_weight INTEGER NOT NULL DEFAULT 1,
        grass_unlock_tier INTEGER NOT NULL DEFAULT 0
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

      CREATE TABLE IF NOT EXISTS user_species_discovery (
        user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
        species_id INTEGER REFERENCES creature_species(id) ON DELETE CASCADE,
        discovered_at TIMESTAMP DEFAULT NOW(),
        PRIMARY KEY (user_id, species_id)
      );

      CREATE TABLE IF NOT EXISTS user_grass_progress (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        unlock_tier INTEGER NOT NULL DEFAULT 0
      );
    `);

    await client.query(`
      ALTER TABLE users ADD COLUMN IF NOT EXISTS elo INTEGER NOT NULL DEFAULT 1500;
    `);
    await client.query(`
      ALTER TABLE creature_species ADD COLUMN IF NOT EXISTS primary_stat1 VARCHAR(20);
      ALTER TABLE creature_species ADD COLUMN IF NOT EXISTS primary_side1 VARCHAR(10);
      ALTER TABLE creature_species ADD COLUMN IF NOT EXISTS primary_stat2 VARCHAR(20);
      ALTER TABLE creature_species ADD COLUMN IF NOT EXISTS primary_side2 VARCHAR(10);
      ALTER TABLE creature_species ADD COLUMN IF NOT EXISTS find_weight INTEGER NOT NULL DEFAULT 1;
      ALTER TABLE creature_species ADD COLUMN IF NOT EXISTS grass_unlock_tier INTEGER NOT NULL DEFAULT 0;
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        id VARCHAR(64) PRIMARY KEY,
        applied_at TIMESTAMP DEFAULT NOW()
      );
    `);
    const mig = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", ["reset_grass_quests_v1"]);
    if (mig.rows.length === 0) {
      await client.query("DELETE FROM quest_progress");
      await client.query("UPDATE user_grass_progress SET unlock_tier = 0");
      await client.query("INSERT INTO schema_migrations (id) VALUES ('reset_grass_quests_v1')");
      console.log("Applied one-time migration: cleared quest_progress, reset grass unlock_tier for all users");
    }

    const mig2 = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", ["reset_pool_quests_v1"]);
    if (mig2.rows.length === 0) {
      await client.query("DELETE FROM quest_progress");
      await client.query("UPDATE user_grass_progress SET unlock_tier = 0");
      await client.query("INSERT INTO schema_migrations (id) VALUES ('reset_pool_quests_v1')");
      console.log("Applied migration reset_pool_quests_v1: mixed quest chain (catch/battle objectives)");
    }

    const mv = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", ["quest_chain_perfect_veil_v1"]);
    if (mv.rows.length === 0) {
      await client.query(
        "UPDATE quest_progress SET quest_id = 'mix_perfect_primary', progress = 0 WHERE quest_id = 'mix_dual_primary' AND completed = FALSE"
      );
      await client.query("UPDATE quest_progress SET quest_id = 'mix_perfect_primary' WHERE quest_id = 'mix_dual_primary' AND completed = TRUE");
      await client.query(
        "UPDATE quest_progress SET quest_id = 'mix_battle_5', progress = 0 WHERE quest_id = 'mix_catch_12' AND completed = FALSE"
      );
      await client.query(
        "UPDATE quest_progress SET quest_id = 'mix_battle_5', progress = 5, completed = TRUE WHERE quest_id = 'mix_catch_12' AND completed = TRUE"
      );
      await client.query("INSERT INTO schema_migrations (id) VALUES ('quest_chain_perfect_veil_v1')");
      console.log("Applied quest_chain_perfect_veil_v1: perfect-primary step, win-5 finale");
    }

    const ev = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", ["rare_grass_twinkl_cleanup_v1"]);
    if (ev.rows.length === 0) {
      const vid = await client.query("SELECT id FROM creature_species WHERE name = 'Veilstar' LIMIT 1");
      if (vid.rows.length > 0) {
        const sid = vid.rows[0].id;
        const cnt = await client.query("SELECT COUNT(*)::int AS c FROM player_creatures WHERE species_id = $1", [sid]);
        if (cnt.rows[0].c === 0) {
          await client.query("DELETE FROM species_abilities WHERE species_id = $1", [sid]);
          await client.query("DELETE FROM user_species_discovery WHERE species_id = $1", [sid]);
          await client.query("DELETE FROM creature_species WHERE id = $1", [sid]);
          console.log("Removed unused species Veilstar; ultra-rare grass is now Twinkl (see grassRarity.js)");
        } else {
          console.log("Veilstar still owned by players — left in DB; ultra-rare logic now targets Twinkl only");
        }
      }
      await client.query("INSERT INTO schema_migrations (id) VALUES ('rare_grass_twinkl_cleanup_v1')");
    }

    const qClear = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", ["clear_all_quest_progress_v1"]);
    if (qClear.rows.length === 0) {
      await client.query("DELETE FROM quest_progress");
      await client.query("INSERT INTO schema_migrations (id) VALUES ('clear_all_quest_progress_v1')");
      console.log(
        "Applied clear_all_quest_progress_v1: everyone starts fresh; first quest (mix_catch_10) is created on next login/join"
      );
    }

    const migRanges = await client.query("SELECT 1 FROM schema_migrations WHERE id = $1", ["stat_ranges_v1"]);
    if (migRanges.rows.length === 0) {
      await client.query(`
        ALTER TABLE creature_species DROP COLUMN IF EXISTS base_thermal;
        ALTER TABLE creature_species DROP COLUMN IF EXISTS base_density;
        ALTER TABLE creature_species DROP COLUMN IF EXISTS base_luminosity;
        ALTER TABLE creature_species DROP COLUMN IF EXISTS base_voltage;
        ALTER TABLE creature_species DROP COLUMN IF EXISTS base_stability;
        ALTER TABLE creature_species DROP COLUMN IF EXISTS base_magnetism;
        ALTER TABLE creature_species DROP COLUMN IF EXISTS stat_variance;
        ALTER TABLE creature_species ADD COLUMN IF NOT EXISTS primary_min INTEGER NOT NULL DEFAULT 1;
        ALTER TABLE creature_species ADD COLUMN IF NOT EXISTS nonprimary_max INTEGER NOT NULL DEFAULT 20;
      `);
      await client.query("INSERT INTO schema_migrations (id) VALUES ('stat_ranges_v1')");
      console.log("Applied stat_ranges_v1: replaced base polarity columns with primary_min / nonprimary_max ranges");
    }

    console.log("Database tables initialized");
  } finally {
    client.release();
  }
}

module.exports = { pool, initDB };
