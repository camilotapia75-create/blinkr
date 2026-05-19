const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(express.static(path.join(__dirname, 'public')));

// Queue of sockets waiting for a match
let waitingSocket = null;

// Map of roomId -> { players: [socketId, socketId], gameActive: bool }
const rooms = new Map();

function createRoomId() {
  return Math.random().toString(36).slice(2, 10);
}

io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  socket.on('find-match', () => {
    if (waitingSocket && waitingSocket.id !== socket.id && waitingSocket.connected) {
      // Pair with waiting player
      const roomId = createRoomId();
      const partner = waitingSocket;
      waitingSocket = null;

      rooms.set(roomId, {
        players: [partner.id, socket.id],
        gameActive: false,
        blinkCount: { [partner.id]: 0, [socket.id]: 0 }
      });

      partner.join(roomId);
      socket.join(roomId);

      // Tell the first socket it's the WebRTC offerer
      partner.emit('matched', { roomId, role: 'offerer' });
      socket.emit('matched', { roomId, role: 'answerer' });
    } else {
      // Wait for another player
      waitingSocket = socket;
      socket.emit('waiting');
    }
  });

  // WebRTC signaling relay
  socket.on('signal', ({ roomId, data }) => {
    socket.to(roomId).emit('signal', { from: socket.id, data });
  });

  socket.on('game-start', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.readyCount = (room.readyCount || 0) + 1;
    if (room.readyCount >= 2) {
      room.gameActive = true;
      io.to(roomId).emit('countdown-start');
    }
  });

  socket.on('blink-detected', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room || !room.gameActive) return;
    room.gameActive = false;

    // The socket that blinked loses
    const winnerId = room.players.find((id) => id !== socket.id);
    io.to(roomId).emit('game-over', {
      loserId: socket.id,
      winnerId
    });
  });

  socket.on('play-again', ({ roomId }) => {
    const room = rooms.get(roomId);
    if (!room) return;
    room.readyAgain = (room.readyAgain || 0) + 1;
    if (room.readyAgain >= 2) {
      room.readyAgain = 0;
      room.readyCount = 2;
      room.gameActive = true;
      io.to(roomId).emit('countdown-start');
    } else {
      socket.to(roomId).emit('opponent-ready-again');
    }
  });

  socket.on('disconnect', () => {
    console.log('disconnected:', socket.id);
    if (waitingSocket && waitingSocket.id === socket.id) {
      waitingSocket = null;
    }
    // Notify rooms
    for (const [roomId, room] of rooms.entries()) {
      if (room.players.includes(socket.id)) {
        io.to(roomId).emit('opponent-disconnected');
        rooms.delete(roomId);
      }
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Blinker server running on http://localhost:${PORT}`);
});
