/**
 * Manual quest reset (same DB wiring as seed.js: DATABASE_URL + initDB).
 *
 *   node clearQuestProgress.js           — delete all quest_progress rows
 *   node clearQuestProgress.js --grass   — also set everyone’s grass unlock_tier to 0
 *
 * After running, each user gets mix_catch_10 again on next world join (see QuestManager.getQuests).
 * Does NOT touch players, creatures, or species (unlike seed.js).
 */
const { pool, initDB } = require("./db");

const resetGrass = process.argv.includes("--grass");

async function main() {
  await initDB();

  const before = await pool.query("SELECT COUNT(*)::int AS c FROM quest_progress");
  await pool.query("DELETE FROM quest_progress");
  console.log(`Deleted ${before.rows[0].c} quest_progress row(s).`);

  if (resetGrass) {
    const g = await pool.query("UPDATE user_grass_progress SET unlock_tier = 0 RETURNING user_id");
    console.log(`Reset grass unlock_tier to 0 for ${g.rowCount} user_grass_progress row(s).`);
  }

  console.log("Done. Rejoin the world in-game to refresh quests.");
  await pool.end();
  process.exit(0);
}

main().catch((err) => {
  console.error("clearQuestProgress failed:", err.message);
  process.exit(1);
});
