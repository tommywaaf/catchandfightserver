const WebSocket = require("ws");
const Player = require("./Player");
const WorldManager = require("./WorldManager");
const { initDB, pool } = require("./db");
const authManager = require("./AuthManager");
const InventoryManager = require("./InventoryManager");
const EncounterManager = require("./EncounterManager");
const QuestManager = require("./QuestManager");
const BattleManager = require("./BattleManager");
const MatchmakingManager = require("./MatchmakingManager");
const TradeManager = require("./TradeManager");

const port = process.env.PORT || 8080;
const TICK_RATE_MS = 50;
const HEARTBEAT_INTERVAL_MS = 30000;

let wss;
const worldManager = new WorldManager();
const players = new Map();
const authenticatedPlayers = new Map();

const encounterManager = new EncounterManager();
const questManager = new QuestManager();
const battleManager = new BattleManager();
const matchmakingManager = new MatchmakingManager(battleManager);
const tradeManager = new TradeManager();

async function start() {
  await initDB();
  await encounterManager.loadSpeciesData();
  matchmakingManager.setQuestManager(questManager);

  wss = new WebSocket.Server({ port });
  console.log(`CatchAndFight server running on port ${port}`);

  wss.on("connection", (ws) => {
    const player = new Player(ws);
    players.set(ws, player);
    console.log(`Player connected: ${player.id} (${players.size} total)`);

    ws.isAlive = true;
    ws.on("pong", () => { ws.isAlive = true; });

    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      handleMessage(player, msg);
    });

    ws.on("close", () => {
      handleDisconnect(player);
    });

    ws.on("error", (err) => {
      console.error(`Socket error for ${player.id}:`, err.message);
    });
  });

  setInterval(() => tick(), TICK_RATE_MS);

  setInterval(() => {
    wss.clients.forEach((ws) => {
      if (!ws.isAlive) {
        const player = players.get(ws);
        if (player) handleDisconnect(player);
        return ws.terminate();
      }
      ws.isAlive = false;
      ws.ping();
    });
  }, HEARTBEAT_INTERVAL_MS);
}

function handleMessage(player, msg) {
  switch (msg.type) {
    case "register":
      handleRegister(player, msg);
      break;
    case "login":
      handleLogin(player, msg);
      break;
    case "join":
      handleJoin(player, msg);
      break;
    case "move":
      handleMove(player, msg);
      break;
    case "switchWorld":
      handleSwitchWorld(player, msg);
      break;
    case "ping":
      player.send({ type: "pong" });
      break;
    case "grassStatus":
      handleGrassStatus(player, msg);
      break;
    case "getParty":
      handleGetParty(player);
      break;
    case "getStorage":
      handleGetStorage(player, msg);
      break;
    case "partySwap":
      handlePartySwap(player, msg);
      break;
    case "storageSwap":
      handleStorageSwap(player, msg);
      break;
    case "partyReorder":
      handlePartyReorder(player, msg);
      break;
    case "releaseCreature":
      handleReleaseCreature(player, msg);
      break;
    case "replaceCreature":
      handleReplaceCreature(player, msg);
      break;
    case "battleAction":
      handleBattleAction(player, msg);
      break;
    case "findBattle":
      handleFindBattle(player);
      break;
    case "getLeaderboard":
      handleGetLeaderboard(player);
      break;
    case "cancelMatchmaking":
      handleCancelMatchmaking(player);
      break;
    case "tradeRequest":
      handleTradeRequest(player, msg);
      break;
    case "tradeResponse":
      handleTradeResponse(player, msg);
      break;
    case "tradeOffer":
      handleTradeOffer(player, msg);
      break;
    case "tradeConfirm":
      handleTradeConfirm(player);
      break;
    case "tradeCancel":
      handleTradeCancel(player);
      break;
    case "chat":
      handleChat(player, msg);
      break;
  }
}

function handleChat(player, msg) {
  if (!player.authenticated || player.worldId === null) return;
  const raw = typeof msg.text === "string" ? msg.text : "";
  const text = raw.replace(/[\x00-\x1f\x7f]/g, "").trim().slice(0, 256);
  if (!text) return;
  const world = worldManager.getWorld(player.worldId);
  if (!world) return;
  const senderName = String(player.name || "Player").slice(0, 32);
  world.broadcast({
    type: "chat",
    senderId: player.id,
    senderName,
    text,
  });
}

async function handleRegister(player, msg) {
  const result = await authManager.register(msg.username, msg.password);
  if (result.success) {
    player.userId = result.userId;
    player.authenticated = true;
    player.name = result.username;
    authenticatedPlayers.set(result.userId, player);
    player.send({ type: "authSuccess", token: result.token, username: result.username });
  } else {
    player.send({ type: "authError", error: result.error });
  }
}

