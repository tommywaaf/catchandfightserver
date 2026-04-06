/**
 * One-shot: rewrite player_creatures polarity columns to match/equal statClamp rules.
 * Run from repo root: node scripts/persistPolarityClamps.js
 */
const { pool } = require("../db");
const { applyClampsToCreature } = require("../statClamp");

async function main() {
  const r = await pool.query(`
    SELECT pc.*, cs.primary_stat1, cs.primary_side1, cs.primary_stat2, cs.primary_side2
    FROM player_creatures pc
    JOIN creature_species cs ON pc.species_id = cs.id
  `);
  let n = 0;
  for (const row of r.rows) {
    const c = {
      thermal: row.thermal,
      density: row.density,
      luminosity: row.luminosity,
      voltage: row.voltage,
      stability: row.stability,
      magnetism: row.magnetism,
    };
    applyClampsToCreature(c, row);
    await pool.query(
      `UPDATE player_creatures SET thermal=$1,density=$2,luminosity=$3,voltage=$4,stability=$5,magnetism=$6 WHERE id=$7`,
      [c.thermal, c.density, c.luminosity, c.voltage, c.stability, c.magnetism, row.id]
    );
    n++;
  }
  console.log(`Updated polarity stats for ${n} creatures.`);
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
