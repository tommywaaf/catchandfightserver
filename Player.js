const crypto = require("crypto");

class Player {
  constructor(ws) {
    this.id = crypto.randomUUID();
    this.ws = ws;
    this.name = "Player";
    this.worldId = null;
    this.x = 0;
    this.y = 0;
    this.z = 0;
    this.rotY = 0;
    this.lastUpdate = Date.now();
    this.alive = true;

    this.userId = null;
    this.authenticated = false;
    this.party = [];
    this.quests = [];
    this.encounterTimer = 0;
    this.isInGrass = false;
    /** Updated when a move packet arrives while in grass; encounter timer only ticks while recent */
    this.lastGrassActiveMove = 0;
    this.grassUnlockTier = 0;
    this.inBattle = false;
    this.battleId = null;
    this.inMatchmaking = false;
    this.matchmakingJoinedAt = null;
    this.tradeSessionId = null;
  }

  send(message) {
    if (this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(message));
    }
  }

  updatePosition(x, y, z, rotY) {
    this.x = x;
    this.y = y;
    this.z = z;
    this.rotY = rotY;
    this.lastUpdate = Date.now();
  }

  toJSON() {
    return {
      playerId: this.id,
      name: this.name,
      x: this.x,
      y: this.y,
      z: this.z,
      rotY: this.rotY,
    };
  }
}

module.exports = Player;
