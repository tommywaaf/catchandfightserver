const { pool } = require("./db");
const InventoryManager = require("./InventoryManager");

const TURN_TIMEOUT_MS = 40000;
const FORCE_SWAP_TIMEOUT_MS = 30000;
const ELO_K = 32;
const ELO_DEFAULT = 1500;

class BattleManager {
  constructor() {
    this.battles = new Map();
    this.playerBattleMap = new Map();
    this.nextBattleId = 1;
  }

  async createBattle(player1, player2, isBot = false) {
    const p1Party = await InventoryManager.getParty(player1.userId);
    let p2Party;
    if (isBot) {
      p2Party = player2.party;
    } else {
      p2Party = await InventoryManager.getParty(player2.userId);
    }

    if (p1Party.length === 0 || p2Party.length === 0) return null;

    const battleId = this.nextBattleId++;
    const p1Name = player1.name || "Player";
    const p2Name = isBot ? "Bot" : (player2.name || "Opponent");

    const battle = {
      id: battleId,
      player1: {
        ref: player1,
        userId: player1.userId,
        name: p1Name,
        party: p1Party.map(cloneBattleCreature),
        activeIndex: 0,
        isBot: false,
      },
      player2: {
        ref: isBot ? null : player2,
        userId: isBot ? "bot" : player2.userId,
        name: p2Name,
        party: p2Party.map(cloneBattleCreature),
        activeIndex: 0,
        isBot,
      },
      turn: 1,
      phase: "choosing",
      pendingActions: { p1: null, p2: null },
      turnTimer: null,
      turnDuration: TURN_TIMEOUT_MS / 1000,
      forceSwapSide: null,
    };

    this.battles.set(battleId, battle);
    this.playerBattleMap.set(player1.userId, battleId);
    player1.inBattle = true;
    player1.battleId = battleId;

    if (!isBot) {
      this.playerBattleMap.set(player2.userId, battleId);
      player2.inBattle = true;
      player2.battleId = battleId;
    }

    player1.send({
      type: "battleStart",
      battleId,
      turnDuration: battle.turnDuration,
      opponentName: p2Name,
      yourParty: battle.player1.party,
      opponentActive: sanitizeOpponent(battle.player2.party[0]),
    });

    if (!isBot) {
      player2.send({
        type: "battleStart",
        battleId,
        turnDuration: battle.turnDuration,
        opponentName: p1Name,
        yourParty: battle.player2.party,
        opponentActive: sanitizeOpponent(battle.player1.party[0]),
      });
    }

    this.startTurnTimer(battle);
    return battle;
  }

  startTurnTimer(battle) {
    if (battle.turnTimer) clearTimeout(battle.turnTimer);
    battle.turnTimer = setTimeout(() => {
      if (battle.phase !== "choosing") return;
      if (!battle.pendingActions.p1) {
        battle.pendingActions.p1 = this.randomAbility(battle.player1);
      }
      if (!battle.pendingActions.p2) {
        if (battle.player2.isBot) {
          battle.pendingActions.p2 = this.botDecision(battle);
        } else {
          battle.pendingActions.p2 = this.randomAbility(battle.player2);
        }
      }
      this.resolveTurn(battle);
    }, TURN_TIMEOUT_MS);
  }

  startForceSwapTimer(battle) {
    if (battle.turnTimer) clearTimeout(battle.turnTimer);
    battle.turnTimer = setTimeout(() => {
      if (battle.phase !== "forceSwapping") return;
      const side = battle.forceSwapSide === "p1" ? battle.player1 : battle.player2;
      const next = findNextAlive(side.party, side.activeIndex);
      if (next !== -1) {
        this.completeForceSwap(battle, battle.forceSwapSide, next);
      }
    }, FORCE_SWAP_TIMEOUT_MS);
  }

  randomAbility(side) {
    const creature = side.party[side.activeIndex];
    if (!creature || !creature.abilities) return { action: "ability", abilitySlot: 0 };
    const validSlots = [];
    for (let i = 0; i < creature.abilities.length; i++) {
      if (creature.abilities[i] && creature.abilities[i].abilityId) validSlots.push(i);
    }
    if (validSlots.length === 0) return { action: "ability", abilitySlot: 0 };
    return { action: "ability", abilitySlot: validSlots[Math.floor(Math.random() * validSlots.length)] };
  }

