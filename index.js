const express = require('express');
const { createServer } = require('node:http');
const { join } = require('node:path');
const { Server } = require('socket.io');
const crypto = require('node:crypto');

const app = express();
const server = createServer(app);
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
const io = new Server(server, {
  maxHttpBufferSize: 5e6,
  cors: {
    origin: allowedOrigin === '*' ? '*' : allowedOrigin.split(',').map((s) => s.trim()),
    methods: ['GET', 'POST']
  }
});

// ── Static files ────────────────────────────────────────────────────
app.use(express.static(join(__dirname)));

// ── Device name generation ──────────────────────────────────────────
const ADJECTIVES = [
  'Swift', 'Bright', 'Cool', 'Bold', 'Calm', 'Wise',
  'Fast', 'Keen', 'Wild', 'Free', 'Brave', 'Noble'
];
const ANIMALS = [
  { name: 'Fox', emoji: '🦊' },
  { name: 'Panda', emoji: '🐼' },
  { name: 'Eagle', emoji: '🦅' },
  { name: 'Wolf', emoji: '🐺' },
  { name: 'Lion', emoji: '🦁' },
  { name: 'Tiger', emoji: '🐯' },
  { name: 'Dolphin', emoji: '🐬' },
  { name: 'Owl', emoji: '🦉' },
  { name: 'Penguin', emoji: '🐧' },
  { name: 'Bear', emoji: '🐻' },
  { name: 'Koala', emoji: '🐨' },
  { name: 'Cat', emoji: '🐱' },
];

function generateDeviceName() {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return { displayName: `${adj} ${animal.name}`, emoji: animal.emoji };
}

// ── Online users tracking ───────────────────────────────────────────
const onlineUsers = new Map(); // socketId → { displayName, emoji }

function broadcastOnlineUsers() {
  const users = Array.from(onlineUsers.entries()).map(([id, data]) => ({
    id,
    displayName: data.displayName,
    emoji: data.emoji
  }));
  io.emit('online-users', users);
}

// ── Routes ──────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.sendFile(join(__dirname, 'index.html'));
});

app.get('/health', (_req, res) => {
  res.status(200).send('ok');
});

// ── Socket.io ───────────────────────────────────────────────────────
io.on('connection', (socket) => {
  // Auto-register with a generated name
  const { displayName, emoji } = generateDeviceName();
  onlineUsers.set(socket.id, { displayName, emoji });

  // Tell the user who they are
  socket.emit('registered', { id: socket.id, displayName, emoji });

  // Send the client its real local IP (used to replace mDNS .local candidates)
  let clientIp = socket.handshake.address || '';
  // Strip IPv6-mapped prefix (::ffff:192.168.1.5 → 192.168.1.5)
  if (clientIp.startsWith('::ffff:')) clientIp = clientIp.slice(7);
  // For loopback, try to find the real LAN IP
  if (clientIp === '127.0.0.1' || clientIp === '::1') {
    const os = require('node:os');
    const nets = os.networkInterfaces();
    for (const iface of Object.values(nets)) {
      for (const cfg of iface) {
        if (cfg.family === 'IPv4' && !cfg.internal) {
          clientIp = cfg.address;
          break;
        }
      }
      if (clientIp !== '127.0.0.1' && clientIp !== '::1') break;
    }
  }
  socket.emit('your-ip', clientIp);

  // Broadcast updated user list to everyone
  broadcastOnlineUsers();

  // ── Invite flow ─────────────────────────────────────────────────
  socket.on('send-invite', (targetId) => {
    const sender = onlineUsers.get(socket.id);
    if (!sender) return;
    const targetSocket = io.sockets.sockets.get(targetId);
    if (!targetSocket) {
      socket.emit('invite-failed', 'That device is no longer online.');
      return;
    }
    targetSocket.emit('receive-invite', {
      senderId: socket.id,
      displayName: sender.displayName,
      emoji: sender.emoji
    });
  });

  socket.on('accept-invite', (senderId) => {
    const roomId = crypto.randomUUID();
    const senderSocket = io.sockets.sockets.get(senderId);
    if (!senderSocket) {
      socket.emit('invite-failed', 'The other device went offline.');
      return;
    }

    // Join both sockets to the ephemeral room
    socket.join(roomId);
    senderSocket.join(roomId);

    const accepter = onlineUsers.get(socket.id);
    const sender = onlineUsers.get(senderId);

    // Tell both peers the room is ready
    senderSocket.emit('room-ready', {
      roomId,
      isInitiator: true,
      peer: { displayName: accepter?.displayName || 'Unknown', emoji: accepter?.emoji || '❓' }
    });
    socket.emit('room-ready', {
      roomId,
      isInitiator: false,
      peer: { displayName: sender?.displayName || 'Unknown', emoji: sender?.emoji || '❓' }
    });
  });

  socket.on('decline-invite', (senderId) => {
    const me = onlineUsers.get(socket.id);
    io.to(senderId).emit('invite-declined', {
      displayName: me?.displayName || 'Someone'
    });
  });

  socket.on('cancel-invite', (targetId) => {
    io.to(targetId).emit('invite-cancelled');
  });

  // ── WebRTC signal relay (unchanged) ─────────────────────────────
  socket.on('signal', (roomId, data) => {
    const type = data.offer ? 'offer' : data.answer ? 'answer' : 'ice';
    const room = io.sockets.adapter.rooms.get(roomId);
    console.log(`[SIGNAL] from=${socket.id} room=${roomId} roomSize=${room?.size || 0} type=${type}`);
    socket.to(roomId).emit('signal', data);
  });

  // ── Socket.io relay fallback (when WebRTC P2P fails) ────────────
  socket.on('relay', (roomId, data, ack) => {
    socket.to(roomId).emit('relay', data);
    if (typeof ack === 'function') ack();
  });

  // ── Leave room / go back to lobby ───────────────────────────────
  socket.on('leave-room', (roomId) => {
    socket.leave(roomId);
    socket.to(roomId).emit('peer-left');
  });

  // ── Disconnect ──────────────────────────────────────────────────
  socket.on('disconnect', () => {
    onlineUsers.delete(socket.id);
    broadcastOnlineUsers();
  });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`server running at http://localhost:${PORT}`);
});