async function handleLogin(player, msg) {
  const result = await authManager.login(msg.username, msg.password);
  if (result.success) {
    player.userId = result.userId;
    player.authenticated = true;
    player.name = result.username;
    authenticatedPlayers.set(result.userId, player);
    player.send({ type: "authSuccess", token: result.token, username: result.username });
  } else {
    player.send({ type: "authError", error: result.error });
  }
}

async function handleJoin(player, msg) {
  if (!player.authenticated) {
    player.send({ type: "error", message: "Must authenticate first" });
    return;
  }
  if (player.worldId !== null) return;

  const world = worldManager.addPlayerToWorld(player);

  const party = await InventoryManager.getParty(player.userId);
  player.party = party;

  const quests = await questManager.getQuests(player.userId);
  player.quests = quests;
  player.grassUnlockTier = await InventoryManager.getGrassUnlockTier(player.userId);
  const grassDexState = await InventoryManager.getGrassDexState(player.userId);

  encounterManager.initPlayer(player);

  player.send({
    type: "welcome",
    playerId: player.id,
    worldId: world.id,
    players: world.getPlayersArray(player.id),
    party: party,
    quests: quests,
    grassDex: grassDexState.entries,
    grassPoolSize: grassDexState.grassPoolSize,
    discoveredCount: grassDexState.discoveredCount,
    speciesCount: grassDexState.speciesCount,
    unlockTier: grassDexState.unlockTier,
  });

  player.send({
    type: "worldList",
    worlds: worldManager.getWorldList(),
  });

  worldManager.broadcastWorldList();
  console.log(`${player.name} (${player.id}) joined world ${world.id} "${world.name}" (${world.players.size} players)`);
}

function handleMove(player, msg) {
  if (player.worldId === null) return;
  const x = Number(msg.x) || 0;
  const y = Number(msg.y) || 0;
  const z = Number(msg.z) || 0;
  const rotY = Number(msg.rotY) || 0;
  player.updatePosition(x, y, z, rotY);
  if (player.isInGrass) {
    player.lastGrassActiveMove = Date.now();
  }
}

function handleSwitchWorld(player, msg) {
  const worldId = Number(msg.worldId);
  if (isNaN(worldId)) return;
  const result = worldManager.switchPlayerWorld(player, worldId);
  if (result) {
    console.log(`${player.name} switched to world ${result.id} "${result.name}"`);
  }
}

function handleGrassStatus(player, msg) {
  if (!player.authenticated || player.worldId === null) {
    console.log(`[grassStatus] Rejected: authenticated=${player.authenticated}, worldId=${player.worldId}`);
    return;
  }
  player.isInGrass = !!msg.inGrass;
  if (player.isInGrass) {
    player.lastGrassActiveMove = 0;
  }
  console.log(`[grassStatus] ${player.name} inGrass=${player.isInGrass}, timer=${player.encounterTimer?.toFixed(1)}s`);
}

async function handleGetParty(player) {
  if (!player.authenticated) return;
  const party = await InventoryManager.getParty(player.userId);
  player.party = party;
  player.send({ type: "partyData", party });
}

async function handleGetStorage(player, msg) {
  if (!player.authenticated) return;
  const page = Math.max(0, Number(msg.page) || 0);
  const pageSize = Math.min(50, Math.max(10, Number(msg.pageSize) || 50));
  const result = await InventoryManager.getStorage(player.userId, page, pageSize);
  player.send({ type: "storageData", ...result });
}

async function handlePartySwap(player, msg) {
  if (!player.authenticated) return;
  const result = await InventoryManager.swapToParty(player.userId, Number(msg.creatureId), Number(msg.position));
  if (result.success) {
    player.party = await InventoryManager.getParty(player.userId);
    player.send({ type: "inventoryUpdated", party: player.party });
  } else {
    player.send({ type: "error", message: result.error });
  }
}

async function handleStorageSwap(player, msg) {
  if (!player.authenticated) return;
  const result = await InventoryManager.swapToStorage(player.userId, Number(msg.creatureId));
  if (result.success) {
    player.party = await InventoryManager.getParty(player.userId);
    player.send({ type: "inventoryUpdated", party: player.party });
  } else {
    player.send({ type: "error", message: result.error });
  }
}

async function handlePartyReorder(player, msg) {
  if (!player.authenticated) return;
  const result = await InventoryManager.swapPartyPositions(player.userId, Number(msg.pos1), Number(msg.pos2));
  if (result.success) {
    player.party = await InventoryManager.getParty(player.userId);
    player.send({ type: "inventoryUpdated", party: player.party });
  } else {
    player.send({ type: "error", message: result.error });
  }
}

async function handleReleaseCreature(player, msg) {
  if (!player.authenticated) return;
  const result = await InventoryManager.releaseCreature(player.userId, Number(msg.creatureId));
  if (result.success) {
    player.party = await InventoryManager.getParty(player.userId);
    player.send({ type: "creatureReleased", creatureId: Number(msg.creatureId), party: player.party });
  } else {
    player.send({ type: "error", message: result.error });
  }
}

