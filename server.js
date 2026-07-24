const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// ═══════════════════════════════════════
//  Комнаты (максимум 20 игроков в каждой)
// ═══════════════════════════════════════
const rooms = new Map();
let nextRoomIdx = 1;
const MAX_PLAYERS_PER_ROOM = 20;

function createRoom() {
    const id = 'room_' + (nextRoomIdx++);
    const room = {
        id,
        name: `TuCoria #${nextRoomIdx - 1}`,
        clients: new Map(),      // ws -> { playerId, name, userId }
        blocks: new Map(),       // blockId -> NetBlockData
        nextPlayerId: 1,
        nextBlockId: 1,
        maxPlayers: MAX_PLAYERS_PER_ROOM,
        createdAt: Date.now()
    };
    rooms.set(id, room);
    console.log(`[LOBBY] Created ${id}`);
    return room;
}

function findAvailableRoom() {
    for (const room of rooms.values()) {
        if (room.clients.size < room.maxPlayers) return room;
    }
    return createRoom();
}

// ═══════════════════════════════════════
//  HTTP
// ═══════════════════════════════════════
app.get('/', (req, res) => {
    res.send('TuCoria Server');
});

app.get('/servers', (req, res) => {
    const list = Array.from(rooms.values()).map(r => ({
        id: r.id,
        name: r.name,
        players: r.clients.size,
        maxPlayers: r.maxPlayers,
        uptime: Math.floor((Date.now() - r.createdAt) / 1000)
    }));
    res.json({ servers: list, count: list.length });
});

// ═══════════════════════════════════════
//  WebSocket
// ═══════════════════════════════════════
const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: '/ws' });

const PT = {
    S_WELCOME: 1,
    S_PLAYER_JOIN: 2,
    S_PLAYER_LEAVE: 3,
    S_PLAYER_STATE: 4,
    S_CHAT: 5,
    S_PING: 6,
    S_PONG: 7,
    S_BLOCK_SPAWN: 20,
    S_BLOCK_UPDATE: 21,
    S_BLOCK_DELETE: 22,
    S_BLOCK_LIST: 23,
    C_HELLO: 100,
    C_PLAYER_STATE: 101,
    C_CHAT: 102,
    C_PING: 103,
    C_PONG: 104,
    C_BLOCK_SPAWN: 120,
    C_BLOCK_UPDATE: 121,
    C_BLOCK_DELETE: 122
};

class Reader {
    constructor(buf) { this.buf = buf; this.pos = 0; }
    u8()  { const v = this.buf.readUInt8(this.pos);  this.pos += 1; return v; }
    u16() { const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
    u32() { const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
    f32() { const v = this.buf.readFloatLE(this.pos);  this.pos += 4; return v; }
    vec3() { return { x: this.f32(), y: this.f32(), z: this.f32() }; }
    quat() { return { w: this.f32(), x: this.f32(), y: this.f32(), z: this.f32() }; }
    str() {
        const len = this.u16();
        if (len === 0) return '';
        const s = this.buf.slice(this.pos, this.pos + len).toString('utf8');
        this.pos += len;
        return s;
    }
    readBlock() {
        return {
            blockId: this.u32(),
            shape: this.u8(),
            position: this.vec3(),
            rotation: this.quat(),
            size: this.vec3(),
            color: this.vec3(),
            anchored: this.u8(),
            canCollide: this.u8(),
            roughness: this.f32(),
            metallic: this.f32(),
            transparency: this.f32(),
            castShadow: this.u8(),
            materialName: this.str(),
            name: this.str(),
            ownerId: this.u32()
        };
    }
}

class Writer {
    constructor() { this.chunks = []; }
    u8(v)  { const b = Buffer.alloc(1); b.writeUInt8(v, 0);    this.chunks.push(b); }
    u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); this.chunks.push(b); }
    u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); this.chunks.push(b); }
    f32(v) { const b = Buffer.alloc(4); b.writeFloatLE(v, 0);  this.chunks.push(b); }
    vec3(v) { this.f32(v.x); this.f32(v.y); this.f32(v.z); }
    quat(v) { this.f32(v.w); this.f32(v.x); this.f32(v.y); this.f32(v.z); }
    str(s) {
        const buf = Buffer.from(s || '', 'utf8');
        this.u16(buf.length);
        if (buf.length > 0) this.chunks.push(buf);
    }
    writeBlock(b) {
        this.u32(b.blockId);
        this.u8(b.shape);
        this.vec3(b.position);
        this.quat(b.rotation);
        this.vec3(b.size);
        this.vec3(b.color);
        this.u8(b.anchored);
        this.u8(b.canCollide);
        this.f32(b.roughness);
        this.f32(b.metallic);
        this.f32(b.transparency);
        this.u8(b.castShadow);
        this.str(b.materialName);
        this.str(b.name);
        this.u32(b.ownerId);
    }
    build() { return Buffer.concat(this.chunks); }
}

function send(ws, buf) {
    if (ws.readyState === WebSocket.OPEN) ws.send(buf);
}

function broadcast(room, buf, exclude = null) {
    for (const [ws] of room.clients) {
        if (ws === exclude) continue;
        send(ws, buf);
    }
}

