const { pool } = require("./db");

const QUESTS = [
  { id: "catch_10", description: "Catch 10 escaped lab creatures", target: 10, next: "win_pvp_1" },
  { id: "win_pvp_1", description: "Win 1 battle against another player", target: 1, next: null },
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

    const quests = await this.getQuests(player.userId);
    player.quests = quests;
    player.send({ type: "questUpdated", quests, justCompleted: completed ? questId : null });
  }
}

module.exports = QuestManager;
