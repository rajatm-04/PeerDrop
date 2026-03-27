const express = require('express');
const {createServer}= require('node:http');
const { join } = require('node:path');
const {Server} = require("socket.io")

const app = express();
const server = createServer(app)
const allowedOrigin = process.env.ALLOWED_ORIGIN || '*';
const io= new Server(server, {
  cors: {
    origin: allowedOrigin === '*' ? '*' : allowedOrigin.split(',').map((s) => s.trim()),
    methods: ['GET', 'POST']
  }
})


app.get('/', (req,res) => {
    res.sendFile(join(__dirname, 'index.html'));
});

app.get('/health', (_req, res) => {
  res.status(200).send('ok');
});

app.get('/api/rtc-config', (_req, res) => {
  const turnUsername = process.env.TURN_USERNAME || '';
  const turnCredential = process.env.TURN_CREDENTIAL || '';
  const turnUrlsRaw = process.env.TURN_URLS || '';
  const turnUrls = turnUrlsRaw
    .split(',')
    .map((u) => u.trim())
    .filter(Boolean);

  const turnServers =
    turnUsername && turnCredential && turnUrls.length
      ? turnUrls.map((urls) => ({ urls, username: turnUsername, credential: turnCredential }))
      : [];

  res.set('Cache-Control', 'no-store');
  res.json({
    turnServers
  });
});

io.on('connection', (socket) => {

  socket.on('join-room', (roomId) => {
    const room = io.sockets.adapter.rooms.get(roomId);
    const roomSize = room ? room.size : 0;
    if (roomSize >= 2) {
      socket.emit('room-full', roomId);
      return;
    }
    socket.join(roomId);
    socket.emit('room-joined', roomId);
    socket.to(roomId).emit('user-joined'); // tell the OTHER person someone joined
  });

  socket.on('signal', (roomId, data) => {
    socket.to(roomId).emit('signal', data); // relay handshake to the OTHER person only
  });

});
// io.on('connection', (socket) => {
//   console.log('a user connected');
//   socket.on('chat message', (msg) => {
//     console.log('message: ' + msg);
//   });
// });


const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => {
  console.log(`server running at http://localhost:${PORT}`);
});


