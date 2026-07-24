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
        clients: new Map(),
        blocks: new Map(),
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
    if (ws.isBot) return; // боты игнорируют входящие
    if (ws.readyState === WebSocket.OPEN) ws.send(buf);
}

function broadcast(room, buf, exclude = null) {
    for (const [ws] of room.clients) {
        if (ws === exclude) continue;
        send(ws, buf);
    }
}

// ═══════════════════════════════════════
//  Фейковые боты для тестов
// ═══════════════════════════════════════
let nextBotUserId = 1000000;
const bots = new Map();

function spawnBot(name = 'Bot') {
    const room = findAvailableRoom();
    const playerId = room.nextPlayerId++;
    const userId = nextBotUserId++;
    const botId = 'bot_' + userId;

    const info = { playerId, name, userId, isBot: true };
    const fakeWs = { readyState: 1, send: () => {}, isBot: true, botId };
    room.clients.set(fakeWs, info);

    console.log(`[BOT] Spawned ${name} (pid=${playerId}) in ${room.id}`);

    // Оповестить о новом игроке
    const jw = new Writer();
    jw.u8(PT.S_PLAYER_JOIN);
    jw.u32(playerId);
    jw.str(name);
    broadcast(room, jw.build());

    // ═══ Состояние бота ═══
    const state = {
        pos: { x: (Math.random() - 0.5) * 30, y: 5, z: (Math.random() - 0.5) * 30 },
        target: { x: 0, y: 5, z: 0 },
        yaw: 0,
        speed: 3.0,
        buildTimer: 3 + Math.random() * 4,   // через сколько сек строить
        chatTimer: 15 + Math.random() * 30,  // через сколько писать в чат
        moveTimer: 0,
        anim: 0,
        jumpTimer: 0
    };

    const pickNewTarget = () => {
        state.target = {
            x: (Math.random() - 0.5) * 40,
            y: 3 + Math.random() * 8,
            z: (Math.random() - 0.5) * 40
        };
    };
    pickNewTarget();

    // Фразы для чата
    const buildPhrases = [
        "Строю базу тут",
        "Смотри что делаю",
        "Кто хочет помочь?",
        "Крутая идея пришла",
        "Тут будет дом",
        "Добавлю ещё блок",
        "Как вам постройка?",
        "Nice building",
        "Работаю над стеной",
        "Ставлю крышу",
        "Тестирую физику",
        "Красивый цвет получился"
    ];

    // Материалы для случайного выбора
    const materials = ["", "brick", "wood", "metal", "concrete", "plastic", "grass"];
    const shapes = [0, 1, 2, 3, 4]; // Block, Ball, Cylinder, Wedge, Tube

    // Случайный цвет
    const randColor = () => ({
        x: Math.random(),
        y: Math.random(),
        z: Math.random()
    });

    // ═══ Основной луп ═══
    const dt = 0.05; // 50ms = 20 tps
    const interval = setInterval(() => {
        if (!rooms.has(room.id)) {
            clearInterval(interval);
            return;
        }

        // ── Движение к target ──
        const dx = state.target.x - state.pos.x;
        const dy = state.target.y - state.pos.y;
        const dz = state.target.z - state.pos.z;
        const dist = Math.sqrt(dx*dx + dy*dy + dz*dz);

        if (dist < 1.0) {
            // Достигли — выбираем новую цель
            state.moveTimer += dt;
            if (state.moveTimer > 1 + Math.random() * 3) {
                pickNewTarget();
                state.moveTimer = 0;
            }
            state.anim = 0; // Idle
        } else {
            // Двигаемся
            const step = state.speed * dt;
            state.pos.x += (dx / dist) * step;
            state.pos.y += (dy / dist) * step;
            state.pos.z += (dz / dist) * step;
            state.yaw = Math.atan2(dz, dx) * 180 / Math.PI;
            state.anim = 1; // Walk
        }

        // Прыжок
        state.jumpTimer -= dt;
        if (state.jumpTimer <= 0) {
            state.jumpTimer = 8 + Math.random() * 10;
            if (Math.random() > 0.5) state.anim = 4; // JumpStart
        }

        // ── Отправляем позицию ──
        {
            const w = new Writer();
            w.u8(PT.S_PLAYER_STATE);
            w.u32(playerId);
            w.vec3(state.pos);
            w.f32(state.yaw);
            w.u8(state.anim);
            w.u8(0);
            broadcast(room, w.build());
        }

        // ── Стройка ──
        state.buildTimer -= dt;
        if (state.buildTimer <= 0) {
            state.buildTimer = 4 + Math.random() * 6;

            // Спавним блок рядом с ботом
            const shape = shapes[Math.floor(Math.random() * shapes.length)];
            const size = 1 + Math.random() * 3;
            const material = materials[Math.floor(Math.random() * materials.length)];

            const block = {
                blockId: room.nextBlockId++,
                shape: shape,
                position: {
                    x: state.pos.x + (Math.random() - 0.5) * 4,
                    y: state.pos.y - 2 + Math.random() * 2,
                    z: state.pos.z + (Math.random() - 0.5) * 4
                },
                rotation: { w: 1, x: 0, y: 0, z: 0 },
                size: {
                    x: size,
                    y: size * (0.5 + Math.random() * 1.5),
                    z: size
                },
                color: randColor(),
                anchored: 1,
                canCollide: 1,
                roughness: 0.5,
                metallic: Math.random() > 0.7 ? 0.8 : 0.0,
                transparency: 0,
                castShadow: 1,
                materialName: material,
                name: name + "_Block",
                ownerId: playerId
            };
            room.blocks.set(block.blockId, block);

            const w = new Writer();
            w.u8(PT.S_BLOCK_SPAWN);
            w.writeBlock(block);
            broadcast(room, w.build());

            console.log(`[BOT] ${name} spawned block #${block.blockId}`);
        }

        // ── Чат ──
        state.chatTimer -= dt;
        if (state.chatTimer <= 0) {
            state.chatTimer = 20 + Math.random() * 40;
            const phrase = buildPhrases[Math.floor(Math.random() * buildPhrases.length)];

            const w = new Writer();
            w.u8(PT.S_CHAT);
            w.u32(playerId);
            w.str(name);
            w.str(phrase);
            broadcast(room, w.build());
        }
    }, 50);

    bots.set(botId, { room, playerId, name, fakeWs, interval });
    return { botId, playerId, name, roomId: room.id };
}

