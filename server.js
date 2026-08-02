const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const RAPIER = require('@dimforge/rapier3d-compat');

const app = express();
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════
//  Настройки
// ═══════════════════════════════════════
const PORT                 = process.env.PORT || 3000;
const MAX_PLAYERS_PER_ROOM = 20;
const MAX_BLOCKS_PER_ROOM  = 1000;
const PHYSICS_STEP         = 1.0 / 30.0;
const NET_SYNC_MS          = 50;
const SELF_URL             = process.env.SELF_URL || 'https://tucoriaserver.onrender.com';

// Rate limiting
const MAX_MSGS_PER_SEC     = 60;
const MAX_BLOCK_SPAWNS_SEC = 8;
const MAX_CHAT_PER_10_SEC  = 5;

// Настройки игрока
const PLAYER_MAX_HEALTH    = 100;
const RESPAWN_DELAY_MS     = 2500;

const rooms = new Map();
let nextRoomIdx = 1;

// ═══════════════════════════════════════
//  Logger
// ═══════════════════════════════════════
const log = {
    info: (...args)  => console.log('[INFO]', new Date().toISOString(), ...args),
    warn: (...args)  => console.warn('[WARN]', new Date().toISOString(), ...args),
    error: (...args) => console.error('[ERR ]', new Date().toISOString(), ...args),
    debug: (...args) => { if (process.env.DEBUG) console.log('[DBG ]', ...args); }
};

// ═══════════════════════════════════════
//  Keep-alive
// ═══════════════════════════════════════
setInterval(() => {
    https.get(SELF_URL + '/status').on('error', () => {});
}, 10 * 60 * 1000);

// ═══════════════════════════════════════
//  Комнаты
// ═══════════════════════════════════════
function createRoom() {
    const id = 'room_' + (nextRoomIdx++);
    const world = new RAPIER.World({ x: 0, y: -30, z: 0 });

    const room = {
        id,
        name: `TuCoria #${nextRoomIdx - 1}`,
        clients: new Map(),
        blocks: new Map(),
        rigidBodies: new Map(),
        nextPlayerId: 1,
        nextBlockId: 1,
        maxPlayers: MAX_PLAYERS_PER_ROOM,
        createdAt: Date.now(),
        world,
        lastPhysicsSync: 0,
        physicsActive: true
    };
    rooms.set(id, room);
    createDefaultScene(room);
    log.info(`Created room ${id}`);
    return room;
}

function findAvailableRoom() {
    for (const room of rooms.values()) {
        if (room.clients.size < room.maxPlayers) return room;
    }
    return createRoom();
}

function createRigidBodyForBlock(room, block) {
    if (!room.world) return null;

    let bodyDesc = block.anchored
        ? RAPIER.RigidBodyDesc.fixed()
        : RAPIER.RigidBodyDesc.dynamic()
            .setLinearDamping(0.5)
            .setAngularDamping(0.5)
            .setCanSleep(true);

    bodyDesc.setTranslation(block.position.x, block.position.y, block.position.z);
    bodyDesc.setRotation({
        x: block.rotation.x, y: block.rotation.y,
        z: block.rotation.z, w: block.rotation.w
    });

    const body = room.world.createRigidBody(bodyDesc);

    const hx = Math.max(block.size.x * 0.5, 0.05);
    const hy = Math.max(block.size.y * 0.5, 0.05);
    const hz = Math.max(block.size.z * 0.5, 0.05);

    let colliderDesc;
    switch (block.shape) {
        case 0: colliderDesc = RAPIER.ColliderDesc.cuboid(hx, hy, hz); break;
        case 1: colliderDesc = RAPIER.ColliderDesc.ball(Math.max(hx, hy, hz)); break;
        case 2:
        case 4: colliderDesc = RAPIER.ColliderDesc.cylinder(hy, Math.max(hx, hz)); break;
        case 3: colliderDesc = RAPIER.ColliderDesc.cuboid(hx, hy, hz); break;
        default: colliderDesc = RAPIER.ColliderDesc.cuboid(hx, hy, hz);
    }

    colliderDesc.setRestitution(0.3);
    colliderDesc.setFriction(0.6);
    if (block.canCollide === 0) colliderDesc.setSensor(true);

    room.world.createCollider(colliderDesc, body);
    return body;
}

