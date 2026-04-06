const { pool } = require("./db");
const InventoryManager = require("./InventoryManager");

/** No encounter progress unless the client sent a recent move while in grass (standing still = no catches) */
const GRASS_MOVE_STALE_MS = 400;
const ELEMENTAL_STATS = ["thermal", "density", "luminosity", "voltage", "stability", "magnetism"];
const PRIMARY_FLOOR = { right: 1, left: -1 };

class EncounterManager {
  constructor() {
    this.speciesList = [];
    this.speciesAbilities = new Map();
    this.trackedPlayers = new Set();
  }

  async loadSpeciesData() {
    const speciesResult = await pool.query("SELECT * FROM creature_species ORDER BY id ASC");
    this.speciesList = speciesResult.rows;

    const saResult = await pool.query("SELECT species_id, ability_id FROM species_abilities");
    for (const row of saResult.rows) {
      if (!this.speciesAbilities.has(row.species_id)) {
        this.speciesAbilities.set(row.species_id, []);
      }
      this.speciesAbilities.get(row.species_id).push(row.ability_id);
    }

    console.log(`Loaded ${this.speciesList.length} species, ${saResult.rows.length} species-ability mappings`);
  }

  initPlayer(player) {
    player.encounterTimer = this.randomTimer();
    player.isInGrass = false;
    this.trackedPlayers.add(player);
  }

  removePlayer(player) {
    this.trackedPlayers.delete(player);
  }

  randomTimer() {
    return 1 + Math.random() * 14;
  }

  tick(deltaSeconds, questManager) {
    const now = Date.now();
    for (const player of this.trackedPlayers) {
      if (!player.alive || !player.isInGrass || player.inBattle) continue;
      if (now - (player.lastGrassActiveMove || 0) > GRASS_MOVE_STALE_MS) continue;

      player.encounterTimer -= deltaSeconds;
      if (player.encounterTimer <= 0) {
        this.triggerEncounter(player, questManager).catch((err) => {
          console.error("Encounter error:", err.message);
        });
        player.encounterTimer = this.randomTimer();
      }
    }
  }

  async triggerEncounter(player, questManager) {
    if (this.speciesList.length === 0) {
      console.error("No species loaded! Cannot trigger encounter.");
      return;
    }
    console.log(`Triggering encounter for ${player.name} (${player.userId})`);

    const species = this.pickSpeciesForPlayer(player);
    if (!species) return;
    const variance = species.stat_variance;

    const stats = {
      hp: species.base_hp,
      thermal: rollElementalStat("thermal", species, variance),
      density: rollElementalStat("density", species, variance),
      luminosity: rollElementalStat("luminosity", species, variance),
      voltage: rollElementalStat("voltage", species, variance),
      stability: rollElementalStat("stability", species, variance),
      magnetism: rollElementalStat("magnetism", species, variance),
      speed: clampSpeed(species.base_speed + randVariance(variance)),
    };

    const availableAbilities = this.speciesAbilities.get(species.id) || [];
    const shuffled = [...availableAbilities].sort(() => Math.random() - 0.5);
    const selectedAbilities = shuffled.slice(0, Math.min(4, shuffled.length));

    const storageCount = await InventoryManager.getStorageCount(player.userId);
    const partyCount = await InventoryManager.getPartyCount(player.userId);
    const isFull = partyCount >= 5 && storageCount >= 500;

    if (isFull) {
      const lowest = await InventoryManager.getLowestStatCreature(player.userId);
      const newPolarity = polarityScore(stats);

      player.send({
        type: "storageFullOffer",
        newCreature: {
          speciesId: species.id,
          speciesName: species.name,
          primaryStat1: species.primary_stat1,
          primarySide1: species.primary_side1,
          primaryStat2: species.primary_stat2,
          primarySide2: species.primary_side2,
          ...stats,
          currentHp: stats.hp,
          maxHp: stats.hp,
          abilities: selectedAbilities,
          polarityScore: newPolarity,
        },
        lowestCreature: lowest,
      });
      player._pendingReplace = { speciesId: species.id, speciesName: species.name, stats, abilityIds: selectedAbilities };
      return;
    }

    const result = await InventoryManager.addCreature(player.userId, species.id, stats, selectedAbilities);

    if (result.success) {
      await InventoryManager.recordDiscovery(player.userId, species.id);
      const creature = await InventoryManager.getCreatureById(result.creatureId);
      player.send({
        type: "creatureCaught",
        creature,
        slotType: result.slotType,
      });
      await this.pushGrassDex(player);

      if (result.slotType === "party") {
        player.party = await InventoryManager.getParty(player.userId);
      }

      await questManager.incrementQuest(player, "catch_10", 1);
      await questManager.handleCreatureCaught(player, species.name);
    } else {
      player.send({
        type: "creatureEscaped",
        message: result.error || "Storage full, creature escaped!",
      });
    }
  }

  pickSpeciesForPlayer(player) {
    const unlockTier = Number(player.grassUnlockTier || 0);
    let pool = this.speciesList.filter((s) => Number(s.grass_unlock_tier) <= unlockTier && Number(s.find_weight) > 0);
    if (pool.length === 0) {
      pool = this.speciesList.filter((s) => Number(s.grass_unlock_tier) <= 0 && Number(s.find_weight) > 0);
    }
    if (pool.length === 0) return null;

    const totalWeight = pool.reduce((sum, s) => sum + Number(s.find_weight || 0), 0);
    let roll = Math.random() * totalWeight;
    for (const species of pool) {
      roll -= Number(species.find_weight || 0);
      if (roll <= 0) return species;
    }
    return pool[pool.length - 1];
  }

  async pushGrassDex(player) {
    const dex = await InventoryManager.getGrassDexState(player.userId);
    player.send({
      type: "grassDexUpdated",
      grassDex: dex.entries,
      grassPoolSize: dex.grassPoolSize,
      discoveredCount: dex.discoveredCount,
      speciesCount: dex.speciesCount,
      unlockTier: dex.unlockTier,
    });
  }
}

function rollElementalStat(statName, species, variance) {
  const baseKey = `base_${statName}`;
  const rolled = Number(species[baseKey]) + randVariance(variance);
  const isPrimary = isPrimaryStat(species, statName);
  const primarySide = getPrimarySide(species, statName);
  return clampElemental(rolled, isPrimary, primarySide);
}

function isPrimaryStat(species, statName) {
  return species.primary_stat1 === statName || species.primary_stat2 === statName;
}

function getPrimarySide(species, statName) {
  if (species.primary_stat1 === statName) return species.primary_side1;
  if (species.primary_stat2 === statName) return species.primary_side2;
  return null;
}

function clampElemental(v, isPrimary, primarySide) {
  const min = isPrimary ? -50 : -30;
  const max = isPrimary ? 50 : 30;
  let clamped = Math.max(min, Math.min(max, Math.round(v)));
  if (isPrimary && primarySide && PRIMARY_FLOOR[primarySide] !== undefined) {
    const floor = PRIMARY_FLOOR[primarySide];
    clamped = primarySide === "left" ? Math.min(clamped, floor) : Math.max(clamped, floor);
  }
  return clamped;
}

function clampSpeed(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}

function randVariance(v) {
  return (Math.random() * 2 - 1) * v;
}

function polarityScore(stats) {
  return ELEMENTAL_STATS.reduce((sum, stat) => sum + Math.abs(Number(stats[stat] || 0)), 0) + Number(stats.speed || 0);
}

module.exports = EncounterManager;
