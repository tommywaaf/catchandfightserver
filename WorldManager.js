const World = require("./World");

const DEFAULT_WORLDS = [
  { name: "Plains" },
  { name: "Forest" },
  { name: "Desert" },
  { name: "Mountains" },
  { name: "Islands" },
];

class WorldManager {
  constructor() {
    this.worlds = new Map();
    this.nextWorldId = 0;

    for (const def of DEFAULT_WORLDS) {
      this.createWorld(def.name);
    }

    console.log(`Initialized ${this.worlds.size} worlds`);
  }

  createWorld(name) {
    const id = this.nextWorldId++;
    const world = new World(id, name);
    this.worlds.set(id, world);
    console.log(`Created world ${id}: ${name}`);
    return world;
  }

  getWorld(worldId) {
    return this.worlds.get(worldId);
  }

  findAvailableWorld() {
    for (const [, world] of this.worlds) {
      if (!world.isFull()) return world;
    }
    return this.createWorld(`World ${this.nextWorldId}`);
  }

  addPlayerToWorld(player, worldId = null) {
    let world;
    if (worldId !== null) {
      world = this.worlds.get(worldId);
      if (!world || world.isFull()) {
        world = this.findAvailableWorld();
      }
    } else {
      world = this.findAvailableWorld();
    }

    const spawnX = (Math.random() - 0.5) * 20;
    const spawnZ = (Math.random() - 0.5) * 20;
    player.updatePosition(spawnX, 0, spawnZ, 0);

    world.addPlayer(player);

    world.broadcast(
      { type: "playerJoined", ...player.toJSON() },
      player.id
    );

    return world;
  }

  removePlayerFromWorld(player) {
    if (player.worldId === null) return;
    const world = this.worlds.get(player.worldId);
    if (!world) return;

    world.removePlayer(player);
    world.broadcast({ type: "playerLeft", playerId: player.id });
  }

  switchPlayerWorld(player, newWorldId) {
    const targetWorld = this.worlds.get(newWorldId);
    if (!targetWorld) {
      player.send({ type: "error", message: "World does not exist" });
      return null;
    }
    if (targetWorld.isFull()) {
      player.send({ type: "error", message: "World is full" });
      return null;
    }
    if (player.worldId === newWorldId) {
      return null;
    }

    this.removePlayerFromWorld(player);

    const world = this.addPlayerToWorld(player, newWorldId);

    player.send({
      type: "worldSwitched",
      worldId: world.id,
      players: world.getPlayersArray(player.id),
    });

    this.broadcastWorldList();
    return world;
  }

  getWorldList() {
    const list = [];
    for (const [, world] of this.worlds) {
      list.push(world.toJSON());
    }
    return list;
  }

  broadcastWorldList() {
    const message = { type: "worldList", worlds: this.getWorldList() };
    for (const [, world] of this.worlds) {
      for (const [, player] of world.players) {
        player.send(message);
      }
    }
  }
}

module.exports = WorldManager;
