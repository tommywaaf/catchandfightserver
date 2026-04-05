const { pool } = require("./db");

const PARTY_MAX = 5;
const STORAGE_MAX = 500;

class InventoryManager {
  static async getParty(userId) {
    const result = await pool.query(
      `SELECT pc.*, cs.name AS species_name, cs.base_hp,
        json_agg(json_build_object('abilityId', a.id, 'name', a.name, 'baseDamage', a.base_damage,
          'abilitySpeed', a.ability_speed, 'stat1', a.stat1, 'stat2', a.stat2, 'slot', ca.slot)
          ORDER BY ca.slot) AS abilities
       FROM player_creatures pc
       JOIN creature_species cs ON pc.species_id = cs.id
       LEFT JOIN creature_abilities ca ON ca.creature_id = pc.id
       LEFT JOIN abilities a ON a.id = ca.ability_id
       WHERE pc.user_id = $1 AND pc.slot_type = 'party'
       GROUP BY pc.id, cs.name, cs.base_hp
       ORDER BY pc.party_position`,
      [userId]
    );
    return result.rows.map(formatCreature);
  }

  static async getStorage(userId, page = 0, pageSize = 50) {
    const offset = page * pageSize;
    const countResult = await pool.query(
      "SELECT COUNT(*) FROM player_creatures WHERE user_id = $1 AND slot_type = 'storage'",
      [userId]
    );
    const total = parseInt(countResult.rows[0].count);

    const result = await pool.query(
      `SELECT pc.*, cs.name AS species_name, cs.base_hp,
        json_agg(json_build_object('abilityId', a.id, 'name', a.name, 'baseDamage', a.base_damage,
          'abilitySpeed', a.ability_speed, 'stat1', a.stat1, 'stat2', a.stat2, 'slot', ca.slot)
          ORDER BY ca.slot) AS abilities
       FROM player_creatures pc
       JOIN creature_species cs ON pc.species_id = cs.id
       LEFT JOIN creature_abilities ca ON ca.creature_id = pc.id
       LEFT JOIN abilities a ON a.id = ca.ability_id
       WHERE pc.user_id = $1 AND pc.slot_type = 'storage'
       GROUP BY pc.id, cs.name, cs.base_hp
       ORDER BY pc.created_at DESC
       LIMIT $2 OFFSET $3`,
      [userId, pageSize, offset]
    );
    return { creatures: result.rows.map(formatCreature), total, page, pageSize };
  }

  static async getPartyCount(userId) {
    const r = await pool.query(
      "SELECT COUNT(*) FROM player_creatures WHERE user_id = $1 AND slot_type = 'party'",
      [userId]
    );
    return parseInt(r.rows[0].count);
  }

  static async getStorageCount(userId) {
    const r = await pool.query(
      "SELECT COUNT(*) FROM player_creatures WHERE user_id = $1 AND slot_type = 'storage'",
      [userId]
    );
    return parseInt(r.rows[0].count);
  }

  static async addCreature(userId, speciesId, stats, abilityIds) {
    const partyCount = await this.getPartyCount(userId);
    let slotType, partyPosition;

    if (partyCount < PARTY_MAX) {
      slotType = "party";
      partyPosition = partyCount;
    } else {
      const storageCount = await this.getStorageCount(userId);
      if (storageCount >= STORAGE_MAX) {
        return { success: false, error: "Storage full" };
      }
      slotType = "storage";
      partyPosition = null;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const insertResult = await client.query(
        `INSERT INTO player_creatures (user_id, species_id, current_hp, thermal, density, luminosity, voltage, stability, magnetism, speed, slot_type, party_position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         RETURNING id`,
        [userId, speciesId, stats.hp, stats.thermal, stats.density, stats.luminosity, stats.voltage, stats.stability, stats.magnetism, stats.speed, slotType, partyPosition]
      );
      const creatureId = insertResult.rows[0].id;

      for (let slot = 0; slot < abilityIds.length && slot < 4; slot++) {
        await client.query(
          "INSERT INTO creature_abilities (creature_id, ability_id, slot) VALUES ($1, $2, $3)",
          [creatureId, abilityIds[slot], slot]
        );
      }
      await client.query("COMMIT");
      return { success: true, creatureId, slotType };
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("addCreature error:", err.message);
      return { success: false, error: "Failed to add creature" };
    } finally {
      client.release();
    }
  }

