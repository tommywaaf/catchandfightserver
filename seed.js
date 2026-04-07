const { pool, initDB } = require("./db");

const SPECIES_DEFS = [
  { name: "Flaro", stat1: "thermal", stat1Side: "right", stat2: "luminosity", stat2Side: "right", weight: 14, tier: 0 },
  { name: "Pebbo", stat1: "density", stat1Side: "right", stat2: "stability", stat2Side: "right", weight: 14, tier: 0 },
  { name: "Glimmi", stat1: "luminosity", stat1Side: "right", stat2: null, stat2Side: null, weight: 12, tier: 0 },
  { name: "Zappup", stat1: "voltage", stat1Side: "right", stat2: null, stat2Side: null, weight: 10, tier: 0 },
  { name: "Mossit", stat1: "stability", stat1Side: "right", stat2: null, stat2Side: null, weight: 10, tier: 0 },
  { name: "Brumble", stat1: "stability", stat1Side: "right", stat2: "density", stat2Side: "right", weight: 9, tier: 0 },
  { name: "Drifin", stat1: "stability", stat1Side: "left", stat2: "luminosity", stat2Side: "left", weight: 9, tier: 0 },
  { name: "Splashy", stat1: "stability", stat1Side: "left", stat2: null, stat2Side: null, weight: 8, tier: 0 },
  { name: "Niblet", stat1: "density", stat1Side: "right", stat2: "luminosity", stat2Side: "right", weight: 7, tier: 0 },
  { name: "Chilloo", stat1: "thermal", stat1Side: "left", stat2: "stability", stat2Side: "right", weight: 7, tier: 0 },
  { name: "Muddo", stat1: "density", stat1Side: "right", stat2: null, stat2Side: null, weight: 6, tier: 1 },
  { name: "Wickit", stat1: "thermal", stat1Side: "right", stat2: "stability", stat2Side: "right", weight: 6, tier: 1 },
  { name: "Sparko", stat1: "voltage", stat1Side: "right", stat2: "luminosity", stat2Side: "right", weight: 5, tier: 1 },
  { name: "Fluffet", stat1: "stability", stat1Side: "right", stat2: null, stat2Side: null, weight: 5, tier: 1 },
  { name: "Thorny", stat1: "stability", stat1Side: "right", stat2: "density", stat2Side: "right", weight: 4, tier: 2 },
  { name: "Ripple", stat1: "magnetism", stat1Side: "right", stat2: "stability", stat2Side: "left", weight: 4, tier: 2 },
  { name: "Craglet", stat1: "density", stat1Side: "right", stat2: "stability", stat2Side: "right", weight: 4, tier: 2 },
  { name: "Blinko", stat1: "luminosity", stat1Side: "right", stat2: null, stat2Side: null, weight: 3, tier: 2 },
  { name: "Hushit", stat1: "stability", stat1Side: "left", stat2: null, stat2Side: null, weight: 3, tier: 3 },
  { name: "Coilin", stat1: "magnetism", stat1Side: "right", stat2: "voltage", stat2Side: "right", weight: 3, tier: 3 },
  { name: "Puffox", stat1: "stability", stat1Side: "left", stat2: "luminosity", stat2Side: "left", weight: 2, tier: 3 },
  { name: "Daplet", stat1: "luminosity", stat1Side: "right", stat2: "stability", stat2Side: "right", weight: 2, tier: 3 },
  { name: "Frozzle", stat1: "thermal", stat1Side: "left", stat2: "density", stat2Side: "right", weight: 2, tier: 4 },
  { name: "Gleamo", stat1: "luminosity", stat1Side: "right", stat2: "voltage", stat2Side: "right", weight: 2, tier: 4 },
  { name: "Skitter", stat1: "density", stat1Side: "right", stat2: "magnetism", stat2Side: "left", weight: 1, tier: 4 },
  { name: "Charby", stat1: "thermal", stat1Side: "right", stat2: "luminosity", stat2Side: "right", weight: 1, tier: 4 },
  { name: "Puddle", stat1: "stability", stat1Side: "left", stat2: null, stat2Side: null, weight: 1, tier: 5 },
  { name: "Bouldi", stat1: "density", stat1Side: "right", stat2: null, stat2Side: null, weight: 1, tier: 5 },
  { name: "Twinkl", stat1: "luminosity", stat1Side: "right", stat2: null, stat2Side: null, weight: 1, tier: 5 },
];

