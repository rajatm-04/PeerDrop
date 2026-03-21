const express = require('express');
const {createServer}= require('node:http');
const { join } = require('node:path');
const {Server} = require("socket.io")

const app = express();
const server = createServer(app)
const io= new Server(server)


app.get('/', (req,res) => {
    res.sendFile(join(__dirname, 'index.html'));
});

io.on('connection', (socket) => {

  socket.on('join-room', (roomId) => {
    socket.join(roomId);
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


server.listen(3000, () => {
  console.log('server running at http://localhost:3000');
});


