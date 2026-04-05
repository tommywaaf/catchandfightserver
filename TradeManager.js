const { pool } = require("./db");
const InventoryManager = require("./InventoryManager");

class TradeManager {
  constructor() {
    this.trades = new Map();
    this.playerTradeMap = new Map();
    this.nextTradeId = 1;
  }

  requestTrade(fromPlayer, toPlayer) {
    if (this.playerTradeMap.has(fromPlayer.userId) || this.playerTradeMap.has(toPlayer.userId)) {
      fromPlayer.send({ type: "error", message: "Already in a trade" });
      return;
    }

    const tradeId = this.nextTradeId++;
    const trade = {
      id: tradeId,
      player1: { ref: fromPlayer, offeredCreatureId: null, offeredCreature: null, confirmed: false },
      player2: { ref: toPlayer, offeredCreatureId: null, offeredCreature: null, confirmed: false },
      pending: true,
    };

    this.trades.set(tradeId, trade);
    this.playerTradeMap.set(fromPlayer.userId, tradeId);

    toPlayer.send({
      type: "tradeIncoming",
      fromPlayerId: fromPlayer.id,
      fromPlayerName: fromPlayer.name,
      tradeId,
    });

    fromPlayer.send({ type: "tradeUpdate", status: "requested", tradeId });
    fromPlayer.tradeSessionId = tradeId;
  }

  respondToTrade(player, accepted) {
    let trade = null;
    for (const [, t] of this.trades) {
      if (t.pending && t.player2.ref.userId === player.userId) {
        trade = t;
        break;
      }
    }
    if (!trade) return;

    if (!accepted) {
      trade.player1.ref.send({ type: "tradeUpdate", status: "declined" });
      this.cleanupTrade(trade);
      return;
    }

    trade.pending = false;
    this.playerTradeMap.set(player.userId, trade.id);
    player.tradeSessionId = trade.id;

    trade.player1.ref.send({ type: "tradeUpdate", status: "accepted" });
    trade.player2.ref.send({ type: "tradeUpdate", status: "accepted" });
  }

  async setOffer(player, creatureId) {
    const tradeId = this.playerTradeMap.get(player.userId);
    if (!tradeId) return;
    const trade = this.trades.get(tradeId);
    if (!trade || trade.pending) return;

    const side = trade.player1.ref.userId === player.userId ? trade.player1 : trade.player2;
    const creature = await InventoryManager.getCreatureById(creatureId);

    if (!creature || creature.speciesId === undefined) {
      player.send({ type: "error", message: "Creature not found" });
      return;
    }

    side.offeredCreatureId = creatureId;
    side.offeredCreature = creature;
    side.confirmed = false;

    const otherSide = side === trade.player1 ? trade.player2 : trade.player1;
    otherSide.confirmed = false;

    otherSide.ref.send({
      type: "tradeUpdate",
      status: "offer",
      offeredCreature: creature,
    });
    player.send({ type: "tradeUpdate", status: "offerSet", creature });
  }

  async confirmTrade(player) {
    const tradeId = this.playerTradeMap.get(player.userId);
    if (!tradeId) return;
    const trade = this.trades.get(tradeId);
    if (!trade || trade.pending) return;

    const side = trade.player1.ref.userId === player.userId ? trade.player1 : trade.player2;
    const otherSide = side === trade.player1 ? trade.player2 : trade.player1;

    if (!side.offeredCreatureId || !otherSide.offeredCreatureId) {
      player.send({ type: "error", message: "Both players must offer a creature" });
      return;
    }

    side.confirmed = true;
    otherSide.ref.send({ type: "tradeUpdate", status: "partnerConfirmed" });

    if (trade.player1.confirmed && trade.player2.confirmed) {
      await this.executeTrade(trade);
    }
  }

  async executeTrade(trade) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      const totalP1 = await InventoryManager.getTotalCreatureCount(trade.player1.ref.userId);
      const totalP2 = await InventoryManager.getTotalCreatureCount(trade.player2.ref.userId);
      if (totalP1 <= 1 || totalP2 <= 1) {
        await client.query("ROLLBACK");
        trade.player1.ref.send({ type: "error", message: "Cannot trade your last creature" });
        trade.player2.ref.send({ type: "error", message: "Cannot trade your last creature" });
        return;
      }

      await client.query(
        "UPDATE player_creatures SET user_id = $1, slot_type = 'storage', party_position = NULL WHERE id = $2",
        [trade.player2.ref.userId, trade.player1.offeredCreatureId]
      );
      await client.query(
        "UPDATE player_creatures SET user_id = $1, slot_type = 'storage', party_position = NULL WHERE id = $2",
        [trade.player1.ref.userId, trade.player2.offeredCreatureId]
      );

      await client.query("COMMIT");

      await InventoryManager.reindexParty(trade.player1.ref.userId);
      await InventoryManager.reindexParty(trade.player2.ref.userId);

      const p1Party = await InventoryManager.getParty(trade.player1.ref.userId);
      const p2Party = await InventoryManager.getParty(trade.player2.ref.userId);
      trade.player1.ref.party = p1Party;
      trade.player2.ref.party = p2Party;

      trade.player1.ref.send({ type: "tradeComplete", party: p1Party });
      trade.player2.ref.send({ type: "tradeComplete", party: p2Party });

      this.cleanupTrade(trade);
    } catch (err) {
      await client.query("ROLLBACK");
      console.error("Trade execution error:", err.message);
      trade.player1.ref.send({ type: "error", message: "Trade failed" });
      trade.player2.ref.send({ type: "error", message: "Trade failed" });
    } finally {
      client.release();
    }
  }

  cancelTrade(player) {
    const tradeId = this.playerTradeMap.get(player.userId);
    if (!tradeId) return;
    const trade = this.trades.get(tradeId);
    if (!trade) return;

    const otherSide = trade.player1.ref.userId === player.userId ? trade.player2 : trade.player1;
    if (otherSide.ref && otherSide.ref.alive) {
      otherSide.ref.send({ type: "tradeUpdate", status: "cancelled" });
    }

    this.cleanupTrade(trade);
  }

  cleanupTrade(trade) {
    this.trades.delete(trade.id);
    if (trade.player1.ref) {
      this.playerTradeMap.delete(trade.player1.ref.userId);
      trade.player1.ref.tradeSessionId = null;
    }
    if (trade.player2.ref) {
      this.playerTradeMap.delete(trade.player2.ref.userId);
      trade.player2.ref.tradeSessionId = null;
    }
  }
}

module.exports = TradeManager;
