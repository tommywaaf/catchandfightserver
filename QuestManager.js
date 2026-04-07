const { pool } = require("./db");
const InventoryManager = require("./InventoryManager");
const { LIMITS } = require("./statClamp");

/** Linear quest order (first incomplete is active). */
const MIXED_QUEST_CHAIN = [
  "mix_catch_10",
  "mix_battle_1",
  "mix_catch_5",
  "mix_brumble",
  "mix_ability_primary",
  "mix_speed_98",
  "mix_catch_8",
  "mix_battle_2",
  "mix_perfect_primary",
  "mix_battle_5",
];

const QUESTS = [
  {
    id: "mix_catch_10",
    description: "Catch 10 creatures in the grass",
    target: 10,
    next: "mix_battle_1",
    trigger: "grassCatch",
    grantPoolExpand: true,
  },
  {
    id: "mix_battle_1",
    description: "Win a battle (player or training bot)",
    target: 1,
    next: "mix_catch_5",
    trigger: "battleWin",
    grantPoolExpand: true,
  },
  {
    id: "mix_catch_5",
    description: "Catch 5 more creatures in the grass",
    target: 5,
    next: "mix_brumble",
    trigger: "grassCatch",
    grantPoolExpand: true,
  },
  {
    id: "mix_brumble",
    description: "Catch a Brumble in the grass",
    target: 1,
    next: "mix_ability_primary",
    trigger: "grassCatch",
    speciesName: "Brumble",
    grantPoolExpand: true,
  },
  {
    id: "mix_ability_primary",
    description: "Catch a creature that has an ability using one of its primary stats",
    target: 1,
    next: "mix_speed_98",
    trigger: "grassCatch",
    requireAlignedAbility: true,
    grantPoolExpand: true,
  },
  {
    id: "mix_speed_98",
    description: "Catch a very fast creature (speed 57+)",
    target: 1,
    next: "mix_catch_8",
    trigger: "grassCatch",
    minSpeed: 57,
    grantPoolExpand: true,
  },
  {
    id: "mix_catch_8",
    description: "Catch 8 more creatures in the grass",
    target: 8,
    next: "mix_battle_2",
    trigger: "grassCatch",
    grantPoolExpand: true,
  },
  {
    id: "mix_battle_2",
    description: "Win 2 more battles (player or bot)",
    target: 2,
    next: "mix_perfect_primary",
    trigger: "battleWin",
    grantPoolExpand: true,
  },
  {
    id: "mix_perfect_primary",
    description: "Catch a creature with perfect primaries (each primary at max for its pole: ±50)",
    target: 1,
    next: "mix_battle_5",
    trigger: "grassCatch",
    requirePerfectPrimary: true,
    grantPoolExpand: true,
  },
  {
    id: "mix_battle_5",
    description: "Win 5 more battles (player or bot) — grass holds every species; discover them in the wild",
    target: 5,
    next: null,
    trigger: "battleWin",
    grantPoolExpand: false,
  },
];

const QUEST_IDS = new Set(QUESTS.map((q) => q.id));
const LEGACY_QUEST_ID_MAP = {
  catch_10: "mix_catch_10",
  battle_1: "mix_battle_1",
  catch_5: "mix_catch_5",
  brumble: "mix_brumble",
  ability_primary: "mix_ability_primary",
  speed_98: "mix_speed_98",
  catch_8: "mix_catch_8",
  battle_2: "mix_battle_2",
  perfect_primary: "mix_perfect_primary",
  battle_5: "mix_battle_5",
  dual_primary: "mix_perfect_primary",
  catch_12: "mix_battle_5",
};

function chainIndex(questId) {
  const i = MIXED_QUEST_CHAIN.indexOf(questId);
  return i === -1 ? 999 : i;
}

function canonicalQuestId(rawQuestId) {
  const raw = String(rawQuestId || "").trim();
  if (!raw) return raw;
  if (QUEST_IDS.has(raw)) return raw;
  const mapped = LEGACY_QUEST_ID_MAP[raw];
  if (mapped && QUEST_IDS.has(mapped)) return mapped;
  const huntMatch = raw.match(/^hunt_(.+)$/i);
  if (huntMatch) {
    const species = huntMatch[1].toLowerCase();
    if (species === "brumble") return "mix_brumble";
    return "mix_catch_10";
  }
  const prefixed = raw.startsWith("mix_") ? raw : `mix_${raw}`;
  return QUEST_IDS.has(prefixed) ? prefixed : raw;
}

