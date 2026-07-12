// server.js
// เซิร์ฟเวอร์เกมโดมิโนคำประสม-คำซ้อน รองรับหลายห้อง(หลายเกม)พร้อมกัน
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const QRCode = require('qrcode');
const { customAlphabet } = require('nanoid');
const { GameRoom } = require('./gameEngine');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const nanoid = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 5); // ตัด O/0/I/1 กันสับสน

app.use(express.static('public'));

/** @type {Map<string, GameRoom>} */
const rooms = new Map();

function broadcastRoom(room, gameEvent) {
  const socketsInRoom = io.sockets.adapter.rooms.get(`room:${room.code}`);
  if (!socketsInRoom) return;
  for (const sid of socketsInRoom) {
    const sock = io.sockets.sockets.get(sid);
    if (!sock) continue;
    const teamId = sock.data.teamId || null;
    sock.emit('state', room.publicState(teamId));
    if (gameEvent) sock.emit('gameEvent', gameEvent);
  }
}

function getRoomOrThrow(code) {
  const room = rooms.get(code);
  if (!room) throw new Error('ไม่พบห้องเกมนี้ (รหัสผิดหรือเกมถูกปิดไปแล้ว)');
  return room;
}

io.on('connection', (socket) => {
  // ---------- HOST ----------
  socket.on('host:createRoom', (_payload, cb) => {
    let code;
    do {
      code = nanoid();
    } while (rooms.has(code));
    const room = new GameRoom(code);
    room.onUpdate((r, event, payload) => broadcastRoom(r, { event, payload }));
    rooms.set(code, room);
    socket.join(`room:${code}`);
    socket.data.isHost = true;
    socket.data.code = code;
    cb && cb({ ok: true, code });
    broadcastRoom(room);
  });

  socket.on('host:rejoin', ({ code }, cb) => {
    try {
      const room = getRoomOrThrow(code);
      socket.join(`room:${code}`);
      socket.data.isHost = true;
      socket.data.code = code;
      cb && cb({ ok: true, state: room.publicState(null) });
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  socket.on('host:qrcode', async ({ code, joinUrl }, cb) => {
    try {
      const dataUrl = await QRCode.toDataURL(joinUrl, { margin: 1, width: 320 });
      cb && cb({ ok: true, dataUrl });
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  socket.on('host:startGame', ({ code }, cb) => {
    try {
      const room = getRoomOrThrow(code);
      room.startGame();
      cb && cb({ ok: true });
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  socket.on('host:selectWordSet', ({ code, setId }, cb) => {
    try {
      const room = getRoomOrThrow(code);
      room.selectWordSet(setId);
      cb && cb({ ok: true });
      broadcastRoom(room);
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  socket.on('host:pauseGame', ({ code }, cb) => {
    try {
      const room = getRoomOrThrow(code);
      room.pauseGame();
      cb && cb({ ok: true });
      broadcastRoom(room);
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  socket.on('host:resumeGame', ({ code }, cb) => {
    try {
      const room = getRoomOrThrow(code);
      room.resumeGame();
      cb && cb({ ok: true });
      broadcastRoom(room);
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  socket.on('host:endGame', ({ code }, cb) => {
    try {
      const room = getRoomOrThrow(code);
      room.forceEndGame();
      cb && cb({ ok: true });
      broadcastRoom(room);
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  // เผื่อ client ต้องการ state ล่าสุดแบบ request-response ตรง ๆ (เช่น เทสอัตโนมัติ)
  socket.on('room:getState', ({ code }, cb) => {
    try {
      const room = getRoomOrThrow(code);
      cb && cb({ ok: true, state: room.publicState(socket.data.teamId || null) });
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  // ---------- PLAYER ----------
  socket.on('player:join', ({ code, teamName }, cb) => {
    try {
      const room = getRoomOrThrow(code);
      const name = (teamName || '').trim().slice(0, 24);
      if (!name) throw new Error('กรุณากรอกชื่อทีม');
      const team = room.addTeam(name);
      socket.join(`room:${code}`);
      socket.data.isHost = false;
      socket.data.code = code;
      socket.data.teamId = team.id;
      cb && cb({ ok: true, teamId: team.id, code });
      broadcastRoom(room);
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  socket.on('player:rejoin', ({ code, teamId }, cb) => {
    try {
      const room = getRoomOrThrow(code);
      const team = room.teams.find((t) => t.id === teamId);
      if (!team) throw new Error('ไม่พบทีมนี้ในห้อง');
      socket.join(`room:${code}`);
      socket.data.isHost = false;
      socket.data.code = code;
      socket.data.teamId = teamId;
      cb && cb({ ok: true, state: room.publicState(teamId) });
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  socket.on('player:voluntaryDraw', (_payload, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.code);
      const drawn = room.voluntaryDraw(socket.data.teamId);
      cb && cb({ ok: true, drawnTileId: drawn });
      broadcastRoom(room);
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  socket.on('player:playTile', ({ tileId, slotType }, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.code);
      const result = room.playTile(socket.data.teamId, tileId, slotType);
      cb && cb({ ok: true, result });
      broadcastRoom(room);
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  socket.on('player:skipTurn', (_payload, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.code);
      room.skipTurn(socket.data.teamId);
      cb && cb({ ok: true });
      broadcastRoom(room);
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  socket.on('player:changeBoardWord', (_payload, cb) => {
    try {
      const room = getRoomOrThrow(socket.data.code);
      room.changeBoardWord(socket.data.teamId);
      cb && cb({ ok: true });
      broadcastRoom(room);
    } catch (e) {
      cb && cb({ ok: false, error: e.message });
    }
  });

  socket.on('disconnect', () => {
    // ไม่ลบทีมออกทันที เผื่อผู้เล่นแค่หลุดเน็ตแล้วต่อใหม่ (rejoin ด้วย teamId ที่เก็บฝั่ง client)
  });
});

server.listen(PORT, () => {
  console.log(`Domino word game server running on port ${PORT}`);
});
