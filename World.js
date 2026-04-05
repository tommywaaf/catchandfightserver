class World {
  constructor(id, name, maxPlayers = 20) {
    this.id = id;
    this.name = name;
    this.maxPlayers = maxPlayers;
    this.players = new Map();
  }

  isFull() {
    return this.players.size >= this.maxPlayers;
  }

  addPlayer(player) {
    this.players.set(player.id, player);
    player.worldId = this.id;
  }

  removePlayer(player) {
    this.players.delete(player.id);
    player.worldId = null;
  }

  broadcast(message, excludeId = null) {
    const data = JSON.stringify(message);
    for (const [id, player] of this.players) {
      if (id !== excludeId && player.ws.readyState === 1) {
        player.ws.send(data);
      }
    }
  }

  getPlayersArray(excludeId = null) {
    const result = [];
    for (const [id, player] of this.players) {
      if (id !== excludeId) {
        result.push(player.toJSON());
      }
    }
    return result;
  }

  toJSON() {
    return {
      id: this.id,
      name: this.name,
      playerCount: this.players.size,
      maxPlayers: this.maxPlayers,
    };
  }
}

module.exports = World;