  submitAction(battleId, userId, msg) {
    const battle = this.battles.get(battleId);
    if (!battle) return;

    console.log(`[Battle ${battleId}] submitAction from ${userId}: action=${msg.action}, phase=${battle.phase}`);

    if (battle.phase === "forceSwapping") {
      if (msg.action !== "swap" && msg.action !== "forceSwap") {
        console.log(`[Battle ${battleId}] Ignoring non-swap action during forceSwapping`);
        return;
      }
      const expectedSide = battle.forceSwapSide;
      const isP1 = userId === battle.player1.userId;
      if ((expectedSide === "p1" && !isP1) || (expectedSide === "p2" && isP1)) {
        console.log(`[Battle ${battleId}] Wrong player trying to force swap`);
        return;
      }

      const creatureIndex = Math.min(4, Math.max(0, Number(msg.creatureIndex) || 0));
      const side = isP1 ? battle.player1 : battle.player2;
      if (creatureIndex === side.activeIndex) return;
      if (side.party[creatureIndex].currentHp <= 0) return;

      this.completeForceSwap(battle, expectedSide, creatureIndex);
      return;
    }

    if (battle.phase !== "choosing") {
      console.log(`[Battle ${battleId}] Ignoring action, phase is ${battle.phase}`);
      return;
    }

    const action = {
      action: msg.action === "swap" ? "swap" : "ability",
      abilitySlot: msg.action === "swap" ? undefined : Math.min(3, Math.max(0, Number(msg.abilitySlot) || 0)),
      creatureIndex: msg.action === "swap" ? Math.min(4, Math.max(0, Number(msg.creatureIndex) || 0)) : undefined,
    };

    if (action.action === "swap") {
      const side = userId === battle.player1.userId ? battle.player1 : battle.player2;
      if (action.creatureIndex === side.activeIndex) return;
      if (side.party[action.creatureIndex].currentHp <= 0) return;
    }

    if (userId === battle.player1.userId) {
      battle.pendingActions.p1 = action;
    } else if (userId === battle.player2.userId) {
      battle.pendingActions.p2 = action;
    }

    if (battle.player2.isBot && battle.pendingActions.p1 && !battle.pendingActions.p2) {
      battle.pendingActions.p2 = this.botDecision(battle);
    }

    if (battle.pendingActions.p1 && battle.pendingActions.p2) {
      this.resolveTurn(battle);
    }
  }

  completeForceSwap(battle, side, creatureIndex) {
    console.log(`[Battle ${battle.id}] Force swap complete: ${side} -> creature ${creatureIndex}`);
    if (battle.turnTimer) clearTimeout(battle.turnTimer);

    const sideObj = side === "p1" ? battle.player1 : battle.player2;
    sideObj.activeIndex = creatureIndex;
    battle.forceSwapSide = null;

    battle.player1.ref.send({
      type: "forceSwapComplete",
      side,
      creatureIndex,
      yourActive: { index: battle.player1.activeIndex, creature: battle.player1.party[battle.player1.activeIndex] },
      opponentActive: { index: battle.player2.activeIndex, creature: sanitizeOpponent(battle.player2.party[battle.player2.activeIndex]) },
      yourParty: battle.player1.party,
    });

    if (!battle.player2.isBot && battle.player2.ref) {
      battle.player2.ref.send({
        type: "forceSwapComplete",
        side: side === "p1" ? "p2" : "p1",
        creatureIndex,
        yourActive: { index: battle.player2.activeIndex, creature: battle.player2.party[battle.player2.activeIndex] },
        opponentActive: { index: battle.player1.activeIndex, creature: sanitizeOpponent(battle.player1.party[battle.player1.activeIndex]) },
        yourParty: battle.player2.party,
      });
    }

    battle.turn++;
    battle.phase = "choosing";
    battle.pendingActions = { p1: null, p2: null };
    this.startTurnTimer(battle);
  }