function removeRigidBody(room, blockId) {
    const body = room.rigidBodies.get(blockId);
    if (body) {
        try { room.world.removeRigidBody(body); } catch (e) {}
        room.rigidBodies.delete(blockId);
    }
}

function createDefaultScene(room) {
    const baseplate = {
        blockId: room.nextBlockId++,
        shape: 0,
        position: { x: 0, y: -0.5, z: 0 },
        rotation: { w: 1, x: 0, y: 0, z: 0 },
        size: { x: 100, y: 1, z: 100 },
        color: { x: 40/255, y: 90/255, z: 40/255 },
        anchored: 1, canCollide: 1,
        roughness: 0.7, metallic: 0.0, transparency: 0.0,
        castShadow: 1, materialName: "Grass",
        name: "Baseplate", ownerId: 0
    };
    room.blocks.set(baseplate.blockId, baseplate);
    room.rigidBodies.set(baseplate.blockId, createRigidBodyForBlock(room, baseplate));
}

// ═══════════════════════════════════════
//  Валидация данных от клиента
// ═══════════════════════════════════════
function isValidVec3(v) {
    return v && typeof v.x === 'number' && typeof v.y === 'number' && typeof v.z === 'number'
        && isFinite(v.x) && isFinite(v.y) && isFinite(v.z);
}

function isValidQuat(q) {
    return q && typeof q.w === 'number' && typeof q.x === 'number'
        && typeof q.y === 'number' && typeof q.z === 'number'
        && isFinite(q.w) && isFinite(q.x) && isFinite(q.y) && isFinite(q.z);
}

function clamp(v, mn, mx) { return Math.max(mn, Math.min(mx, v)); }

function validateBlock(b) {
    if (!isValidVec3(b.position) || !isValidQuat(b.rotation)
        || !isValidVec3(b.size) || !isValidVec3(b.color)) return false;

    // Ограничения позиции
    if (Math.abs(b.position.x) > 5000 || Math.abs(b.position.y) > 5000 || Math.abs(b.position.z) > 5000)
        return false;

    // Размер
    b.size.x = clamp(b.size.x, 0.1, 200);
    b.size.y = clamp(b.size.y, 0.1, 200);
    b.size.z = clamp(b.size.z, 0.1, 200);

    // Цвет
    b.color.x = clamp(b.color.x, 0, 1);
    b.color.y = clamp(b.color.y, 0, 1);
    b.color.z = clamp(b.color.z, 0, 1);

    // Параметры
    b.roughness    = clamp(b.roughness,    0, 1);
    b.metallic     = clamp(b.metallic,     0, 1);
    b.transparency = clamp(b.transparency, 0, 1);
    b.shape        = clamp(b.shape,        0, 4);
    b.anchored     = b.anchored ? 1 : 0;
    b.canCollide   = b.canCollide ? 1 : 0;
    b.castShadow   = b.castShadow ? 1 : 0;

    // Строки
    if (typeof b.name !== 'string') b.name = 'Part';
    if (b.name.length > 64) b.name = b.name.substring(0, 64);
    if (typeof b.materialName !== 'string') b.materialName = '';
    if (b.materialName.length > 32) b.materialName = b.materialName.substring(0, 32);

    return true;
}

// ═══════════════════════════════════════
//  Физика
// ═══════════════════════════════════════
function physicsStep() {
    const now = Date.now();
    for (const room of rooms.values()) {
        if (!room.world || !room.physicsActive) continue;
        if (room.clients.size === 0) continue;

        let hasDynamic = false;
        for (const [, block] of room.blocks) {
            if (!block.anchored) { hasDynamic = true; break; }
        }
        if (!hasDynamic) continue;

        try {
            room.world.timestep = PHYSICS_STEP;
            room.world.step();
        } catch (e) {
            log.error(`Physics step error in ${room.id}:`, e.message);
            continue;
        }

        if (now - room.lastPhysicsSync >= NET_SYNC_MS) {
            room.lastPhysicsSync = now;
            try { syncPhysicsToClients(room); }
            catch (e) { log.error(`Physics sync error:`, e.message); }
        }
    }
}

