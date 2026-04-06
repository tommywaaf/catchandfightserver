const { pool } = require("./db");
const { applyClampsToCreature } = require("./statClamp");
const { RARE_GRASS_SPECIES_NAME, RARE_GRASS_ENCOUNTER_CHANCE } = require("./grassRarity");

const PARTY_MAX = 5;
const STORAGE_MAX = 500;

class InventoryManager {
  static async getParty(userId) {
    const result = await pool.query(
      `SELECT pc.*, cs.name AS species_name, cs.base_hp, cs.primary_stat1, cs.primary_side1, cs.primary_stat2, cs.primary_side2,
        json_agg(json_build_object('abilityId', a.id, 'name', a.name, 'baseDamage', a.base_damage,
          'abilitySpeed', a.ability_speed, 'stat1', a.stat1, 'stat2', a.stat2, 'slot', ca.slot)
          ORDER BY ca.slot) AS abilities
       FROM player_creatures pc
       JOIN creature_species cs ON pc.species_id = cs.id
       LEFT JOIN creature_abilities ca ON ca.creature_id = pc.id
       LEFT JOIN abilities a ON a.id = ca.ability_id
       WHERE pc.user_id = $1 AND pc.slot_type = 'party'
       GROUP BY pc.id, cs.name, cs.base_hp, cs.primary_stat1, cs.primary_side1, cs.primary_stat2, cs.primary_side2
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
      `SELECT pc.*, cs.name AS species_name, cs.base_hp, cs.primary_stat1, cs.primary_side1, cs.primary_stat2, cs.primary_side2,
        json_agg(json_build_object('abilityId', a.id, 'name', a.name, 'baseDamage', a.base_damage,
          'abilitySpeed', a.ability_speed, 'stat1', a.stat1, 'stat2', a.stat2, 'slot', ca.slot)
          ORDER BY ca.slot) AS abilities
       FROM player_creatures pc
       JOIN creature_species cs ON pc.species_id = cs.id
       LEFT JOIN creature_abilities ca ON ca.creature_id = pc.id
       LEFT JOIN abilities a ON a.id = ca.ability_id
       WHERE pc.user_id = $1 AND pc.slot_type = 'storage'
       GROUP BY pc.id, cs.name, cs.base_hp, cs.primary_stat1, cs.primary_side1, cs.primary_stat2, cs.primary_side2
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
      `SELECT pc.*, cs.name AS species_name, cs.base_hp, cs.primary_stat1, cs.primary_side1, cs.primary_stat2, cs.primary_side2,
        json_agg(json_build_object('abilityId', a.id, 'name', a.name, 'baseDamage', a.base_damage,
          'abilitySpeed', a.ability_speed, 'stat1', a.stat1, 'stat2', a.stat2, 'slot', ca.slot)
          ORDER BY ca.slot) AS abilities
       FROM player_creatures pc
       JOIN creature_species cs ON pc.species_id = cs.id
       LEFT JOIN creature_abilities ca ON ca.creature_id = pc.id
       LEFT JOIN abilities a ON a.id = ca.ability_id
       WHERE pc.id = $1
       GROUP BY pc.id, cs.name, cs.base_hp, cs.primary_stat1, cs.primary_side1, cs.primary_stat2, cs.primary_side2`,
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
      `SELECT pc.*, cs.name AS species_name, cs.base_hp, cs.primary_stat1, cs.primary_side1, cs.primary_stat2, cs.primary_side2,
        (ABS(pc.thermal) + ABS(pc.density) + ABS(pc.luminosity) + ABS(pc.voltage) + ABS(pc.stability) + ABS(pc.magnetism) + pc.speed) AS polarity_score,
        json_agg(json_build_object('abilityId', a.id, 'name', a.name, 'baseDamage', a.base_damage,
          'abilitySpeed', a.ability_speed, 'stat1', a.stat1, 'stat2', a.stat2, 'slot', ca.slot)
          ORDER BY ca.slot) AS abilities
       FROM player_creatures pc
       JOIN creature_species cs ON pc.species_id = cs.id
       LEFT JOIN creature_abilities ca ON ca.creature_id = pc.id
       LEFT JOIN abilities a ON a.id = ca.ability_id
       WHERE pc.user_id = $1
       GROUP BY pc.id, cs.name, cs.base_hp, cs.primary_stat1, cs.primary_side1, cs.primary_stat2, cs.primary_side2
       ORDER BY polarity_score ASC
       LIMIT 1`,
      [userId]
    );
    if (result.rows.length === 0) return null;
    const row = result.rows[0];
    const c = formatCreature(row);
    c.polarityScore = parseInt(row.polarity_score);
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

  static async ensureGrassProgress(userId) {
    await pool.query(
      "INSERT INTO user_grass_progress (user_id, unlock_tier) VALUES ($1, 0) ON CONFLICT (user_id) DO NOTHING",
      [userId]
    );
  }

  static async getGrassUnlockTier(userId) {
    await this.ensureGrassProgress(userId);
    const result = await pool.query("SELECT unlock_tier FROM user_grass_progress WHERE user_id = $1", [userId]);
    return result.rows.length > 0 ? Number(result.rows[0].unlock_tier || 0) : 0;
  }

  static async setGrassUnlockTier(userId, unlockTier) {
    await pool.query(
      `INSERT INTO user_grass_progress (user_id, unlock_tier)
       VALUES ($1, $2)
       ON CONFLICT (user_id) DO UPDATE SET unlock_tier = GREATEST(user_grass_progress.unlock_tier, EXCLUDED.unlock_tier)`,
      [userId, unlockTier]
    );
  }

  static async recordDiscovery(userId, speciesId) {
    await pool.query(
      "INSERT INTO user_species_discovery (user_id, species_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
      [userId, speciesId]
    );
  }

  static async getGrassDexState(userId) {
    const unlockTier = await this.getGrassUnlockTier(userId);
    const speciesResult = await pool.query(
      `SELECT id, name, primary_stat1, primary_side1, primary_stat2, primary_side2, find_weight, grass_unlock_tier
       FROM creature_species
       ORDER BY id ASC`
    );
    const discoveredResult = await pool.query(
      "SELECT species_id FROM user_species_discovery WHERE user_id = $1",
      [userId]
    );
    const discoveredSet = new Set(discoveredResult.rows.map((r) => Number(r.species_id)));
    const unlockedSpecies = speciesResult.rows.filter((s) => Number(s.grass_unlock_tier) <= unlockTier);
    const rareUnlocked = unlockedSpecies.some((s) => s.name === RARE_GRASS_SPECIES_NAME);
    const weightedUnlocked = rareUnlocked
      ? unlockedSpecies.filter((s) => s.name !== RARE_GRASS_SPECIES_NAME)
      : unlockedSpecies;
    const sumWeights = Math.max(1, weightedUnlocked.reduce((sum, s) => sum + Number(s.find_weight || 0), 0));
    const restP = 1 - (rareUnlocked ? RARE_GRASS_ENCOUNTER_CHANCE : 0);

    const entries = [];
    for (const species of speciesResult.rows) {
      const isDiscovered = discoveredSet.has(Number(species.id));
      const isUnlocked = Number(species.grass_unlock_tier) <= unlockTier;
      let findChance = 0;
      if (isUnlocked) {
        if (species.name === RARE_GRASS_SPECIES_NAME) {
          findChance = RARE_GRASS_ENCOUNTER_CHANCE * 100;
        } else if (rareUnlocked) {
          findChance = restP * (Number(species.find_weight || 0) / sumWeights) * 100;
        } else {
          findChance = (Number(species.find_weight || 0) / sumWeights) * 100;
        }
      }
      entries.push({
        slot: entries.length + 1,
        speciesId: Number(species.id),
        discovered: isDiscovered,
        name: isDiscovered ? species.name : null,
        portraitKey: isDiscovered ? species.name : null,
        primaryStat1: isDiscovered ? species.primary_stat1 : null,
        primarySide1: isDiscovered ? species.primary_side1 : null,
        primaryStat2: isDiscovered ? species.primary_stat2 : null,
        primarySide2: isDiscovered ? species.primary_side2 : null,
        findPercent: Number(findChance.toFixed(2)),
        unlocked: isUnlocked,
      });
    }

    while (entries.length < 100) {
      entries.push({
        slot: entries.length + 1,
        speciesId: 0,
        discovered: false,
        name: null,
        portraitKey: null,
        primaryStat1: null,
        primarySide1: null,
        primaryStat2: null,
        primarySide2: null,
        findPercent: 0,
        unlocked: false,
      });
    }

    return {
      entries,
      discoveredCount: discoveredSet.size,
      speciesCount: speciesResult.rows.length,
      grassPoolSize: unlockedSpecies.length,
      unlockTier,
    };
  }
}

function formatCreature(row) {
  const c = {
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
    primaryStat1: row.primary_stat1,
    primarySide1: row.primary_side1,
    primaryStat2: row.primary_stat2,
    primarySide2: row.primary_side2,
    slotType: row.slot_type,
    partyPosition: row.party_position,
    abilities: (row.abilities || []).filter(a => a.abilityId !== null),
  };
  applyClampsToCreature(c, row);
  return c;
}

module.exports = InventoryManager;
