const { pool } = require("./db");
const InventoryManager = require("./InventoryManager");

class EncounterManager {
  constructor() {
    this.speciesList = [];
    this.speciesAbilities = new Map();
    this.trackedPlayers = new Set();
  }

  async loadSpeciesData() {
    const speciesResult = await pool.query("SELECT * FROM creature_species");
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
    for (const player of this.trackedPlayers) {
      if (!player.alive || !player.isInGrass || player.inBattle) continue;

      player.encounterTimer -= deltaSeconds;
      if (player.encounterTimer <= 0) {
        this.triggerEncounter(player, questManager);
        player.encounterTimer = this.randomTimer();
      }
    }
  }

  async triggerEncounter(player, questManager) {
    if (this.speciesList.length === 0) return;

    const species = this.speciesList[Math.floor(Math.random() * this.speciesList.length)];
    const variance = species.stat_variance;

    const stats = {
      hp: species.base_hp,
      thermal: clampStat(species.base_thermal + randVariance(variance)),
      density: clampStat(species.base_density + randVariance(variance)),
      luminosity: clampStat(species.base_luminosity + randVariance(variance)),
      voltage: clampStat(species.base_voltage + randVariance(variance)),
      stability: clampStat(species.base_stability + randVariance(variance)),
      magnetism: clampStat(species.base_magnetism + randVariance(variance)),
      speed: clampStat(species.base_speed + randVariance(variance)),
    };

    const availableAbilities = this.speciesAbilities.get(species.id) || [];
    const shuffled = [...availableAbilities].sort(() => Math.random() - 0.5);
    const selectedAbilities = shuffled.slice(0, Math.min(4, shuffled.length));

    const result = await InventoryManager.addCreature(player.userId, species.id, stats, selectedAbilities);

    if (result.success) {
      const creature = await InventoryManager.getCreatureById(result.creatureId);
      player.send({
        type: "creatureCaught",
        creature,
        slotType: result.slotType,
      });

      if (result.slotType === "party") {
        player.party = await InventoryManager.getParty(player.userId);
      }

      await questManager.incrementQuest(player, "catch_10", 1);
    } else {
      player.send({
        type: "creatureEscaped",
        message: result.error || "Storage full, creature escaped!",
      });
    }
  }
}

function clampStat(v) {
  return Math.max(0, Math.min(100, Math.round(v)));
}

function randVariance(v) {
  return (Math.random() * 2 - 1) * v;
}

module.exports = EncounterManager;