function syncPhysicsToClients(room) {
    const updates = [];
    const toDelete = [];

    for (const [blockId, body] of room.rigidBodies) {
        const block = room.blocks.get(blockId);
        if (!block || block.anchored) continue;

        const p = body.translation();

        if (p.y < -100) {
            toDelete.push(blockId);
            continue;
        }

        if (body.isSleeping()) continue;

        const r = body.rotation();
        block.position = { x: p.x, y: p.y, z: p.z };
        block.rotation = { w: r.w, x: r.x, y: r.y, z: r.z };
        updates.push({ blockId, position: block.position, rotation: block.rotation });
    }

    for (const blockId of toDelete) {
        removeRigidBody(room, blockId);
        room.blocks.delete(blockId);
        const w = new Writer();
        w.u8(PT.S_BLOCK_DELETE);
        w.u32(blockId);
        broadcast(room, w.build());
    }

    if (updates.length === 0) return;

    const w = new Writer();
    w.u8(PT.S_PHYSICS_STATE);
    w.u32(updates.length);
    for (const u of updates) {
        w.u32(u.blockId);
        w.vec3(u.position);
        w.quat(u.rotation);
    }
    broadcast(room, w.build());
}

setInterval(physicsStep, 1000 / 30);

// ═══════════════════════════════════════
//  HTTP endpoints
// ═══════════════════════════════════════
app.get('/', (req, res) => {
    res.setHeader('Cache-Control', 'no-cache');
    res.send('TuCoria Server v0.8 OK');
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', uptime: Math.floor(process.uptime()) });
});

app.get('/servers', (req, res) => {
    const list = Array.from(rooms.values()).map(r => ({
        id: r.id, name: r.name,
        players: r.clients.size, maxPlayers: r.maxPlayers,
        blocks: r.blocks.size,
        uptime: Math.floor((Date.now() - r.createdAt) / 1000)
    }));
    res.json({ servers: list, count: list.length });
});

app.get('/status', (req, res) => {
    const mem = process.memoryUsage();
    let totalBlocks = 0, totalBodies = 0, totalClients = 0;
    for (const room of rooms.values()) {
        totalBlocks += room.blocks.size;
        totalBodies += room.rigidBodies.size;
        totalClients += room.clients.size;
    }
    res.json({
        version: '0.8',
        uptime: Math.floor(process.uptime()),
        memoryMB: Math.round(mem.rss / 1024 / 1024),
        heapMB: Math.round(mem.heapUsed / 1024 / 1024),
        rooms: rooms.size,
        totalBlocks, totalBodies, totalClients,
        bots: bots.size
    });
});

app.post('/crash', (req, res) => {
    res.json({ ok: true });
    setTimeout(() => process.exit(1), 500);
});

app.post('/kickall', (req, res) => {
    let count = 0;
    for (const [id, b] of bots) clearInterval(b.interval);
    bots.clear();
    for (const room of rooms.values()) {
        for (const [ws] of room.clients) {
            if (!ws.isBot && ws.readyState === WebSocket.OPEN) {
                try { ws.close(); count++; } catch(e){}
            }
        }
        room.clients.clear();
    }
    res.json({ ok: true, disconnected: count });
});

// ═══════════════════════════════════════
//  WebSocket
// ═══════════════════════════════════════
const server = http.createServer(app);
const wss = new WebSocket.Server({
    server,
    path: '/ws',
    perMessageDeflate: false,
    maxPayload: 512 * 1024,
    clientTracking: true
});

