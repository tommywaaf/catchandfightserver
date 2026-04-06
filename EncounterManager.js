const { pool } = require("./db");
const InventoryManager = require("./InventoryManager");
const { clampElemental, isPrimaryStat, getPrimarySide } = require("./statClamp");
const { RARE_GRASS_SPECIES_NAME, RARE_GRASS_ENCOUNTER_CHANCE } = require("./grassRarity");

/** No encounter progress unless the client sent a recent move while in grass (standing still = no catches) */
const GRASS_MOVE_STALE_MS = 400;
const ELEMENTAL_STATS = ["thermal", "density", "luminosity", "voltage", "stability", "magnetism"];

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

    const result = await tryAddCreature(player.userId, species.id, stats, selectedAbilities);

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

      await questManager.onGrassCatch(player, creature);
    } else {
      const msg =
        result.error === "Storage full"
          ? "Storage is full — swap a creature or make room."
          : "Could not save the creature. Please try again.";
      player.send({
        type: "creatureEscaped",
        message: msg,
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

    const rare = pool.find((s) => s.name === RARE_GRASS_SPECIES_NAME);
    const weightedPool = rare ? pool.filter((s) => s.name !== RARE_GRASS_SPECIES_NAME) : pool;

    if (rare && Math.random() < RARE_GRASS_ENCOUNTER_CHANCE) {
      return rare;
    }

    const totalWeight = weightedPool.reduce((sum, s) => sum + Number(s.find_weight || 0), 0);
    if (totalWeight <= 0) return rare || pool[0];
    let roll = Math.random() * totalWeight;
    for (const species of weightedPool) {
      roll -= Number(species.find_weight || 0);
      if (roll <= 0) return species;
    }
    return weightedPool[weightedPool.length - 1];
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

/** Retries transient DB failures so catches are not lost to a single bad transaction. */
async function tryAddCreature(userId, speciesId, stats, abilityIds, maxAttempts = 3) {
  let last = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, 40 + attempt * 80));
    }
    last = await InventoryManager.addCreature(userId, speciesId, stats, abilityIds);
    if (last.success) return last;
    if (last.error === "Storage full") return last;
  }
  return last;
}

function rollElementalStat(statName, species, variance) {
  const baseKey = `base_${statName}`;
  const rolled = Number(species[baseKey]) + randVariance(variance);
  const primary = isPrimaryStat(species, statName);
  const primarySide = getPrimarySide(species, statName);
  return clampElemental(rolled, primary, primarySide);
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