  resolveTurn(battle) {
    if (battle.turnTimer) clearTimeout(battle.turnTimer);
    battle.phase = "resolving";

    const p1Action = battle.pendingActions.p1;
    const p2Action = battle.pendingActions.p2;
    const events = [];

    if (p1Action.action === "swap") {
      battle.player1.activeIndex = p1Action.creatureIndex;
      events.push({ side: "p1", event: "swap", creatureIndex: p1Action.creatureIndex });
    }
    if (p2Action.action === "swap") {
      battle.player2.activeIndex = p2Action.creatureIndex;
      events.push({ side: "p2", event: "swap", creatureIndex: p2Action.creatureIndex });
    }

    if (p1Action.action === "ability" && p2Action.action === "ability") {
      const p1Creature = battle.player1.party[battle.player1.activeIndex];
      const p2Creature = battle.player2.party[battle.player2.activeIndex];
      const p1Ability = p1Creature.abilities[p1Action.abilitySlot];
      const p2Ability = p2Creature.abilities[p2Action.abilitySlot];

      if (!p1Ability || !p2Ability) {
        this.endBattle(battle, null);
        return;
      }

      const p1Init = calcInitiative(p1Creature.speed, p1Ability.abilitySpeed);
      const p2Init = calcInitiative(p2Creature.speed, p2Ability.abilitySpeed);

      let first, second;
      if (p1Init > p2Init) {
        first = "p1"; second = "p2";
      } else if (p2Init > p1Init) {
        first = "p2"; second = "p1";
      } else {
        if (p1Creature.speed > p2Creature.speed) { first = "p1"; second = "p2"; }
        else if (p2Creature.speed > p1Creature.speed) { first = "p2"; second = "p1"; }
        else {
          const p1StatVal = p1Creature[p1Ability.stat1] || 0;
          const p2StatVal = p2Creature[p2Ability.stat1] || 0;
          if (p1StatVal > p2StatVal) { first = "p1"; second = "p2"; }
          else if (p2StatVal > p1StatVal) { first = "p2"; second = "p1"; }
          else { first = Math.random() < 0.5 ? "p1" : "p2"; second = first === "p1" ? "p2" : "p1"; }
        }
      }

      const sides = { p1: battle.player1, p2: battle.player2 };
      const abilities = { p1: p1Ability, p2: p2Ability };

      const firstResult = applyDamage(
        sides[first].party[sides[first].activeIndex],
        abilities[first],
        sides[second].party[sides[second].activeIndex]
      );
      events.push({ side: first, event: "ability", ability: abilities[first].name, damage: firstResult.damage, multiplier: firstResult.multiplier });

      const defenderAfterFirst = sides[second].party[sides[second].activeIndex];
      if (defenderAfterFirst.currentHp <= 0) {
        events.push({ side: second, event: "faint", creatureIndex: sides[second].activeIndex });
        const nextAlive = findNextAlive(sides[second].party, sides[second].activeIndex);
        if (nextAlive === -1) {
          events.push({ side: second, event: "defeated" });
        } else {
          events.push({ side: second, event: "needsSwap" });
        }
      } else {
        const secondResult = applyDamage(
          sides[second].party[sides[second].activeIndex],
          abilities[second],
          sides[first].party[sides[first].activeIndex]
        );
        events.push({ side: second, event: "ability", ability: abilities[second].name, damage: secondResult.damage, multiplier: secondResult.multiplier });

        const defenderAfterSecond = sides[first].party[sides[first].activeIndex];
        if (defenderAfterSecond.currentHp <= 0) {
          events.push({ side: first, event: "faint", creatureIndex: sides[first].activeIndex });
          const nextAlive = findNextAlive(sides[first].party, sides[first].activeIndex);
          if (nextAlive === -1) {
            events.push({ side: first, event: "defeated" });
          } else {
            events.push({ side: first, event: "needsSwap" });
          }
        }
      }
    } else if (p1Action.action === "ability") {
      const p1Creature = battle.player1.party[battle.player1.activeIndex];
      const p1Ability = p1Creature.abilities[p1Action.abilitySlot];
      if (p1Ability) {
        const result = applyDamage(p1Creature, p1Ability, battle.player2.party[battle.player2.activeIndex]);
        events.push({ side: "p1", event: "ability", ability: p1Ability.name, damage: result.damage, multiplier: result.multiplier });
        if (battle.player2.party[battle.player2.activeIndex].currentHp <= 0) {
          events.push({ side: "p2", event: "faint", creatureIndex: battle.player2.activeIndex });
          const next = findNextAlive(battle.player2.party, battle.player2.activeIndex);
          if (next === -1) events.push({ side: "p2", event: "defeated" });
          else events.push({ side: "p2", event: "needsSwap" });
        }
      }
    } else if (p2Action.action === "ability") {
      const p2Creature = battle.player2.party[battle.player2.activeIndex];
      const p2Ability = p2Creature.abilities[p2Action.abilitySlot];
      if (p2Ability) {
        const result = applyDamage(p2Creature, p2Ability, battle.player1.party[battle.player1.activeIndex]);
        events.push({ side: "p2", event: "ability", ability: p2Ability.name, damage: result.damage, multiplier: result.multiplier });
        if (battle.player1.party[battle.player1.activeIndex].currentHp <= 0) {
          events.push({ side: "p1", event: "faint", creatureIndex: battle.player1.activeIndex });
          const next = findNextAlive(battle.player1.party, battle.player1.activeIndex);
          if (next === -1) events.push({ side: "p1", event: "defeated" });
          else events.push({ side: "p1", event: "needsSwap" });
        }
      }
    }

    const p1Defeated = events.some(e => e.side === "p1" && e.event === "defeated");
    const p2Defeated = events.some(e => e.side === "p2" && e.event === "defeated");
    const p1NeedsSwap = events.some(e => e.side === "p1" && e.event === "needsSwap");
    const p2NeedsSwap = events.some(e => e.side === "p2" && e.event === "needsSwap");

    battle.player1.ref.send({
      type: "battleTurnResult",
      turn: battle.turn,
      events,
      yourActive: { index: battle.player1.activeIndex, creature: battle.player1.party[battle.player1.activeIndex] },
      opponentActive: { index: battle.player2.activeIndex, creature: sanitizeOpponent(battle.player2.party[battle.player2.activeIndex]) },
      yourParty: battle.player1.party,
    });

    if (!battle.player2.isBot && battle.player2.ref) {
      const p2Events = events.map(e => ({
        ...e,
        side: e.side === "p1" ? "p2" : e.side === "p2" ? "p1" : e.side,
      }));
      battle.player2.ref.send({
        type: "battleTurnResult",
        turn: battle.turn,
        events: p2Events,
        yourActive: { index: battle.player2.activeIndex, creature: battle.player2.party[battle.player2.activeIndex] },
        opponentActive: { index: battle.player1.activeIndex, creature: sanitizeOpponent(battle.player1.party[battle.player1.activeIndex]) },
        yourParty: battle.player2.party,
      });
    }

    if (p1Defeated || p2Defeated) {
      let winner;
      if (p1Defeated && p2Defeated) winner = "draw";
      else if (p1Defeated) winner = "p2";
      else winner = "p1";
      this.endBattle(battle, winner);
      return;
    }

    if (p1NeedsSwap || p2NeedsSwap) {
      const swapSide = p1NeedsSwap ? "p1" : "p2";
      battle.phase = "forceSwapping";
      battle.forceSwapSide = swapSide;

      const swapperSide = swapSide === "p1" ? battle.player1 : battle.player2;

      if (swapperSide.isBot) {
        const next = findNextAlive(swapperSide.party, swapperSide.activeIndex);
        if (next !== -1) {
          setTimeout(() => this.completeForceSwap(battle, swapSide, next), 500);
        }
      } else {
        swapperSide.ref.send({
          type: "forceSwapRequired",
          party: swapperSide.party,
        });

        const otherSide = swapSide === "p1" ? battle.player2 : battle.player1;
        if (!otherSide.isBot && otherSide.ref) {
          otherSide.ref.send({ type: "waitingForSwap" });
        }

        this.startForceSwapTimer(battle);
      }
      return;
    }

    battle.turn++;
    battle.phase = "choosing";
    battle.pendingActions = { p1: null, p2: null };
    this.startTurnTimer(battle);
  }