const PT = {
    // Server -> Client
    S_WELCOME:        1,
    S_PLAYER_JOIN:    2,
    S_PLAYER_LEAVE:   3,
    S_PLAYER_STATE:   4,
    S_CHAT:           5,
    S_PING:           6,
    S_PONG:           7,
    S_PLAYER_HEALTH:  8,   // ← НОВОЕ
    S_PLAYER_DEATH:   9,   // ← НОВОЕ
    S_PLAYER_RESPAWN: 10,  // ← НОВОЕ

    S_BLOCK_SPAWN:   20,
    S_BLOCK_UPDATE:  21,
    S_BLOCK_DELETE:  22,
    S_BLOCK_LIST:    23,
    S_PHYSICS_STATE: 24,

    // Client -> Server
    C_HELLO:         100,
    C_PLAYER_STATE:  101,
    C_CHAT:          102,
    C_PING:          103,
    C_PONG:          104,
    C_PLAYER_HEALTH: 105,  // ← НОВОЕ
    C_PLAYER_DEATH:  106,  // ← НОВОЕ
    C_REQUEST_RESPAWN: 107, // ← НОВОЕ

    C_BLOCK_SPAWN:   120,
    C_BLOCK_UPDATE:  121,
    C_BLOCK_DELETE:  122
};

class Reader {
    constructor(buf) { this.buf = buf; this.pos = 0; }
    u8()  { const v = this.buf.readUInt8(this.pos); this.pos += 1; return v; }
    u16() { const v = this.buf.readUInt16LE(this.pos); this.pos += 2; return v; }
    u32() { const v = this.buf.readUInt32LE(this.pos); this.pos += 4; return v; }
    f32() { const v = this.buf.readFloatLE(this.pos); this.pos += 4; return v; }
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
            blockId: this.u32(), shape: this.u8(),
            position: this.vec3(), rotation: this.quat(),
            size: this.vec3(), color: this.vec3(),
            anchored: this.u8(), canCollide: this.u8(),
            roughness: this.f32(), metallic: this.f32(), transparency: this.f32(),
            castShadow: this.u8(),
            materialName: this.str(), name: this.str(),
            ownerId: this.u32()
        };
    }
}

class Writer {
    constructor() { this.chunks = []; }
    u8(v)  { const b = Buffer.alloc(1); b.writeUInt8(v, 0); this.chunks.push(b); }
    u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); this.chunks.push(b); }
    u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); this.chunks.push(b); }
    f32(v) { const b = Buffer.alloc(4); b.writeFloatLE(v, 0); this.chunks.push(b); }
    vec3(v) { this.f32(v.x); this.f32(v.y); this.f32(v.z); }
    quat(v) { this.f32(v.w); this.f32(v.x); this.f32(v.y); this.f32(v.z); }
    str(s) {
        const buf = Buffer.from(s || '', 'utf8');
        this.u16(buf.length);
        if (buf.length > 0) this.chunks.push(buf);
    }
    writeBlock(b) {
        this.u32(b.blockId); this.u8(b.shape);
        this.vec3(b.position); this.quat(b.rotation);
        this.vec3(b.size); this.vec3(b.color);
        this.u8(b.anchored); this.u8(b.canCollide);
        this.f32(b.roughness); this.f32(b.metallic); this.f32(b.transparency);
        this.u8(b.castShadow);
        this.str(b.materialName); this.str(b.name);
        this.u32(b.ownerId);
    }
    build() { return Buffer.concat(this.chunks); }
}

function send(ws, buf) {
    if (ws.isBot) return;
    if (ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(buf); } catch (e) {}
}

function broadcast(room, buf, exclude = null) {
    for (const [ws] of room.clients) {
        if (ws === exclude) continue;
        send(ws, buf);
    }
}

// ═══════════════════════════════════════
//  Боты
// ═══════════════════════════════════════
let nextBotUserId = 1000000;
const bots = new Map();

