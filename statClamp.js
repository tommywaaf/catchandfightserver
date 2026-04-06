/**
 * Polarity stats: further from 0 = stronger in that direction.
 * Primary stats (species primary_stat1/2): range [-50, 50], cannot cross toward the wrong pole (left ≤ -1, right ≥ 1).
 * Non-primary stats: range [-30, 30].
 * (Not ±100 — if you see values past these, data predates clamps or bypassed roll logic.)
 */
const ELEMENTAL_STATS = ["thermal", "density", "luminosity", "voltage", "stability", "magnetism"];

const LIMITS = {
  primary: { min: -50, max: 50 },
  nonPrimary: { min: -30, max: 30 },
};

const PRIMARY_FLOOR = { right: 1, left: -1 };

function isPrimaryStat(species, statName) {
  const s1 = species.primary_stat1 || species.primaryStat1;
  const s2 = species.primary_stat2 || species.primaryStat2;
  return s1 === statName || s2 === statName;
}

function getPrimarySide(species, statName) {
  if ((species.primary_stat1 || species.primaryStat1) === statName) {
    return species.primary_side1 || species.primarySide1;
  }
  if ((species.primary_stat2 || species.primaryStat2) === statName) {
    return species.primary_side2 || species.primarySide2;
  }
  return null;
}

function clampElemental(v, isPrimary, primarySide) {
  const min = isPrimary ? LIMITS.primary.min : LIMITS.nonPrimary.min;
  const max = isPrimary ? LIMITS.primary.max : LIMITS.nonPrimary.max;
  let clamped = Math.max(min, Math.min(max, Math.round(Number(v) || 0)));
  if (isPrimary && primarySide && PRIMARY_FLOOR[primarySide] !== undefined) {
    const floor = PRIMARY_FLOOR[primarySide];
    clamped = primarySide === "left" ? Math.min(clamped, floor) : Math.max(clamped, floor);
  }
  return clamped;
}

/** Mutates creature (camelCase keys) using species row (snake_case primary_* from JOIN). */
function applyClampsToCreature(creature, speciesRow) {
  const species = {
    primary_stat1: speciesRow.primary_stat1,
    primary_side1: speciesRow.primary_side1,
    primary_stat2: speciesRow.primary_stat2,
    primary_side2: speciesRow.primary_side2,
  };
  for (const stat of ELEMENTAL_STATS) {
    const isP = isPrimaryStat(species, stat);
    const side = getPrimarySide(species, stat);
    creature[stat] = clampElemental(creature[stat], isP, side);
  }
}

module.exports = {
  ELEMENTAL_STATS,
  LIMITS,
  isPrimaryStat,
  getPrimarySide,
  clampElemental,
  applyClampsToCreature,
};