  async endBattle(battle, winner) {
    if (battle.turnTimer) clearTimeout(battle.turnTimer);

    let p1EloChange = 0, p2EloChange = 0, p1NewElo = 0, p2NewElo = 0;
    const isPvp = !battle.player2.isBot;

    if (isPvp && winner) {
      try {
        const p1Elo = await getPlayerElo(battle.player1.userId);
        const p2Elo = await getPlayerElo(battle.player2.userId);

        if (winner === "draw") {
          p1EloChange = calcEloChange(p1Elo, p2Elo, 0.5);
          p2EloChange = calcEloChange(p2Elo, p1Elo, 0.5);
        } else if (winner === "p1") {
          p1EloChange = calcEloChange(p1Elo, p2Elo, 1);
          p2EloChange = calcEloChange(p2Elo, p1Elo, 0);
        } else {
          p1EloChange = calcEloChange(p1Elo, p2Elo, 0);
          p2EloChange = calcEloChange(p2Elo, p1Elo, 1);
        }

        p1NewElo = Math.max(100, p1Elo + p1EloChange);
        p2NewElo = Math.max(100, p2Elo + p2EloChange);

        await pool.query("UPDATE users SET elo = $1 WHERE id = $2", [p1NewElo, battle.player1.userId]);
        await pool.query("UPDATE users SET elo = $1 WHERE id = $2", [p2NewElo, battle.player2.userId]);
      } catch (err) {
        console.error("ELO update error:", err.message);
      }
    }

    battle.player1.ref.send({
      type: "battleEnd",
      winner: winner || "draw",
      opponentName: battle.player2.name,
      eloChange: p1EloChange,
      newElo: p1NewElo,
      isBot: battle.player2.isBot,
    });
    battle.player1.ref.inBattle = false;
    battle.player1.ref.battleId = null;
    this.playerBattleMap.delete(battle.player1.userId);

    if (!battle.player2.isBot && battle.player2.ref) {
      battle.player2.ref.send({
        type: "battleEnd",
        winner: winner === "p1" ? "p2" : winner === "p2" ? "p1" : "draw",
        opponentName: battle.player1.name,
        eloChange: p2EloChange,
        newElo: p2NewElo,
        isBot: false,
      });
      battle.player2.ref.inBattle = false;
      battle.player2.ref.battleId = null;
      this.playerBattleMap.delete(battle.player2.userId);
    }

    this.battles.delete(battle.id);

    if (winner && winner !== "draw") {
      const winnerSide = winner === "p1" ? battle.player1 : battle.player2;
      if (!winnerSide.isBot && winnerSide.ref && typeof battle.questOnHumanWin === "function") {
        battle.questOnHumanWin(winnerSide.ref);
      }
    }
  }