const ABILITIES = [
  // Single-stat abilities
  { name: "Thermal Lash", speed: 60, stat1: "thermal", stat2: null, desc: "A searing whip of heat" },
  { name: "Freeze Snap", speed: 45, stat1: "thermal", stat2: null, desc: "Flash-freeze burst" },
  { name: "Density Crush", speed: 30, stat1: "density", stat2: null, desc: "Compresses mass into a slam" },
  { name: "Phase Shift", speed: 70, stat1: "density", stat2: null, desc: "Shifts between gas and solid" },
  { name: "Lumen Blast", speed: 55, stat1: "luminosity", stat2: null, desc: "A burst of blinding light" },
  { name: "Shadow Veil", speed: 65, stat1: "luminosity", stat2: null, desc: "Wraps in consuming darkness" },
  { name: "Volt Strike", speed: 75, stat1: "voltage", stat2: null, desc: "An electric discharge" },
  { name: "Ground Pulse", speed: 35, stat1: "voltage", stat2: null, desc: "Grounding shockwave" },
  { name: "Chaos Burst", speed: 80, stat1: "stability", stat2: null, desc: "Unleashes unstable energy" },
  { name: "Control Lock", speed: 40, stat1: "stability", stat2: null, desc: "Locks target in stasis" },
  { name: "Repel Wave", speed: 50, stat1: "magnetism", stat2: null, desc: "Pushes away with force" },
  { name: "Attract Pull", speed: 55, stat1: "magnetism", stat2: null, desc: "Draws target inward" },

  // Dual-stat abilities
  { name: "Solar Crush", speed: 45, stat1: "thermal", stat2: "luminosity", desc: "Concentrated solar energy" },
  { name: "Storm Pull", speed: 60, stat1: "voltage", stat2: "magnetism", desc: "Magnetic lightning vortex" },
  { name: "Frozen Stone", speed: 25, stat1: "thermal", stat2: "density", desc: "Ice encased in rock" },
  { name: "Dark Current", speed: 70, stat1: "luminosity", stat2: "voltage", desc: "Shadow-charged electricity" },
  { name: "Chaos Flame", speed: 85, stat1: "thermal", stat2: "stability", desc: "Unstable fire eruption" },
  { name: "Magnet Crush", speed: 30, stat1: "density", stat2: "magnetism", desc: "Magnetic compression" },
  { name: "Void Collapse", speed: 20, stat1: "luminosity", stat2: "density", desc: "Gravity well of darkness" },
  { name: "Static Field", speed: 50, stat1: "voltage", stat2: "stability", desc: "Charged control barrier" },
  { name: "Plasma Bolt", speed: 75, stat1: "thermal", stat2: "voltage", desc: "Superheated electric plasma" },
  { name: "Gravity Shift", speed: 40, stat1: "density", stat2: "stability", desc: "Warps local gravity" },
  { name: "Bright Lure", speed: 65, stat1: "luminosity", stat2: "magnetism", desc: "Dazzling attraction beam" },
  { name: "Tidal Charge", speed: 55, stat1: "magnetism", stat2: "stability", desc: "Charged magnetic tide" },
  { name: "Frost Circuit", speed: 50, stat1: "thermal", stat2: "magnetism", desc: "Frozen magnetic field" },
  { name: "Quake Spark", speed: 35, stat1: "density", stat2: "voltage", desc: "Ground-shaking discharge" },
  { name: "Prism Break", speed: 60, stat1: "luminosity", stat2: "stability", desc: "Shattered light shards" },
  { name: "Iron Shade", speed: 45, stat1: "density", stat2: "luminosity", desc: "Dense shadow projectile" },
  { name: "Chaos Magnet", speed: 90, stat1: "stability", stat2: "magnetism", desc: "Unstable magnetic field" },
  { name: "Thunder Dark", speed: 80, stat1: "voltage", stat2: "luminosity", desc: "Lightning from the void" },
];