function spawnBot(name = 'Bot') {
    const room = findAvailableRoom();
    const playerId = room.nextPlayerId++;
    const userId = nextBotUserId++;
    const botId = 'bot_' + userId;

    const info = {
        playerId, name, userId, isBot: true,
        health: PLAYER_MAX_HEALTH, isDead: false,
        rateLimits: null
    };
    const fakeWs = { readyState: 1, send: () => {}, isBot: true, botId };
    room.clients.set(fakeWs, info);

    const jw = new Writer();
    jw.u8(PT.S_PLAYER_JOIN);
    jw.u32(playerId);
    jw.str(name);
    broadcast(room, jw.build());

    const pos = { x: (Math.random()-0.5)*20, y: 5, z: (Math.random()-0.5)*20 };
    const yaw = Math.random() * 360;

    const interval = setInterval(() => {
        if (!rooms.has(room.id)) { clearInterval(interval); return; }
        const w = new Writer();
        w.u8(PT.S_PLAYER_STATE);
        w.u32(playerId);
        w.vec3(pos); w.f32(yaw); w.u8(0); w.u8(0);
        broadcast(room, w.build());
    }, 2000);

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
    return true;
}

app.post('/bots/add', (req, res) => {
    const name = (req.body && req.body.name) || 'Bot' + Math.floor(Math.random()*1000);
    res.json({ ok: true, bot: spawnBot(name) });
});
app.get('/bots', (req, res) => {
    const list = Array.from(bots.entries()).map(([id, b]) => ({
        botId: id, name: b.name, playerId: b.playerId, roomId: b.room.id
    }));
    res.json({ bots: list, count: list.length });
});
app.delete('/bots/:id', (req, res) => res.json({ ok: removeBot(req.params.id) }));
app.delete('/bots', (req, res) => {
    let count = 0;
    for (const id of Array.from(bots.keys())) if (removeBot(id)) count++;
    res.json({ ok: true, removed: count });
});

// ═══════════════════════════════════════
//  Rate limiting
// ═══════════════════════════════════════
function createRateLimits() {
    return {
        msgCount: 0,
        msgResetAt: Date.now() + 1000,
        blockSpawnCount: 0,
        blockSpawnResetAt: Date.now() + 1000,
        chatCount: 0,
        chatResetAt: Date.now() + 10000
    };
}

function checkRate(rl, type) {
    const now = Date.now();

    if (type === 'msg') {
        if (now > rl.msgResetAt) { rl.msgCount = 0; rl.msgResetAt = now + 1000; }
        rl.msgCount++;
        return rl.msgCount <= MAX_MSGS_PER_SEC;
    }
    if (type === 'block') {
        if (now > rl.blockSpawnResetAt) { rl.blockSpawnCount = 0; rl.blockSpawnResetAt = now + 1000; }
        rl.blockSpawnCount++;
        return rl.blockSpawnCount <= MAX_BLOCK_SPAWNS_SEC;
    }
    if (type === 'chat') {
        if (now > rl.chatResetAt) { rl.chatCount = 0; rl.chatResetAt = now + 10000; }
        rl.chatCount++;
        return rl.chatCount <= MAX_CHAT_PER_10_SEC;
    }
    return true;
}

// ═══════════════════════════════════════
//  Health System — helpers
// ═══════════════════════════════════════
function broadcastPlayerHealth(room, info) {
    const w = new Writer();
    w.u8(PT.S_PLAYER_HEALTH);
    w.u32(info.playerId);
    w.f32(info.health);
    broadcast(room, w.build());
}

function broadcastPlayerDeath(room, info) {
    const w = new Writer();
    w.u8(PT.S_PLAYER_DEATH);
    w.u32(info.playerId);
    broadcast(room, w.build());
}

function broadcastPlayerRespawn(room, info) {
    const w = new Writer();
    w.u8(PT.S_PLAYER_RESPAWN);
    w.u32(info.playerId);
    w.f32(info.health);
    broadcast(room, w.build());
}