// ═══════════════════════════════════════
//  Обработка соединения
// ═══════════════════════════════════════
wss.on('connection', (ws, req) => {
    console.log(`[WS] Connection from ${req.socket.remoteAddress}`);
    ws.room = null;
    ws.info = null;

    ws.on('message', (data) => {
        try {
            const r = new Reader(data);
            const type = r.u8();

            // HELLO — регистрация
            if (type === PT.C_HELLO) {
                const name = r.str();
                let userId = 0;
                try { userId = r.u32(); } catch(e){}

                if (userId === 0 || !name) {
                    console.log(`[WS] Rejected: no auth`);
                    ws.close();
                    return;
                }

                const room = findAvailableRoom();
                const playerId = room.nextPlayerId++;
                const info = { playerId, name, userId };
                room.clients.set(ws, info);
                ws.room = room;
                ws.info = info;

                console.log(`[WS] ${name} (uid=${userId}) joined ${room.id} as pid=${playerId}`);

                // WELCOME
                const w = new Writer();
                w.u8(PT.S_WELCOME);
                w.u32(playerId);
                const others = Array.from(room.clients.entries())
                    .filter(([wsx]) => wsx !== ws)
                    .map(([, i]) => i);
                w.u32(others.length);
                for (const o of others) {
                    w.u32(o.playerId);
                    w.str(o.name);
                }
                send(ws, w.build());

                // BLOCK LIST
                const bw = new Writer();
                bw.u8(PT.S_BLOCK_LIST);
                bw.u32(room.blocks.size);
                for (const b of room.blocks.values()) bw.writeBlock(b);
                send(ws, bw.build());

                // Уведомить остальных
                const jw = new Writer();
                jw.u8(PT.S_PLAYER_JOIN);
                jw.u32(playerId);
                jw.str(name);
                broadcast(room, jw.build(), ws);
                return;
            }

            const room = ws.room;
            const info = ws.info;
            if (!room || !info) return;

            // PLAYER STATE
            if (type === PT.C_PLAYER_STATE) {
                const pos = r.vec3();
                const yaw = r.f32();
                const anim = r.u8();
                const crouch = r.u8();

                const w = new Writer();
                w.u8(PT.S_PLAYER_STATE);
                w.u32(info.playerId);
                w.vec3(pos);
                w.f32(yaw);
                w.u8(anim);
                w.u8(crouch);
                broadcast(room, w.build(), ws);
                return;
            }

            // CHAT
            if (type === PT.C_CHAT) {
                const text = r.str();
                if (!text) return;
                console.log(`[CHAT ${room.id}] ${info.name}: ${text}`);
                const w = new Writer();
                w.u8(PT.S_CHAT);
                w.u32(info.playerId);
                w.str(info.name);
                w.str(text);
                broadcast(room, w.build());
                return;
            }

            // PING
            if (type === PT.C_PING) {
                const seq = r.u32();
                const w = new Writer();
                w.u8(PT.S_PONG);
                w.u32(seq);
                send(ws, w.build());
                return;
            }

            // BLOCK SPAWN
            if (type === PT.C_BLOCK_SPAWN) {
                const b = r.readBlock();
                b.blockId = room.nextBlockId++;
                b.ownerId = info.playerId;
                room.blocks.set(b.blockId, b);

                const w = new Writer();
                w.u8(PT.S_BLOCK_SPAWN);
                w.writeBlock(b);
                broadcast(room, w.build());
                return;
            }

            // BLOCK UPDATE
            if (type === PT.C_BLOCK_UPDATE) {
                const b = r.readBlock();
                if (room.blocks.has(b.blockId)) {
                    room.blocks.set(b.blockId, b);
                    const w = new Writer();
                    w.u8(PT.S_BLOCK_UPDATE);
                    w.writeBlock(b);
                    broadcast(room, w.build(), ws);
                }
                return;
            }

            // BLOCK DELETE
            if (type === PT.C_BLOCK_DELETE) {
                const blockId = r.u32();
                if (room.blocks.has(blockId)) {
                    room.blocks.delete(blockId);
                    const w = new Writer();
                    w.u8(PT.S_BLOCK_DELETE);
                    w.u32(blockId);
                    broadcast(room, w.build());
                }
                return;
            }

        } catch (e) {
            console.error('[WS] Message error:', e.message);
        }
    });

    ws.on('close', () => {
        const room = ws.room;
        const info = ws.info;
        if (!room || !info) return;
        room.clients.delete(ws);
        console.log(`[WS] ${info.name} left ${room.id}`);

        const w = new Writer();
        w.u8(PT.S_PLAYER_LEAVE);
        w.u32(info.playerId);
        broadcast(room, w.build());

        if (room.clients.size === 0 && rooms.size > 1) {
            rooms.delete(room.id);
            console.log(`[LOBBY] Removed empty ${room.id}`);
        }
    });

    ws.on('error', (err) => {
        console.error('[WS] Socket error:', err.message);
    });
});

server.listen(PORT, () => {
    console.log(`[SERVER] Listening on port ${PORT}`);
});