function removeBot(botId) {
    const bot = bots.get(botId);
    if (!bot) return false;
    clearInterval(bot.interval);
    bot.room.clients.delete(bot.fakeWs);
    const w = new Writer();
    w.u8(PT.S_PLAYER_LEAVE);
    w.u32(bot.playerId);
    broadcast(bot.room, w.build());
    bots.delete(botId);
    console.log(`[BOT] Removed ${bot.name}`);
    return true;
}

// HTTP endpoints для ботов
app.post('/bots/add', (req, res) => {
    const name = (req.body && req.body.name) || 'Bot' + Math.floor(Math.random() * 1000);
    const bot = spawnBot(name);
    res.json({ ok: true, bot });
});

app.get('/bots', (req, res) => {
    const list = Array.from(bots.entries()).map(([id, b]) => ({
        botId: id,
        name: b.name,
        playerId: b.playerId,
        roomId: b.room.id
    }));
    res.json({ bots: list, count: list.length });
});

app.delete('/bots/:id', (req, res) => {
    const ok = removeBot(req.params.id);
    res.json({ ok });
});

app.delete('/bots', (req, res) => {
    let count = 0;
    for (const id of Array.from(bots.keys())) {
        if (removeBot(id)) count++;
    }
    res.json({ ok: true, removed: count });
});

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

            if (type === PT.C_HELLO) {
                const name = r.str();
                let userId = 0;
                try { userId = r.u32(); } catch(e){}

                if (userId === 0 || !name) {
                    console.log(`[WS] Rejected: no auth`);
                    ws.close();
                    return;
                }

                // Проверка дубликата userId
                let alreadyConnected = false;
                for (const rm of rooms.values()) {
                    for (const [, i] of rm.clients) {
                        if (i.userId === userId && !i.isBot) {
                            alreadyConnected = true;
                            break;
                        }
                    }
                    if (alreadyConnected) break;
                }

                if (alreadyConnected) {
                    console.log(`[WS] Rejected: userId ${userId} already connected`);
                    const w = new Writer();
                    w.u8(PT.S_CHAT);
                    w.u32(0);
                    w.str("System");
                    w.str("You are already connected from another session");
                    send(ws, w.build());
                    setTimeout(() => ws.close(), 500);
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

            if (type === PT.C_PING) {
                const seq = r.u32();
                const w = new Writer();
                w.u8(PT.S_PONG);
                w.u32(seq);
                send(ws, w.build());
                return;
            }

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

        // Считаем только реальных клиентов (не боты)
        let realClients = 0;
        for (const [wsx] of room.clients) {
            if (!wsx.isBot) realClients++;
        }
        if (realClients === 0 && rooms.size > 1) {
            for (const [id, b] of Array.from(bots.entries())) {
                if (b.room === room) removeBot(id);
            }
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