// ═══════════════════════════════════════
//  WebSocket handlers
// ═══════════════════════════════════════
wss.on('connection', (ws, req) => {
    // Читаем реальный IP из Cloudflare header если есть
    const realIP = req.headers['cf-connecting-ip']
                || req.headers['x-forwarded-for']
                || req.socket.remoteAddress;

    ws.isAlive = true;
    ws.room = null;
    ws.info = null;
    ws.lastMessageTime = Date.now();
    ws.realIP = realIP;
    ws.rateLimits = createRateLimits();

    log.debug(`Connection from ${realIP}`);

    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data) => {
        ws.lastMessageTime = Date.now();

        // Rate limit
        if (!checkRate(ws.rateLimits, 'msg')) {
            log.warn(`Rate limit exceeded for ${ws.realIP}`);
            try { ws.close(1008, 'Rate limit exceeded'); } catch(e){}
            return;
        }

        try {
            const r = new Reader(data);
            const type = r.u8();

            // ─── HELLO ───
            if (type === PT.C_HELLO) {
                const name = r.str();
                let userId = 0;
                try { userId = r.u32(); } catch(e){}
                if (userId === 0 || !name || name.length > 32) {
                    log.warn(`Invalid hello from ${ws.realIP}`);
                    ws.close(); return;
                }

                // Проверка на дубликаты
                let alreadyConnected = false;
                for (const rm of rooms.values()) {
                    for (const [, i] of rm.clients) {
                        if (i.userId === userId && !i.isBot) {
                            alreadyConnected = true; break;
                        }
                    }
                    if (alreadyConnected) break;
                }
                if (alreadyConnected) {
                    const w = new Writer();
                    w.u8(PT.S_CHAT); w.u32(0);
                    w.str("System");
                    w.str("You are already connected from another session");
                    send(ws, w.build());
                    setTimeout(() => { try { ws.close(); } catch(e){} }, 500);
                    return;
                }

                const room = findAvailableRoom();
                const playerId = room.nextPlayerId++;
                const info = {
                    playerId, name, userId,
                    health: PLAYER_MAX_HEALTH,
                    isDead: false,
                    lastPosition: { x: 0, y: 5, z: 0 },
                    joinedAt: Date.now()
                };
                room.clients.set(ws, info);
                ws.room = room;
                ws.info = info;

                // Welcome
                const w = new Writer();
                w.u8(PT.S_WELCOME);
                w.u32(playerId);
                const others = Array.from(room.clients.entries())
                    .filter(([wsx]) => wsx !== ws)
                    .map(([, i]) => i);
                w.u32(others.length);
                for (const o of others) { w.u32(o.playerId); w.str(o.name); }
                send(ws, w.build());

                // Block list
                const bw = new Writer();
                bw.u8(PT.S_BLOCK_LIST);
                bw.u32(room.blocks.size);
                for (const b of room.blocks.values()) bw.writeBlock(b);
                send(ws, bw.build());

                // Health других игроков
                for (const o of others) {
                    const hw = new Writer();
                    hw.u8(PT.S_PLAYER_HEALTH);
                    hw.u32(o.playerId);
                    hw.f32(o.health);
                    send(ws, hw.build());
                }

                // Оповещаем других
                const jw = new Writer();
                jw.u8(PT.S_PLAYER_JOIN);
                jw.u32(playerId); jw.str(name);
                broadcast(room, jw.build(), ws);

                log.info(`Player joined: ${name} (id=${playerId}, room=${room.id}, ip=${realIP})`);
                return;
            }

            const room = ws.room;
            const info = ws.info;
            if (!room || !info) return;

            // ─── PLAYER STATE ───
            if (type === PT.C_PLAYER_STATE) {
                const pos = r.vec3();
                const yaw = r.f32();
                const anim = r.u8();
                const crouch = r.u8();

                if (!isValidVec3(pos) || !isFinite(yaw)) return;
                if (Math.abs(pos.x) > 5000 || Math.abs(pos.y) > 5000 || Math.abs(pos.z) > 5000) return;

                info.lastPosition = pos;

                const w = new Writer();
                w.u8(PT.S_PLAYER_STATE); w.u32(info.playerId);
                w.vec3(pos); w.f32(yaw); w.u8(anim); w.u8(crouch);
                broadcast(room, w.build(), ws);
                return;
            }

            // ─── CHAT ───
            if (type === PT.C_CHAT) {
                if (!checkRate(ws.rateLimits, 'chat')) {
                    const w = new Writer();
                    w.u8(PT.S_CHAT); w.u32(0);
                    w.str("System");
                    w.str("Slow down! You're chatting too fast.");
                    send(ws, w.build());
                    return;
                }
                let text = r.str();
                if (!text) return;
                if (text.length > 200) text = text.substring(0, 200);

                const w = new Writer();
                w.u8(PT.S_CHAT); w.u32(info.playerId);
                w.str(info.name); w.str(text);
                broadcast(room, w.build());
                return;
            }

            // ─── PING ───
            if (type === PT.C_PING) {
                const seq = r.u32();
                const w = new Writer();
                w.u8(PT.S_PONG); w.u32(seq);
                send(ws, w.build());
                return;
            }

            // ─── PLAYER HEALTH ───
            if (type === PT.C_PLAYER_HEALTH) {
                let hp = r.f32();
                if (!isFinite(hp)) return;
                hp = clamp(hp, 0, PLAYER_MAX_HEALTH);

                if (info.isDead) return;
                info.health = hp;
                broadcastPlayerHealth(room, info);
                return;
            }

            // ─── PLAYER DEATH ───
            if (type === PT.C_PLAYER_DEATH) {
                if (info.isDead) return;
                info.isDead = true;
                info.health = 0;
                broadcastPlayerDeath(room, info);

                // Автоматический респавн через delay
                setTimeout(() => {
                    if (!ws.info || !ws.room) return;
                    info.isDead = false;
                    info.health = PLAYER_MAX_HEALTH;
                    broadcastPlayerRespawn(room, info);
                }, RESPAWN_DELAY_MS);
                return;
            }

            // ─── REQUEST RESPAWN ───
            if (type === PT.C_REQUEST_RESPAWN) {
                if (!info.isDead) return;
                info.isDead = false;
                info.health = PLAYER_MAX_HEALTH;
                broadcastPlayerRespawn(room, info);
                return;
            }

            // ─── BLOCK SPAWN ───
            if (type === PT.C_BLOCK_SPAWN) {
                if (!checkRate(ws.rateLimits, 'block')) {
                    const w = new Writer();
                    w.u8(PT.S_CHAT); w.u32(0);
                    w.str("System");
                    w.str("Slow down! Spawning too fast.");
                    send(ws, w.build());
                    return;
                }

                if (room.blocks.size >= MAX_BLOCKS_PER_ROOM) {
                    const w = new Writer();
                    w.u8(PT.S_CHAT); w.u32(0);
                    w.str("System");
                    w.str("Block limit reached (" + MAX_BLOCKS_PER_ROOM + ")");
                    send(ws, w.build());
                    return;
                }

                const b = r.readBlock();
                if (!validateBlock(b)) return;

                b.blockId = room.nextBlockId++;
                b.ownerId = info.playerId;
                room.blocks.set(b.blockId, b);

                const body = createRigidBodyForBlock(room, b);
                if (body) {
                    room.rigidBodies.set(b.blockId, body);
                    if (!b.anchored) body.wakeUp();
                }

                const w = new Writer();
                w.u8(PT.S_BLOCK_SPAWN);
                w.writeBlock(b);
                broadcast(room, w.build(), ws);
                send(ws, w.build());
                return;
            }

            // ─── BLOCK UPDATE ───
            if (type === PT.C_BLOCK_UPDATE) {
                const b = r.readBlock();
                if (!validateBlock(b)) return;
                if (!room.blocks.has(b.blockId)) return;

                const oldBlock = room.blocks.get(b.blockId);
                room.blocks.set(b.blockId, b);

                const needRecreate =
                    oldBlock.shape !== b.shape ||
                    oldBlock.anchored !== b.anchored ||
                    oldBlock.canCollide !== b.canCollide ||
                    Math.abs(oldBlock.size.x - b.size.x) > 0.01 ||
                    Math.abs(oldBlock.size.y - b.size.y) > 0.01 ||
                    Math.abs(oldBlock.size.z - b.size.z) > 0.01;

                if (needRecreate) {
                    removeRigidBody(room, b.blockId);
                    const body = createRigidBodyForBlock(room, b);
                    if (body) {
                        room.rigidBodies.set(b.blockId, body);
                        if (!b.anchored) body.wakeUp();
                    }
                } else {
                    const body = room.rigidBodies.get(b.blockId);
                    if (body) {
                        body.setTranslation(b.position, true);
                        body.setRotation({
                            x: b.rotation.x, y: b.rotation.y,
                            z: b.rotation.z, w: b.rotation.w
                        }, true);
                        body.setLinvel({x:0, y:0, z:0}, true);
                        body.setAngvel({x:0, y:0, z:0}, true);
                        body.wakeUp();
                    }
                }

                const w = new Writer();
                w.u8(PT.S_BLOCK_UPDATE);
                w.writeBlock(b);
                broadcast(room, w.build(), ws);
                return;
            }

            // ─── BLOCK DELETE ───
            if (type === PT.C_BLOCK_DELETE) {
                const blockId = r.u32();
                if (!room.blocks.has(blockId)) return;
                room.blocks.delete(blockId);
                removeRigidBody(room, blockId);
                const w = new Writer();
                w.u8(PT.S_BLOCK_DELETE);
                w.u32(blockId);
                broadcast(room, w.build());
                return;
            }

        } catch (e) {
            log.error('WS msg error:', e.message);
        }
    });

    ws.on('close', () => {
        const room = ws.room;
        const info = ws.info;
        ws.room = null;
        ws.info = null;

        if (!room || !info) return;
        room.clients.delete(ws);

        const w = new Writer();
        w.u8(PT.S_PLAYER_LEAVE);
        w.u32(info.playerId);
        broadcast(room, w.build());

        log.info(`Player left: ${info.name} (id=${info.playerId})`);

        // Cleanup пустых комнат
        let realClients = 0;
        for (const [wsx] of room.clients) if (!wsx.isBot) realClients++;
        if (realClients === 0 && rooms.size > 1) {
            try {
                for (const body of room.rigidBodies.values()) {
                    try { room.world.removeRigidBody(body); } catch(e) {}
                }
                room.rigidBodies.clear();
                if (room.world) { room.world.free(); room.world = null; }
            } catch (e) {
                log.error('Cleanup error:', e.message);
            }
            for (const [id, b] of Array.from(bots.entries())) {
                if (b.room === room) removeBot(id);
            }
            rooms.delete(room.id);
            log.info(`Removed empty room ${room.id}`);
        }
    });

    ws.on('error', (e) => {
        log.debug(`WS error from ${ws.realIP}: ${e.message}`);
    });
});

