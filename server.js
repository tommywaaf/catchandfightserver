const WebSocket = require("ws");

const port = process.env.PORT || 8080;

const wss = new WebSocket.Server({ port });

console.log("Server running on port", port);

wss.on("connection", function connection(ws) {
  console.log("Player connected");

  ws.on("message", function message(data) {
    console.log("received:", data.toString());
  });

  ws.send("Welcome to CatchAndFight server");
});