  forfeit(battleId, userId) {
    const battle = this.battles.get(battleId);
    if (!battle) return;
    const winner = userId === battle.player1.userId ? "p2" : "p1";
    this.endBattle(battle, winner);
  }

  botDecision(battle) {
    const botCreature = battle.player2.party[battle.player2.activeIndex];
    const validSlots = [];
    if (botCreature && botCreature.abilities) {
      for (let i = 0; i < botCreature.abilities.length; i++) {
        if (botCreature.abilities[i] && botCreature.abilities[i].abilityId) validSlots.push(i);
      }
    }
    if (validSlots.length === 0) return { action: "ability", abilitySlot: 0 };
    return { action: "ability", abilitySlot: validSlots[Math.floor(Math.random() * validSlots.length)] };
  }
}

function calcInitiative(creatureSpeed, abilitySpeed) {
  return (creatureSpeed * 0.7) + (abilitySpeed * 0.3);
}

function calcDamage(attacker, ability, defender) {
  const stats = ["thermal", "density", "luminosity", "voltage", "stability", "magnetism"];
  let totalDist = 0;
  if (ability.stat1 && stats.includes(ability.stat1)) {
    totalDist += Math.abs((attacker[ability.stat1] || 0) - (defender[ability.stat1] || 0)) / 100;
  }
  if (ability.stat2 && stats.includes(ability.stat2)) {
    totalDist += Math.abs((attacker[ability.stat2] || 0) - (defender[ability.stat2] || 0)) / 100;
  }
  const multiplier = Math.max(0.1, Math.min(4.0, 2.0 * totalDist));
  return Math.round((ability.baseDamage || 100) * multiplier);
}

function applyDamage(attacker, ability, defender) {
  const damage = calcDamage(attacker, ability, defender);
  defender.currentHp = Math.max(0, defender.currentHp - damage);
  return { damage, multiplier: damage / (ability.baseDamage || 100) };
}

function findNextAlive(party, currentIndex) {
  for (let i = 0; i < party.length; i++) {
    if (i !== currentIndex && party[i].currentHp > 0) return i;
  }
  return -1;
}

function sanitizeOpponent(creature) {
  if (!creature) return null;
  return {
    speciesName: creature.speciesName,
    nickname: creature.nickname,
    currentHp: creature.currentHp,
    maxHp: creature.maxHp,
  };
}

function cloneBattleCreature(c) {
  return { ...c, abilities: c.abilities ? [...c.abilities] : [] };
}

async function getPlayerElo(userId) {
  const r = await pool.query("SELECT elo FROM users WHERE id = $1", [userId]);
  return r.rows.length > 0 ? r.rows[0].elo : ELO_DEFAULT;
}

function calcEloChange(myElo, oppElo, score) {
  const expected = 1 / (1 + Math.pow(10, (oppElo - myElo) / 400));
  return Math.round(ELO_K * (score - expected));
}

module.exports = BattleManager;