function toTitleCaseSlug(raw) {
  return String(raw || "")
    .split(/[_\-\s]+/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase())
    .join(" ");
}

function fallbackQuestDisplay(questId, progress) {
  const raw = String(questId || "").trim();
  const hunt = raw.match(/^hunt_(.+)$/i);
  if (hunt) {
    const species = toTitleCaseSlug(hunt[1]);
    return {
      description: `Catch a ${species} in the grass`,
      target: 1,
    };
  }
  const catchMatch = raw.match(/^catch_(\d+)$/i);
  if (catchMatch) {
    const target = Math.max(1, Number(catchMatch[1]) || 1);
    return {
      description: `Catch ${target} creatures in the grass`,
      target,
    };
  }
  const battleMatch = raw.match(/^battle_(\d+)$/i);
  if (battleMatch) {
    const target = Math.max(1, Number(battleMatch[1]) || 1);
    return {
      description: `Win ${target} battle${target === 1 ? "" : "s"}`,
      target,
    };
  }
  return {
    description: raw || "Quest objective",
    target: Math.max(1, Number(progress) || 0),
  };
}

/** Primary stats at pole cap: right → +50, left → -50 (matches statClamp primary limits). */
function hasPerfectPrimaryStats(creature) {
  if (!creature) return false;
  const p1 = creature.primaryStat1;
  const side1 = creature.primarySide1;
  if (!p1 || !side1) return false;
  const ideal1 = side1 === "right" ? LIMITS.primary.max : LIMITS.primary.min;
  if (Number(creature[p1]) !== ideal1) return false;

  const p2 = creature.primaryStat2;
  const side2 = creature.primarySide2;
  if (p2 && String(p2).trim()) {
    if (!side2) return false;
    const ideal2 = side2 === "right" ? LIMITS.primary.max : LIMITS.primary.min;
    if (Number(creature[p2]) !== ideal2) return false;
  }
  return true;
}

function abilityAlignsWithPrimary(creature) {
  const p1 = (creature.primaryStat1 || "").toLowerCase().trim();
  const p2 = (creature.primaryStat2 || "").toLowerCase().trim();
  const abs = creature.abilities || [];
  for (const a of abs) {
    if (!a || !a.abilityId) continue;
    const s1 = (a.stat1 || "").toLowerCase().trim();
    const s2 = (a.stat2 || "").toLowerCase().trim();
    if (p1 && (s1 === p1 || s2 === p1)) return true;
    if (p2 && (s1 === p2 || s2 === p2)) return true;
  }
  return false;
}

function grassCatchMatches(def, creature) {
  if (!creature) return false;
  if (def.speciesName && String(creature.speciesName).toLowerCase() !== def.speciesName.toLowerCase()) return false;
  if (typeof def.minSpeed === "number" && Number(creature.speed) < def.minSpeed) return false;
  if (def.requireAlignedAbility && !abilityAlignsWithPrimary(creature)) return false;
  if (def.requirePerfectPrimary && !hasPerfectPrimaryStats(creature)) return false;
  return true;
}

class QuestManager {
  getQuestDef(questId) {
    return QUESTS.find((q) => q.id === canonicalQuestId(questId));
  }

  async resetUserQuestProgress(userId) {
    await pool.query("DELETE FROM quest_progress WHERE user_id = $1", [userId]);
    await pool.query(
      "INSERT INTO quest_progress (user_id, quest_id, progress, completed) VALUES ($1, $2, 0, FALSE) ON CONFLICT DO NOTHING",
      [userId, "mix_catch_10"]
    );
    return [{ quest_id: "mix_catch_10", progress: 0, completed: false }];
  }

  async normalizeQuestRows(userId, rows) {
    if (!rows || rows.length === 0) return rows || [];

    const hasLegacyQuestId = rows.some((row) => {
      const raw = String(row.quest_id || "").trim();
      return !QUEST_IDS.has(raw);
    });

    if (hasLegacyQuestId) {
      // Product decision: any legacy/unknown quest ID means a full quest restart.
      return this.resetUserQuestProgress(userId);
    }

    return rows;
  }

