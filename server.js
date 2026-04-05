const WebSocket = require("ws");
const Player = require("./Player");
const WorldManager = require("./WorldManager");

const port = process.env.PORT || 8080;
const TICK_RATE_MS = 50;
const HEARTBEAT_INTERVAL_MS = 30000;
const HEARTBEAT_TIMEOUT_MS = 60000;

const wss = new WebSocket.Server({ port });
const worldManager = new WorldManager();
const players = new Map();

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

function handleMessage(player, msg) {
  switch (msg.type) {
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
  }
}

function handleJoin(player, msg) {
  if (player.worldId !== null) return;

  player.name = (msg.name || "Player").substring(0, 20);
  const world = worldManager.addPlayerToWorld(player);

  player.send({
    type: "welcome",
    playerId: player.id,
    worldId: world.id,
    players: world.getPlayersArray(player.id),
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
}

function handleSwitchWorld(player, msg) {
  const worldId = Number(msg.worldId);
  if (isNaN(worldId)) return;

  const result = worldManager.switchPlayerWorld(player, worldId);
  if (result) {
    console.log(`${player.name} switched to world ${result.id} "${result.name}"`);
  }
}

function handleDisconnect(player) {
  player.alive = false;
  worldManager.removePlayerFromWorld(player);
  players.delete(player.ws);
  worldManager.broadcastWorldList();
  console.log(`Player disconnected: ${player.name} (${player.id}), ${players.size} remaining`);
}

// --- Server tick: broadcast positions ---
setInterval(() => {
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
}, TICK_RATE_MS);

// --- Heartbeat: detect dead connections ---
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