  static async swapToParty(userId, creatureId, position) {
    if (position < 0 || position > 4) return { success: false, error: "Invalid position" };

    const creature = await pool.query(
      "SELECT id, slot_type FROM player_creatures WHERE id = $1 AND user_id = $2",
      [creatureId, userId]
    );
    if (creature.rows.length === 0) return { success: false, error: "Creature not found" };
    if (creature.rows[0].slot_type === "party") return { success: false, error: "Already in party" };

    const existing = await pool.query(
      "SELECT id FROM player_creatures WHERE user_id = $1 AND slot_type = 'party' AND party_position = $2",
      [userId, position]
    );

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      if (existing.rows.length > 0) {
        await client.query(
          "UPDATE player_creatures SET slot_type = 'storage', party_position = NULL WHERE id = $1",
          [existing.rows[0].id]
        );
      }
      await client.query(
        "UPDATE player_creatures SET slot_type = 'party', party_position = $1 WHERE id = $2",
        [position, creatureId]
      );
      await client.query("COMMIT");
      return { success: true };
    } catch (err) {
      await client.query("ROLLBACK");
      return { success: false, error: "Swap failed" };
    } finally {
      client.release();
    }
  }

  static async swapToStorage(userId, creatureId) {
    const partyCount = await this.getPartyCount(userId);
    if (partyCount <= 1) return { success: false, error: "Must keep at least 1 creature in party" };

    const creature = await pool.query(
      "SELECT id, slot_type FROM player_creatures WHERE id = $1 AND user_id = $2",
      [creatureId, userId]
    );
    if (creature.rows.length === 0) return { success: false, error: "Creature not found" };
    if (creature.rows[0].slot_type === "storage") return { success: false, error: "Already in storage" };

    await pool.query(
      "UPDATE player_creatures SET slot_type = 'storage', party_position = NULL WHERE id = $1",
      [creatureId]
    );

    await this.reindexParty(userId);
    return { success: true };
  }

  static async swapPartyPositions(userId, pos1, pos2) {
    if (pos1 < 0 || pos1 > 4 || pos2 < 0 || pos2 > 4) return { success: false, error: "Invalid positions" };

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const c1 = await client.query(
        "SELECT id FROM player_creatures WHERE user_id = $1 AND slot_type = 'party' AND party_position = $2",
        [userId, pos1]
      );
      const c2 = await client.query(
        "SELECT id FROM player_creatures WHERE user_id = $1 AND slot_type = 'party' AND party_position = $2",
        [userId, pos2]
      );

      if (c1.rows.length > 0) {
        await client.query("UPDATE player_creatures SET party_position = -1 WHERE id = $1", [c1.rows[0].id]);
      }
      if (c2.rows.length > 0) {
        await client.query("UPDATE player_creatures SET party_position = $1 WHERE id = $2", [pos1, c2.rows[0].id]);
      }
      if (c1.rows.length > 0) {
        await client.query("UPDATE player_creatures SET party_position = $1 WHERE id = $2", [pos2, c1.rows[0].id]);
      }
      await client.query("COMMIT");
      return { success: true };
    } catch (err) {
      await client.query("ROLLBACK");
      return { success: false, error: "Reorder failed" };
    } finally {
      client.release();
    }
  }

  static async reindexParty(userId) {
    const party = await pool.query(
      "SELECT id FROM player_creatures WHERE user_id = $1 AND slot_type = 'party' ORDER BY party_position",
      [userId]
    );
    for (let i = 0; i < party.rows.length; i++) {
      await pool.query("UPDATE player_creatures SET party_position = $1 WHERE id = $2", [i, party.rows[i].id]);
    }
  }

  static async getCreatureById(creatureId) {
    const result = await pool.query(
      `SELECT pc.*, cs.name AS species_name, cs.base_hp,
        json_agg(json_build_object('abilityId', a.id, 'name', a.name, 'baseDamage', a.base_damage,
          'abilitySpeed', a.ability_speed, 'stat1', a.stat1, 'stat2', a.stat2, 'slot', ca.slot)
          ORDER BY ca.slot) AS abilities
       FROM player_creatures pc
       JOIN creature_species cs ON pc.species_id = cs.id
       LEFT JOIN creature_abilities ca ON ca.creature_id = pc.id
       LEFT JOIN abilities a ON a.id = ca.ability_id
       WHERE pc.id = $1
       GROUP BY pc.id, cs.name, cs.base_hp`,
      [creatureId]
    );
    if (result.rows.length === 0) return null;
    return formatCreature(result.rows[0]);
  }

  static async getTotalCreatureCount(userId) {
    const r = await pool.query("SELECT COUNT(*) FROM player_creatures WHERE user_id = $1", [userId]);
    return parseInt(r.rows[0].count);
  }

  static async getLowestStatCreature(userId) {
    const result = await pool.query(
      `SELECT pc.*, cs.name AS species_name, cs.base_hp,
        (pc.thermal + pc.density + pc.luminosity + pc.voltage + pc.stability + pc.magnetism + pc.speed) AS total_stats,
        json_agg(json_build_object('abilityId', a.id, 'name', a.name, 'baseDamage', a.base_damage,
          'abilitySpeed', a.ability_speed, 'stat1', a.stat1, 'stat2', a.stat2, 'slot', ca.slot)
          ORDER BY ca.slot) AS abilities
       FROM player_creatures pc
       JOIN creature_species cs ON pc.species_id = cs.id
       LEFT JOIN creature_abilities ca ON ca.creature_id = pc.id
       LEFT JOIN abilities a ON a.id = ca.ability_id
       WHERE pc.user_id = $1
       GROUP BY pc.id, cs.name, cs.base_hp
       ORDER BY total_stats ASC
       LIMIT 1`,
      [userId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    const c = formatCreature(row);
    c.totalStats = parseInt(row.total_stats);
    return c;
  }

  static async releaseCreature(userId, creatureId) {
    const totalCount = await this.getTotalCreatureCount(userId);
    if (totalCount <= 1) return { success: false, error: "Must keep at least 1 creature" };

    const creature = await pool.query(
      "SELECT id, slot_type FROM player_creatures WHERE id = $1 AND user_id = $2",
      [creatureId, userId]
    );
    if (creature.rows.length === 0) return { success: false, error: "Creature not found" };

    await pool.query("DELETE FROM creature_abilities WHERE creature_id = $1", [creatureId]);
    await pool.query("DELETE FROM player_creatures WHERE id = $1", [creatureId]);

    if (creature.rows[0].slot_type === "party") {
      await this.reindexParty(userId);
    }

    return { success: true };
  }

  static async replaceCreature(userId, oldCreatureId, speciesId, stats, abilityIds) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM creature_abilities WHERE creature_id = $1", [oldCreatureId]);
      await client.query("DELETE FROM player_creatures WHERE id = $1 AND user_id = $2", [oldCreatureId, userId]);

      const insertResult = await client.query(
        `INSERT INTO player_creatures (user_id, species_id, current_hp, thermal, density, luminosity, voltage, stability, magnetism, speed, slot_type, party_position)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'storage', NULL)
         RETURNING id`,
        [userId, speciesId, stats.hp, stats.thermal, stats.density, stats.luminosity, stats.voltage, stats.stability, stats.magnetism, stats.speed]
      );
      const creatureId = insertResult.rows[0].id;

      for (let slot = 0; slot < abilityIds.length && slot < 4; slot++) {
        await client.query(
          "INSERT INTO creature_abilities (creature_id, ability_id, slot) VALUES ($1, $2, $3)",
          [creatureId, abilityIds[slot], slot]
        );
      }
      await client.query("COMMIT");
      return { success: true, creatureId };
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("replaceCreature error:", err.message);
      return { success: false, error: "Replace failed" };
    } finally {
      client.release();
    }
  }
}

function formatCreature(row) {
  return {
    id: row.id,
    speciesId: row.species_id,
    speciesName: row.species_name,
    nickname: row.nickname,
    currentHp: row.current_hp,
    maxHp: row.base_hp,
    thermal: row.thermal,
    density: row.density,
    luminosity: row.luminosity,
    voltage: row.voltage,
    stability: row.stability,
    magnetism: row.magnetism,
    speed: row.speed,
    slotType: row.slot_type,
    partyPosition: row.party_position,
    abilities: (row.abilities || []).filter(a => a.abilityId !== null),
  };
}

module.exports = InventoryManager;