  async getActiveQuestId(userId) {
    const result = await pool.query(
      "SELECT quest_id, completed FROM quest_progress WHERE user_id = $1",
      [userId]
    );
    const rows = await this.normalizeQuestRows(userId, result.rows);
    const byId = new Map(rows.map((r) => [r.quest_id, r]));
    for (const qid of MIXED_QUEST_CHAIN) {
      const row = byId.get(qid);
      if (!row || !row.completed) return qid;
    }
    return null;
  }

  async getQuests(userId) {
    const result = await pool.query(
      "SELECT quest_id, progress, completed FROM quest_progress WHERE user_id = $1",
      [userId]
    );
    const rows = await this.normalizeQuestRows(userId, result.rows);

    const quests = rows.map((row) => {
      const def = this.getQuestDef(row.quest_id);
      const fallback = def ? null : fallbackQuestDisplay(row.quest_id, row.progress);
      return {
        questId: row.quest_id,
        description: def ? def.description : fallback.description,
        progress: row.progress,
        target: def ? def.target : fallback.target,
        completed: row.completed,
      };
    });

    quests.sort((a, b) => chainIndex(a.questId) - chainIndex(b.questId));

    if (quests.length === 0) {
      await pool.query(
        "INSERT INTO quest_progress (user_id, quest_id, progress, completed) VALUES ($1, $2, 0, FALSE) ON CONFLICT DO NOTHING",
        [userId, "mix_catch_10"]
      );
      const def = this.getQuestDef("mix_catch_10");
      quests.push({
        questId: "mix_catch_10",
        description: def.description,
        progress: 0,
        target: def.target,
        completed: false,
      });
    }

    return quests;
  }

  async onGrassCatch(player, creature) {
    if (!player?.userId) return;
    const qid = await this.getActiveQuestId(player.userId);
    if (!qid) return;
    const def = this.getQuestDef(qid);
    if (!def || def.trigger !== "grassCatch") return;
    if (!grassCatchMatches(def, creature)) return;
    await this.incrementQuest(player, qid, 1);
  }

  async onBattleWin(player) {
    if (!player?.userId) return;
    const qid = await this.getActiveQuestId(player.userId);
    if (!qid) return;
    const def = this.getQuestDef(qid);
    if (!def || def.trigger !== "battleWin") return;
    await this.incrementQuest(player, qid, 1);
  }

  /** Bump grass pool tier by 1 (max 5). Toast is intentionally vague (1–2 species). */
  async applyGrassPoolReward(player) {
    const cur = await InventoryManager.getGrassUnlockTier(player.userId);
    if (cur >= 5) return;
    const next = cur + 1;
    await InventoryManager.setGrassUnlockTier(player.userId, next);
    player.grassUnlockTier = next;
    player.send({
      type: "grassPoolUnlocked",
      unlockTier: next,
      vagueReward: true,
    });
  }

  async incrementQuest(player, questId, amount) {
    if (!player.userId) return;
    const canonicalId = canonicalQuestId(questId);

    const existing = await pool.query(
      "SELECT progress, completed FROM quest_progress WHERE user_id = $1 AND quest_id = $2",
      [player.userId, canonicalId]
    );

    if (existing.rows.length === 0) return;
    if (existing.rows[0].completed) return;

    const def = this.getQuestDef(canonicalId);
    if (!def) return;

    const newProgress = Math.min(existing.rows[0].progress + amount, def.target);
    const completed = newProgress >= def.target;

    await pool.query(
      "UPDATE quest_progress SET progress = $1, completed = $2 WHERE user_id = $3 AND quest_id = $4",
      [newProgress, completed, player.userId, canonicalId]
    );

    if (completed && def.next) {
      await pool.query(
        "INSERT INTO quest_progress (user_id, quest_id, progress, completed) VALUES ($1, $2, 0, FALSE) ON CONFLICT DO NOTHING",
        [player.userId, def.next]
      );
    }

    if (completed && def.grantPoolExpand) {
      await this.applyGrassPoolReward(player);
    }

    const quests = await this.getQuests(player.userId);
    player.quests = quests;
    player.send({ type: "questUpdated", quests, justCompleted: completed ? canonicalId : null });

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
}

module.exports = QuestManager;