// ═══════════════════════════════════════
//  Heartbeat
// ═══════════════════════════════════════
setInterval(() => {
    const now = Date.now();
    wss.clients.forEach((ws) => {
        if (ws.lastMessageTime && now - ws.lastMessageTime > 120000) {
            try { ws.terminate(); } catch(e){}
            return;
        }
        if (ws.isAlive === false) {
            try { ws.terminate(); } catch(e){}
            return;
        }
        ws.isAlive = false;
        try { ws.ping(); } catch(e){}
    });
}, 15000);

// ═══════════════════════════════════════
//  Crash handlers
// ═══════════════════════════════════════
process.on('uncaughtException', (err) => {
    log.error('FATAL Uncaught:', err.message);
    log.error(err.stack);
});

process.on('unhandledRejection', (reason) => {
    log.error('FATAL Rejection:', reason);
});

process.on('SIGTERM', () => {
    log.info('SIGTERM received, closing...');
    wss.clients.forEach((ws) => {
        try { ws.close(); } catch(e){}
    });
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 5000);
});

// ═══════════════════════════════════════
//  Запуск
// ═══════════════════════════════════════
(async () => {
    try {
        await RAPIER.init();
        server.listen(PORT, () => {
            log.info(`TuCoria Server v0.8 listening on port ${PORT}`);
        });
    } catch (e) {
        log.error('Startup failed:', e);
        process.exit(1);
    }
})();
