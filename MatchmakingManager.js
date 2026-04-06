const { pool } = require("./db");

const BOT_WAIT_MS = 60000;

class MatchmakingManager {
  constructor(battleManager) {
    this.battleManager = battleManager;
    this.queue = [];
    this.questManager = null;
  }

  setQuestManager(qm) {
    this.questManager = qm;
  }

  addToQueue(player) {
    if (!this.isPlayerQueueEligible(player)) {
      player.send({ type: "matchmakingStatus", status: "cancelled" });
      return;
    }

    if (this.queue.find((e) => e.player.userId === player.userId)) {
      player.send({ type: "matchmakingStatus", status: "already_searching" });
      return;
    }

    this.pruneQueue();

    player.inMatchmaking = true;
    player.matchmakingJoinedAt = Date.now();

    const opponent = this.takeNextOpponentFor(player);
    if (opponent) {
      opponent.player.inMatchmaking = false;
      player.inMatchmaking = false;

      console.log(`Match found: ${opponent.player.name} vs ${player.name}`);

      const qm = this.questManager;
      this.battleManager.createBattle(opponent.player, player, false).then((battle) => {
        if (!battle) {
          console.error("Battle creation returned null");
          opponent.player.send({ type: "matchmakingStatus", status: "cancelled" });
          player.send({ type: "matchmakingStatus", status: "cancelled" });
          opponent.player.send({ type: "error", message: "Battle creation failed" });
          player.send({ type: "error", message: "Battle creation failed" });
          return;
        }
        if (qm) {
          battle.questOnHumanWin = (winnerRef) => qm.onBattleWin(winnerRef);
        }
        console.log(`Battle ${battle.id} started: ${opponent.player.name} vs ${player.name}`);
      }).catch((err) => {
        console.error("Battle creation error:", err.message);
        opponent.player.send({ type: "matchmakingStatus", status: "cancelled" });
        player.send({ type: "matchmakingStatus", status: "cancelled" });
        opponent.player.send({ type: "error", message: "Battle creation failed" });
        player.send({ type: "error", message: "Battle creation failed" });
      });
      return;
    }

    this.queue.push({ player, joinedAt: Date.now() });
    player.send({ type: "matchmakingStatus", status: "searching" });
  }

  removeFromQueue(player) {
    const idx = this.queue.findIndex((e) => e.player.userId === player.userId);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
      player.inMatchmaking = false;
      player.send({ type: "matchmakingStatus", status: "cancelled" });
    }
  }

  async tick() {
    this.pruneQueue();

    const now = Date.now();
    const toRemove = [];

    for (let i = 0; i < this.queue.length; i++) {
      const entry = this.queue[i];
      if (now - entry.joinedAt >= BOT_WAIT_MS) {
        toRemove.push(i);
        entry.player.inMatchmaking = false;

        try {
          console.log(`Bot timeout for ${entry.player.name}, generating bot...`);
          const botParty = await this.generateBotParty();

          const botPlayer = {
            userId: "bot",
            name: "Bot",
            party: botParty,
            inBattle: false,
            battleId: null,
          };

          const battle = await this.battleManager.createBattle(entry.player, botPlayer, true);
          if (battle) {
            if (this.questManager) {
              battle.questOnHumanWin = (winnerRef) => this.questManager.onBattleWin(winnerRef);
            }
            console.log(`Bot battle ${battle.id} started for ${entry.player.name}`);
          } else {
            console.error("Bot battle creation returned null");
            entry.player.send({ type: "error", message: "Bot battle failed" });
          }
        } catch (err) {
          console.error("Bot battle error:", err.message);
          entry.player.send({ type: "error", message: "Bot battle failed" });
        }
      }
    }

    for (let i = toRemove.length - 1; i >= 0; i--) {
      this.queue.splice(toRemove[i], 1);
    }
  }

  async generateBotParty() {
    const speciesResult = await pool.query("SELECT * FROM creature_species ORDER BY RANDOM() LIMIT 5");
    const party = [];

    for (const species of speciesResult.rows) {
      const saResult = await pool.query(
        "SELECT ability_id FROM species_abilities WHERE species_id = $1 ORDER BY RANDOM() LIMIT 4",
        [species.id]
      );
      const abIds = saResult.rows.map((r) => r.ability_id);
      let abilities = [];
      if (abIds.length > 0) {
        const abResult = await pool.query("SELECT * FROM abilities WHERE id = ANY($1)", [abIds]);
        abilities = abResult.rows.map((a, i) => ({
          abilityId: a.id,
          name: a.name,
          baseDamage: a.base_damage,
          abilitySpeed: a.ability_speed,
          stat1: a.stat1,
          stat2: a.stat2,
          slot: i,
        }));
      }

      party.push({
        id: -1,
        speciesId: species.id,
        speciesName: species.name,
        nickname: null,
        currentHp: species.base_hp,
        maxHp: species.base_hp,
        thermal: species.base_thermal,
        density: species.base_density,
        luminosity: species.base_luminosity,
        voltage: species.base_voltage,
        stability: species.base_stability,
        magnetism: species.base_magnetism,
        speed: species.base_speed,
        abilities,
      });
    }

    return party;
  }

  isPlayerQueueEligible(player) {
    return !!(
      player &&
      player.authenticated &&
      !player.inBattle &&
      player.ws &&
      player.ws.readyState === 1 &&
      Array.isArray(player.party) &&
      player.party.length > 0
    );
  }

  pruneQueue() {
    this.queue = this.queue.filter((entry) => {
      if (!entry || !entry.player) return false;
      const ok = this.isPlayerQueueEligible(entry.player);
      if (!ok) {
        entry.player.inMatchmaking = false;
      }
      return ok;
    });
  }

  takeNextOpponentFor(player) {
    while (this.queue.length > 0) {
      const entry = this.queue.shift();
      if (!entry || !entry.player) continue;
      if (entry.player.userId === player.userId) continue;
      if (!this.isPlayerQueueEligible(entry.player)) {
        entry.player.inMatchmaking = false;
        continue;
      }
      return entry;
    }
    return null;
  }
}

module.exports = MatchmakingManager;