async function handleGetLeaderboard(player) {
  if (!player.authenticated) return;
  try {
    const top100 = await pool.query(
      "SELECT id, username, elo FROM users ORDER BY elo DESC LIMIT 100"
    );
    const rankResult = await pool.query(
      "SELECT COUNT(*) + 1 AS rank FROM users WHERE elo > (SELECT elo FROM users WHERE id = $1)",
      [player.userId]
    );
    const myEloResult = await pool.query("SELECT elo FROM users WHERE id = $1", [player.userId]);
    const myRank = parseInt(rankResult.rows[0].rank);
    const myElo = myEloResult.rows.length > 0 ? myEloResult.rows[0].elo : 1500;

    player.send({
      type: "leaderboardData",
      entries: top100.rows.map((r, i) => ({ rank: i + 1, username: r.username, elo: r.elo, isYou: r.id === player.userId })),
      myRank,
      myElo,
      myUsername: player.name,
    });
  } catch (err) {
    console.error("Leaderboard error:", err.message);
  }
}

async function handleReplaceCreature(player, msg) {
  if (!player.authenticated || !player._pendingReplace) return;
  const pending = player._pendingReplace;
  player._pendingReplace = null;

  if (!msg.accept) {
    player.send({ type: "replaceCancelled" });
    return;
  }

  const lowest = await InventoryManager.getLowestStatCreature(player.userId);
  if (!lowest) {
    player.send({ type: "error", message: "No creature to replace" });
    return;
  }

  const result = await InventoryManager.replaceCreature(
    player.userId, lowest.id, pending.speciesId, pending.stats, pending.abilityIds
  );
  if (result.success) {
    await InventoryManager.recordDiscovery(player.userId, pending.speciesId);
    const creature = await InventoryManager.getCreatureById(result.creatureId);
    player.party = await InventoryManager.getParty(player.userId);
    player.send({
      type: "creatureCaught",
      creature,
      slotType: "storage",
      replacedId: lowest.id,
    });
    await encounterManager.pushGrassDex(player);
    await questManager.onGrassCatch(player, creature);
  } else {
    player.send({ type: "error", message: result.error });
  }
}

function handleBattleAction(player, msg) {
  if (!player.inBattle || !player.battleId) return;
  battleManager.submitAction(player.battleId, player.userId, msg);
}

function handleFindBattle(player) {
  if (!player.authenticated || player.inBattle) {
    player.send({ type: "matchmakingStatus", status: "cancelled" });
    return;
  }
  if (!player.party || player.party.length === 0) {
    player.send({ type: "matchmakingStatus", status: "cancelled" });
    player.send({ type: "error", message: "You need creatures in your party to battle" });
    return;
  }
  matchmakingManager.addToQueue(player);
}

function handleCancelMatchmaking(player) {
  matchmakingManager.removeFromQueue(player);
}

function handleTradeRequest(player, msg) {
  if (!player.authenticated || player.inBattle) return;
  const targetId = msg.targetPlayerId;
  let targetPlayer = null;
  for (const [, p] of players) {
    if (p.id === targetId && p.authenticated && p.worldId === player.worldId) {
      targetPlayer = p;
      break;
    }
  }
  if (!targetPlayer) {
    player.send({ type: "error", message: "Player not found in this world" });
    return;
  }
  tradeManager.requestTrade(player, targetPlayer);
}

function handleTradeResponse(player, msg) {
  tradeManager.respondToTrade(player, !!msg.accepted);
}

async function handleTradeOffer(player, msg) {
  await tradeManager.setOffer(player, Number(msg.creatureId));
}

async function handleTradeConfirm(player) {
  await tradeManager.confirmTrade(player);
}

function handleTradeCancel(player) {
  tradeManager.cancelTrade(player);
}

function handleDisconnect(player) {
  player.alive = false;
  matchmakingManager.removeFromQueue(player);
  tradeManager.cancelTrade(player);
  if (player.inBattle && player.battleId) {
    battleManager.forfeit(player.battleId, player.userId);
  }
  worldManager.removePlayerFromWorld(player);
  if (player.userId) authenticatedPlayers.delete(player.userId);
  players.delete(player.ws);
  worldManager.broadcastWorldList();
  console.log(`Player disconnected: ${player.name} (${player.id}), ${players.size} remaining`);
}

function tick() {
  for (const [, world] of worldManager.worlds) {
    if (world.players.size < 2) continue;
    for (const [, player] of world.players) {
      world.broadcast(
        {
          type: "playerMoved",
          playerId: player.id,
          x: player.x,
          y: player.y,
          z: player.z,
          rotY: player.rotY,
        },
        player.id
      );
    }
  }

  encounterManager.tick(TICK_RATE_MS / 1000, questManager);

  matchmakingManager.tick();
}

start().catch((err) => {
  console.error("Server failed to start:", err);
  process.exit(1);
});
