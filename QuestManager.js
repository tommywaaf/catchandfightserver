const { pool } = require("./db");
const InventoryManager = require("./InventoryManager");

const QUESTS = [
  { id: "catch_10", description: "Catch 10 escaped lab creatures", target: 10, next: "win_pvp_1" },
  { id: "win_pvp_1", description: "Win 1 battle against another player", target: 1, next: "hunt_flaro", rewardUnlockTier: 1, unlockAdded: 4 },
  { id: "hunt_flaro", description: "Catch 1 Flaro in grass (+4 hidden species unlocked)", target: 1, speciesName: "Flaro", next: "hunt_drifin", rewardUnlockTier: 2, unlockAdded: 4 },
  { id: "hunt_drifin", description: "Catch 1 Drifin in grass (+4 hidden species unlocked)", target: 1, speciesName: "Drifin", next: "hunt_ripple", rewardUnlockTier: 3, unlockAdded: 4 },
  { id: "hunt_ripple", description: "Catch 1 Ripple in grass (+4 hidden species unlocked)", target: 1, speciesName: "Ripple", next: "hunt_charby", rewardUnlockTier: 4, unlockAdded: 4 },
  { id: "hunt_charby", description: "Catch 1 Charby in grass (+3 hidden species unlocked)", target: 1, speciesName: "Charby", next: "hunt_twinkl", rewardUnlockTier: 5, unlockAdded: 3 },
  { id: "hunt_twinkl", description: "Catch 1 Twinkl in grass", target: 1, speciesName: "Twinkl", next: null },
];

class QuestManager {
  getQuestDef(questId) {
    return QUESTS.find((q) => q.id === questId);
  }

  async getQuests(userId) {
    const result = await pool.query(
      "SELECT quest_id, progress, completed FROM quest_progress WHERE user_id = $1",
      [userId]
    );

    const quests = result.rows.map((row) => {
      const def = this.getQuestDef(row.quest_id);
      return {
        questId: row.quest_id,
        description: def ? def.description : row.quest_id,
        progress: row.progress,
        target: def ? def.target : 0,
        completed: row.completed,
      };
    });

    if (quests.length === 0) {
      await pool.query(
        "INSERT INTO quest_progress (user_id, quest_id, progress, completed) VALUES ($1, $2, 0, FALSE) ON CONFLICT DO NOTHING",
        [userId, "catch_10"]
      );
      const def = this.getQuestDef("catch_10");
      quests.push({
        questId: "catch_10",
        description: def.description,
        progress: 0,
        target: def.target,
        completed: false,
      });
    }

    return quests;
  }

  async incrementQuest(player, questId, amount) {
    if (!player.userId) return;

    const existing = await pool.query(
      "SELECT progress, completed FROM quest_progress WHERE user_id = $1 AND quest_id = $2",
      [player.userId, questId]
    );

    if (existing.rows.length === 0) return;
    if (existing.rows[0].completed) return;

    const def = this.getQuestDef(questId);
    if (!def) return;

    const newProgress = Math.min(existing.rows[0].progress + amount, def.target);
    const completed = newProgress >= def.target;

    await pool.query(
      "UPDATE quest_progress SET progress = $1, completed = $2 WHERE user_id = $3 AND quest_id = $4",
      [newProgress, completed, player.userId, questId]
    );

    if (completed && def.next) {
      await pool.query(
        "INSERT INTO quest_progress (user_id, quest_id, progress, completed) VALUES ($1, $2, 0, FALSE) ON CONFLICT DO NOTHING",
        [player.userId, def.next]
      );
    }

    if (completed && typeof def.rewardUnlockTier === "number") {
      await InventoryManager.setGrassUnlockTier(player.userId, def.rewardUnlockTier);
      player.grassUnlockTier = await InventoryManager.getGrassUnlockTier(player.userId);
      player.send({
        type: "grassPoolUnlocked",
        unlockTier: player.grassUnlockTier,
        addedCount: Number(def.unlockAdded || 0),
      });
    }

    const quests = await this.getQuests(player.userId);
    player.quests = quests;
    player.send({ type: "questUpdated", quests, justCompleted: completed ? questId : null });

    if (completed) {
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

  async handleCreatureCaught(player, speciesName) {
    if (!player?.userId || !speciesName) return;

    const activeResult = await pool.query(
      "SELECT quest_id FROM quest_progress WHERE user_id = $1 AND completed = FALSE",
      [player.userId]
    );
    for (const row of activeResult.rows) {
      const def = this.getQuestDef(row.quest_id);
      if (!def || !def.speciesName) continue;
      if (def.speciesName.toLowerCase() !== String(speciesName).toLowerCase()) continue;
      await this.incrementQuest(player, row.quest_id, 1);
    }
  }
}

module.exports = QuestManager;