async function seed() {
  await initDB();
  console.log("Resetting species/ability data...");
  await pool.query("TRUNCATE TABLE species_abilities RESTART IDENTITY CASCADE");
  await pool.query("TRUNCATE TABLE creature_abilities RESTART IDENTITY CASCADE");
  await pool.query("TRUNCATE TABLE player_creatures RESTART IDENTITY CASCADE");
  await pool.query("TRUNCATE TABLE user_species_discovery RESTART IDENTITY CASCADE");
  await pool.query("TRUNCATE TABLE abilities RESTART IDENTITY CASCADE");
  await pool.query("TRUNCATE TABLE creature_species RESTART IDENTITY CASCADE");

  console.log("Seeding abilities...");
  const abilityIds = [];
  const abilityStatMap = [];
  for (const ab of ABILITIES) {
    const r = await pool.query(
      "INSERT INTO abilities (name, base_damage, ability_speed, stat1, stat2, description) VALUES ($1, 100, $2, $3, $4, $5) RETURNING id",
      [ab.name, ab.speed, ab.stat1, ab.stat2, ab.desc]
    );
    abilityIds.push(r.rows[0].id);
    abilityStatMap.push({ id: r.rows[0].id, stat1: ab.stat1, stat2: ab.stat2 });
  }
  console.log(`Seeded ${abilityIds.length} abilities`);

  console.log("Seeding named creature species...");
  for (const spec of SPECIES_DEFS) {
    const ranges = buildSpeciesRanges(spec);
    const speed = buildBaseSpeed(spec.name);

    const r = await pool.query(
      `INSERT INTO creature_species
       (name, base_hp, base_speed, primary_min, nonprimary_max, primary_stat1, primary_side1, primary_stat2, primary_side2, find_weight, grass_unlock_tier)
       VALUES ($1, 500, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        spec.name,
        speed,
        ranges.primaryMin,
        ranges.nonprimaryMax,
        spec.stat1,
        spec.stat1Side,
        spec.stat2,
        spec.stat2Side,
        spec.weight,
        spec.tier,
      ]
    );
    const speciesId = r.rows[0].id;
    const dominant1 = spec.stat1;
    const dominant2 = spec.stat2;

    const compatibleAbilities = abilityStatMap.filter(
      (a) => a.stat1 === dominant1 || a.stat1 === dominant2 || a.stat2 === dominant1 || a.stat2 === dominant2
    );

    const shuffled = [...compatibleAbilities].sort(() => Math.random() - 0.5);
    const generalPool = abilityStatMap.filter(a => !shuffled.includes(a)).sort(() => Math.random() - 0.5);
    const selected = [...shuffled.slice(0, 5), ...generalPool.slice(0, 3)].slice(0, 8);

    if (selected.length < 4) {
      const remaining = abilityStatMap.filter(a => !selected.find(s => s.id === a.id)).sort(() => Math.random() - 0.5);
      while (selected.length < 4 && remaining.length > 0) {
        selected.push(remaining.shift());
      }
    }

    for (const ab of selected) {
      await pool.query(
        "INSERT INTO species_abilities (species_id, ability_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [speciesId, ab.id]
      );
    }
  }
  console.log(`Seeded ${SPECIES_DEFS.length} creature species with abilities`);

  console.log("Seed complete!");
  process.exit(0);
}

function hashNumber(text, mod) {
  let hash = 0;
  for (let i = 0; i < text.length; i++) {
    hash = (hash * 31 + text.charCodeAt(i)) >>> 0;
  }
  return hash % mod;
}

function buildSpeciesRanges(spec) {
  const primaryMin = 1 + hashNumber(`${spec.name}:primaryMin`, 20);
  const nonprimaryMax = 15 + hashNumber(`${spec.name}:npMax`, 16);
  return { primaryMin, nonprimaryMax };
}

function buildBaseSpeed(name) {
  return 24 + hashNumber(`speed:${name}`, 42);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});
