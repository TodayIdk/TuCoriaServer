const express = require('express');
const cors = require('cors');
const http = require('http');
const https = require('https');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const RAPIER = require('@dimforge/rapier3d-compat');

const app = express();
app.use(cors());
app.use(express.json());

const PORT                 = process.env.PORT || 3000;
const MAX_PLAYERS_PER_ROOM = 20;
const MAX_BLOCKS_PER_ROOM  = 1000;
const MAX_PISTONS_PER_ROOM = 100;
const MAX_LEVERS_PER_ROOM  = 100;
const MAX_SEATS_PER_ROOM   = 100;
const MAX_ENGINES_PER_ROOM = 100;
const MAX_PROPS_PER_ROOM   = 100;
const PHYSICS_STEP         = 1.0 / 30.0;
const NET_SYNC_MS          = 50;
const PISTON_SYNC_MS       = 50;
const AUTO_SAVE_MS         = 30000; // Автосохранение каждые 30 секунд
const SELF_URL             = process.env.SELF_URL || 'https://tucoriaserver.onrender.com';
const MAX_MSGS_PER_SEC     = 120;
const MAX_BLOCK_SPAWNS_SEC = 8;
const MAX_CHAT_PER_10_SEC  = 5;
const PLAYER_MAX_HEALTH    = 100;
const RESPAWN_DELAY_MS     = 2500;

const SAVE_FILE_PATH = path.join(__dirname, 'world_save.json');

const rooms = new Map();
let nextRoomIdx = 1;

const log = {
    info: (...a)  => console.log('[INFO]', new Date().toISOString(), ...a),
    warn: (...a)  => console.warn('[WARN]', new Date().toISOString(), ...a),
    error: (...a) => console.error('[ERR ]', new Date().toISOString(), ...a),
    debug: (...a) => { if (process.env.DEBUG) console.log('[DBG ]', ...a); }
};

setInterval(() => {
    https.get(SELF_URL + '/status').on('error', () => {});
}, 10 * 60 * 1000);

// ═══════════════════════════════════════════════════════════
//  PERSISTENCE SYSTEM (СОХРАНЕНИЕ И ЗАГРУЗКА КАРТЫ)
// ═══════════════════════════════════════════════════════════

function saveRoomStateToFile(room) {
    if (!room) return false;
    try {
        const data = {
            version: 1,
            savedAt: new Date().toISOString(),
            blocks: Array.from(room.blocks.values()),
            pistons: Array.from(room.pistons.values()).map(p => ({
                pistonId: p.pistonId, position: p.position, rotation: p.rotation,
                extendDistance: p.extendDistance, extendSpeed: p.extendSpeed,
                currentOffset: p.currentOffset, extended: p.extended,
                color: p.color, scale: p.scale, isDefault: p.isDefault, ownerId: p.ownerId
            })),
            levers: Array.from(room.levers.values()).map(l => ({
                leverId: l.leverId, position: l.position, rotation: l.rotation,
                scale: l.scale, active: l.active, linkedPistons: l.linkedPistons,
                isDefault: l.isDefault, ownerId: l.ownerId
            })),
            seats: Array.from(room.seats.values()).map(s => ({
                seatId: s.seatId, position: s.position, rotation: s.rotation,
                isDriver: s.isDriver, isDefault: s.isDefault, ownerId: s.ownerId
            })),
            engines: Array.from(room.engines.values()).map(e => ({
                engineId: e.engineId, position: e.position, rotation: e.rotation,
                active: e.active, linkedPropellers: e.linkedPropellers,
                isDefault: e.isDefault, ownerId: e.ownerId
            })),
            props: Array.from(room.props.values()).map(pr => ({
                propellerId: pr.propellerId, position: pr.position, rotation: pr.rotation,
                isDefault: pr.isDefault, ownerId: pr.ownerId
            }))
        };

        fs.writeFileSync(SAVE_FILE_PATH, JSON.stringify(data, null, 2), 'utf8');
        log.info(`Saved room ${room.id} state to ${SAVE_FILE_PATH}`);
        return true;
    } catch (e) {
        log.error(`Failed to save room state: ${e.message}`);
        return false;
    }
}

function loadRoomStateFromFile(room) {
    if (!fs.existsSync(SAVE_FILE_PATH)) return false;
    try {
        const raw = fs.readFileSync(SAVE_FILE_PATH, 'utf8');
        const data = JSON.parse(raw);

        // Очищаем старый мир
        for (const body of room.rigidBodies.values()) {
            try { room.world.removeRigidBody(body); } catch(e){}
        }
        for (const p of room.pistons.values()) removePistonBodies(room, p);

        room.blocks.clear(); room.rigidBodies.clear();
        room.pistons.clear(); room.levers.clear();
        room.seats.clear(); room.engines.clear(); room.props.clear();

        let maxBlockId = 0, maxPistonId = 0, maxLeverId = 0, maxSeatId = 0, maxEngId = 0, maxPropId = 0;

        // Восстановление Блоков
        if (Array.isArray(data.blocks)) {
            for (const b of data.blocks) {
                if (!validateBlock(b)) continue;
                room.blocks.set(b.blockId, b);
                const body = createRigidBodyForBlock(room, b);
                if (body) room.rigidBodies.set(b.blockId, body);
                if (b.blockId > maxBlockId) maxBlockId = b.blockId;
            }
        }

        // Восстановление Поршней
        if (Array.isArray(data.pistons)) {
            for (const pData of data.pistons) {
                const p = createPistonData(room, pData.position, pData.isDefault === 1);
                p.pistonId = pData.pistonId;
                if (pData.rotation) p.rotation = pData.rotation;
                p.extendDistance = pData.extendDistance || 2.0;
                p.extendSpeed = pData.extendSpeed || 3.0;
                p.currentOffset = pData.currentOffset || 0.0;
                p.extended = !!pData.extended;
                if (pData.color) p.color = pData.color;
                p.scale = pData.scale || 0.08;
                p.ownerId = pData.ownerId || 0;

                room.pistons.set(p.pistonId, p);
                createPistonBodies(room, p);
                if (p.pistonId > maxPistonId) maxPistonId = p.pistonId;
            }
        }

        // Восстановление Рычагов
        if (Array.isArray(data.levers)) {
            for (const lData of data.levers) {
                const l = createLeverData(room, lData.position, lData.isDefault === 1);
                l.leverId = lData.leverId;
                if (lData.rotation) l.rotation = lData.rotation;
                l.scale = lData.scale || 0.1;
                l.active = !!lData.active;
                l.linkedPistons = Array.isArray(lData.linkedPistons) ? lData.linkedPistons : [];
                l.ownerId = lData.ownerId || 0;

                room.levers.set(l.leverId, l);
                if (l.leverId > maxLeverId) maxLeverId = l.leverId;
            }
        }

        // Восстановление Сидений
        if (Array.isArray(data.seats)) {
            for (const sData of data.seats) {
                const s = createSeatData(room, sData.position, sData.isDriver === 1, sData.isDefault === 1);
                s.seatId = sData.seatId;
                if (sData.rotation) s.rotation = sData.rotation;
                s.ownerId = sData.ownerId || 0;

                room.seats.set(s.seatId, s);
                if (s.seatId > maxSeatId) maxSeatId = s.seatId;
            }
        }

        // Обновляем счетчики ID
        room.nextBlockId = maxBlockId + 1;
        room.nextPistonId = maxPistonId + 1;
        room.nextLeverId = maxLeverId + 1;
        room.nextSeatId = maxSeatId + 1;

        log.info(`Successfully loaded world from ${SAVE_FILE_PATH} (${room.blocks.size} blocks, ${room.seats.size} seats, ${room.pistons.size} pistons)`);
        return true;
    } catch (e) {
        log.error(`Failed to load room state from file: ${e.message}`);
        return false;
    }
}

// ═══ Piston helpers ═══
function createPistonBodies(room, piston) {
    const frameDesc = RAPIER.RigidBodyDesc.fixed()
        .setTranslation(piston.position.x, piston.position.y + piston.frameHalf.y, piston.position.z);
    const frameBody = room.world.createRigidBody(frameDesc);
    room.world.createCollider(
        RAPIER.ColliderDesc.cuboid(piston.frameHalf.x, piston.frameHalf.y, piston.frameHalf.z)
            .setFriction(0.9).setRestitution(0.1), frameBody);

    const headBaseY = piston.position.y + piston.frameHalf.y * 2 + piston.headHalf.y;
    const headDesc = RAPIER.RigidBodyDesc.kinematicPositionBased()
        .setTranslation(piston.position.x, headBaseY, piston.position.z);
    const headBody = room.world.createRigidBody(headDesc);
    room.world.createCollider(
        RAPIER.ColliderDesc.cuboid(piston.headHalf.x, piston.headHalf.y, piston.headHalf.z)
            .setFriction(0.95).setRestitution(0.05), headBody);

    piston.frameBody = frameBody;
    piston.headBody = headBody;
    piston.headBaseY = headBaseY;
}

function removePistonBodies(room, piston) {
    if (piston.frameBody) { try { room.world.removeRigidBody(piston.frameBody); } catch(e){} piston.frameBody = null; }
    if (piston.headBody)  { try { room.world.removeRigidBody(piston.headBody);  } catch(e){} piston.headBody  = null; }
}

function updatePistonHead(room, piston, dt) {
    const target = piston.extended ? piston.extendDistance : 0.0;
    const dir = Math.sign(target - piston.currentOffset);
    if (dir !== 0) {
        piston.currentOffset += dir * piston.extendSpeed * dt;
        if ((dir > 0 && piston.currentOffset >= target) || (dir < 0 && piston.currentOffset <= target))
            piston.currentOffset = target;
        piston.dirty = true;
    }
    if (piston.headBody) {
        piston.headBody.setNextKinematicTranslation({
            x: piston.position.x,
            y: piston.headBaseY + piston.currentOffset,
            z: piston.position.z
        });
    }
}

function createPistonData(room, position, isDefault = false) {
    return {
        pistonId: room.nextPistonId++, position,
        extendDistance: 2.0, extendSpeed: 3.0, currentOffset: 0.0, extended: false,
        frameHalf: { x: 0.6, y: 0.3, z: 0.6 },
        headHalf:  { x: 0.55, y: 0.08, z: 0.55 },
        color: { x: 1.0, y: 1.0, z: 1.0 },
        scale: 0.08, rotation: { x: 0, y: 0, z: 0 },
        isDefault: isDefault ? 1 : 0, ownerId: 0,
        frameBody: null, headBody: null, headBaseY: 0, dirty: true
    };
}

// ═══ Lever helpers ═══
function createLeverData(room, position, isDefault = false) {
    return {
        leverId: room.nextLeverId++, position,
        rotation: { x: 0, y: 0, z: 0 }, scale: 0.1,
        active: false, linkedPistons: [],
        isDefault: isDefault ? 1 : 0, ownerId: 0
    };
}

function toggleLever(room, lever) {
    lever.active = !lever.active;
    for (const pid of lever.linkedPistons) {
        const p = room.pistons.get(pid);
        if (p) { p.extended = lever.active; p.dirty = true; }
    }
    const w = new Writer();
    w.u8(PT.S_LEVER_STATE); w.u32(lever.leverId); w.u8(lever.active ? 1 : 0);
    broadcast(room, w.build());
    if (lever.linkedPistons.length > 0) {
        const pw = new Writer();
        pw.u8(PT.S_PISTON_STATE);
        const valid = lever.linkedPistons.filter(pid => room.pistons.has(pid));
        pw.u32(valid.length);
        for (const pid of valid) {
            const p = room.pistons.get(pid);
            pw.u32(p.pistonId); pw.f32(p.currentOffset); pw.u8(p.extended ? 1 : 0);
        }
        broadcast(room, pw.build());
    }
}

// ═══ Seat helpers ═══
function createSeatData(room, position, isDriver, isDefault = false) {
    return {
        seatId: room.nextSeatId++, position,
        rotation: { x: 0, y: 0, z: 0 },
        isDriver: isDriver ? 1 : 0,
        occupantId: 0,
        isDefault: isDefault ? 1 : 0, ownerId: 0,
        throttle: 0.0, steer: 0.0
    };
}

function releaseSeatByPlayer(room, playerId) {
    for (const s of room.seats.values()) {
        if (s.occupantId === playerId) {
            s.occupantId = 0;
            s.throttle = 0; s.steer = 0;
            const w = new Writer();
            w.u8(PT.S_SEAT_STATE);
            w.u32(s.seatId); w.u32(0);
            broadcast(room, w.build());
        }
    }
}

// ═══ Engine helpers ═══
function createEngineData(room, position, isDefault = false) {
    return {
        engineId: room.nextEngineId++, position,
        rotation: { x: 0, y: 0, z: 0 },
        active: false, linkedPropellers: [],
        isDefault: isDefault ? 1 : 0, ownerId: 0
    };
}

function toggleEngine(room, engine) {
    engine.active = !engine.active;
    const w = new Writer();
    w.u8(PT.S_ENGINE_STATE);
    w.u32(engine.engineId); w.u8(engine.active ? 1 : 0);
    broadcast(room, w.build());
}

// ═══ Propeller helpers ═══
function createPropellerData(room, position, isDefault = false) {
    return {
        propellerId: room.nextPropId++, position,
        rotation: { x: 0, y: 0, z: 0 },
        isDefault: isDefault ? 1 : 0, ownerId: 0
    };
}

function createRoom() {
    const id = 'room_' + (nextRoomIdx++);
    const world = new RAPIER.World({ x: 0, y: -30, z: 0 });
    const room = {
        id, name: `TuCoria #${nextRoomIdx - 1}`,
        clients: new Map(), blocks: new Map(), rigidBodies: new Map(),
        pistons: new Map(), levers: new Map(), seats: new Map(),
        engines: new Map(), props: new Map(),
        nextPlayerId: 1, nextBlockId: 1, nextPistonId: 1, nextLeverId: 1,
        nextSeatId: 1, nextEngineId: 1, nextPropId: 1,
        maxPlayers: MAX_PLAYERS_PER_ROOM, createdAt: Date.now(),
        world, lastPhysicsSync: 0, lastPistonSync: 0, lastStepTime: Date.now(),
        physicsActive: true
    };
    rooms.set(id, room);
    
    // Пытаемся загрузить сохраненный мир из файла, либо создаем стартовый
    if (!loadRoomStateFromFile(room)) {
        createDefaultScene(room);
    }
    
    log.info(`Created room ${id}`);
    return room;
}

function findAvailableRoom() {
    for (const room of rooms.values()) if (room.clients.size < room.maxPlayers) return room;
    return createRoom();
}

function createRigidBodyForBlock(room, block) {
    if (!room.world) return null;
    let bodyDesc = block.anchored
        ? RAPIER.RigidBodyDesc.fixed()
        : RAPIER.RigidBodyDesc.dynamic().setLinearDamping(0.5).setAngularDamping(0.5).setCanSleep(true);
    bodyDesc.setTranslation(block.position.x, block.position.y, block.position.z);
    bodyDesc.setRotation({ x: block.rotation.x, y: block.rotation.y, z: block.rotation.z, w: block.rotation.w });
    const body = room.world.createRigidBody(bodyDesc);
    const hx = Math.max(block.size.x*0.5,0.05), hy = Math.max(block.size.y*0.5,0.05), hz = Math.max(block.size.z*0.5,0.05);
    let cd;
    switch (block.shape) {
        case 0: cd = RAPIER.ColliderDesc.cuboid(hx,hy,hz); break;
        case 1: cd = RAPIER.ColliderDesc.ball(Math.max(hx,hy,hz)); break;
        case 2: case 4: cd = RAPIER.ColliderDesc.cylinder(hy, Math.max(hx,hz)); break;
        default: cd = RAPIER.ColliderDesc.cuboid(hx,hy,hz);
    }
    cd.setRestitution(0.3).setFriction(0.7);
    if (block.canCollide === 0) cd.setSensor(true);
    room.world.createCollider(cd, body);
    return body;
}

function removeRigidBody(room, blockId) {
    const body = room.rigidBodies.get(blockId);
    if (body) { try { room.world.removeRigidBody(body); } catch(e){} room.rigidBodies.delete(blockId); }
}

function createDefaultScene(room) {
    const bp = {
        blockId: room.nextBlockId++, shape: 0,
        position: {x:0,y:-0.5,z:0}, rotation: {w:1,x:0,y:0,z:0},
        size: {x:100,y:1,z:100}, color: {x:40/255,y:90/255,z:40/255},
        anchored:1, canCollide:1, roughness:0.7, metallic:0, transparency:0,
        castShadow:1, materialName:"Grass", name:"Baseplate", ownerId:0
    };
    room.blocks.set(bp.blockId, bp);
    room.rigidBodies.set(bp.blockId, createRigidBodyForBlock(room, bp));

    const dpList = [ {x:3,y:0,z:5}, {x:-3,y:0,z:5} ];
    const pids = [];
    for (const pos of dpList) {
        const p = createPistonData(room, pos, true);
        room.pistons.set(p.pistonId, p);
        createPistonBodies(room, p);
        pids.push(p.pistonId);
    }

    const lever = createLeverData(room, {x:0, y:0.5, z:5}, true);
    lever.linkedPistons = pids;
    room.levers.set(lever.leverId, lever);
}

function isValidVec3(v) { return v && typeof v.x==='number' && typeof v.y==='number' && typeof v.z==='number' && isFinite(v.x) && isFinite(v.y) && isFinite(v.z); }
function isValidQuat(q) { return q && typeof q.w==='number' && typeof q.x==='number' && typeof q.y==='number' && typeof q.z==='number' && isFinite(q.w) && isFinite(q.x) && isFinite(q.y) && isFinite(q.z); }
function clamp(v,mn,mx) { return Math.max(mn,Math.min(mx,v)); }
function validateBlock(b) {
    if (!isValidVec3(b.position)||!isValidQuat(b.rotation)||!isValidVec3(b.size)||!isValidVec3(b.color)) return false;
    if (Math.abs(b.position.x)>5000||Math.abs(b.position.y)>5000||Math.abs(b.position.z)>5000) return false;
    b.size.x=clamp(b.size.x,0.1,200); b.size.y=clamp(b.size.y,0.1,200); b.size.z=clamp(b.size.z,0.1,200);
    b.color.x=clamp(b.color.x,0,1); b.color.y=clamp(b.color.y,0,1); b.color.z=clamp(b.color.z,0,1);
    b.roughness=clamp(b.roughness,0,1); b.metallic=clamp(b.metallic,0,1); b.transparency=clamp(b.transparency,0,1);
    b.shape=clamp(b.shape,0,4); b.anchored=b.anchored?1:0; b.canCollide=b.canCollide?1:0; b.castShadow=b.castShadow?1:0;
    if (typeof b.name!=='string') b.name='Part'; if (b.name.length>64) b.name=b.name.substring(0,64);
    if (typeof b.materialName!=='string') b.materialName=''; if (b.materialName.length>32) b.materialName=b.materialName.substring(0,32);
    return true;
}

function physicsStep() {
    const now = Date.now();
    for (const room of rooms.values()) {
        if (!room.world||!room.physicsActive||room.clients.size===0) continue;
        const dt = Math.min((now-room.lastStepTime)/1000.0, 0.1);
        room.lastStepTime = now;
        for (const p of room.pistons.values()) updatePistonHead(room, p, dt);
        try { room.world.timestep=PHYSICS_STEP; room.world.step(); } catch(e) { log.error(`Physics step error in ${room.id}:`,e.message); continue; }
        if (now-room.lastPhysicsSync>=NET_SYNC_MS) { room.lastPhysicsSync=now; try{syncPhysicsToClients(room);}catch(e){} }
        if (now-room.lastPistonSync>=PISTON_SYNC_MS) { room.lastPistonSync=now; try{syncPistonsToClients(room);}catch(e){} }
    }
}

function syncPhysicsToClients(room) {
    const updates=[], toDelete=[];
    for (const [blockId, body] of room.rigidBodies) {
        const block=room.blocks.get(blockId);
        if (!block||block.anchored) continue;
        const p=body.translation();
        if (p.y<-100) { toDelete.push(blockId); continue; }
        if (body.isSleeping()) continue;
        const r=body.rotation();
        block.position={x:p.x,y:p.y,z:p.z}; block.rotation={w:r.w,x:r.x,y:r.y,z:r.z};
        updates.push({blockId, position:block.position, rotation:block.rotation});
    }
    for (const bid of toDelete) {
        removeRigidBody(room,bid); room.blocks.delete(bid);
        const w=new Writer(); w.u8(PT.S_BLOCK_DELETE); w.u32(bid); broadcast(room,w.build());
    }
    if (updates.length===0) return;
    const w=new Writer(); w.u8(PT.S_PHYSICS_STATE); w.u32(updates.length);
    for (const u of updates) { w.u32(u.blockId); w.vec3(u.position); w.quat(u.rotation); }
    broadcast(room,w.build());
}

function syncPistonsToClients(room) {
    const updates=[];
    for (const p of room.pistons.values()) { if (!p.dirty) continue; p.dirty=false; updates.push(p); }
    if (updates.length===0) return;
    const w=new Writer(); w.u8(PT.S_PISTON_STATE); w.u32(updates.length);
    for (const p of updates) { w.u32(p.pistonId); w.f32(p.currentOffset); w.u8(p.extended?1:0); }
    broadcast(room,w.build());
}

setInterval(physicsStep, 1000/30);

// Автосохранение всей карты раз в 30 секунд
setInterval(() => {
    for (const room of rooms.values()) {
        saveRoomStateToFile(room);
    }
}, AUTO_SAVE_MS);

app.get('/', (req,res) => { res.setHeader('Cache-Control','no-cache'); res.send('TuCoria Server v0.8 OK'); });
app.get('/health', (req,res) => res.json({status:'ok',uptime:Math.floor(process.uptime())}));
app.get('/save', (req,res) => {
    let saved = 0;
    for (const room of rooms.values()) {
        if (saveRoomStateToFile(room)) saved++;
    }
    res.json({ok: true, savedRooms: saved});
});
app.get('/load', (req,res) => {
    let loaded = 0;
    for (const room of rooms.values()) {
        if (loadRoomStateFromFile(room)) loaded++;
    }
    res.json({ok: true, loadedRooms: loaded});
});

app.get('/servers', (req,res) => {
    const list=Array.from(rooms.values()).map(r=>({
        id:r.id,name:r.name,players:r.clients.size,maxPlayers:r.maxPlayers,
        blocks:r.blocks.size,pistons:r.pistons.size,levers:r.levers.size,
        seats:r.seats.size,engines:r.engines.size,props:r.props.size,
        uptime:Math.floor((Date.now()-r.createdAt)/1000)
    }));
    res.json({servers:list,count:list.length});
});

app.get('/status', (req,res) => {
    const mem=process.memoryUsage();
    let tb=0,tbd=0,tc=0,tp=0,tl=0,ts=0,te=0,tpr=0;
    for (const r of rooms.values()) {
        tb+=r.blocks.size; tbd+=r.rigidBodies.size; tc+=r.clients.size;
        tp+=r.pistons.size; tl+=r.levers.size; ts+=r.seats.size;
        te+=r.engines.size; tpr+=r.props.size;
    }
    res.json({version:'0.8',uptime:Math.floor(process.uptime()),
        memoryMB:Math.round(mem.rss/1024/1024),heapMB:Math.round(mem.heapUsed/1024/1024),
        rooms:rooms.size,totalBlocks:tb,totalBodies:tbd,totalClients:tc,
        totalPistons:tp,totalLevers:tl,totalSeats:ts,totalEngines:te,totalProps:tpr,
        bots:bots.size});
});

app.post('/crash', (req,res) => { res.json({ok:true}); setTimeout(()=>process.exit(1),500); });
app.post('/kickall', (req,res) => {
    let count=0;
    for (const [,b] of bots) clearInterval(b.interval); bots.clear();
    for (const room of rooms.values()) { for (const [ws] of room.clients) { if (!ws.isBot&&ws.readyState===WebSocket.OPEN) { try{ws.close();count++;}catch(e){} } } room.clients.clear(); }
    res.json({ok:true,disconnected:count});
});

const server = http.createServer(app);
const wss = new WebSocket.Server({server,path:'/ws',perMessageDeflate:false,maxPayload:512*1024,clientTracking:true});

const PT = {
    S_WELCOME:1, S_PLAYER_JOIN:2, S_PLAYER_LEAVE:3, S_PLAYER_STATE:4, S_CHAT:5,
    S_PING:6, S_PONG:7, S_PLAYER_HEALTH:8, S_PLAYER_DEATH:9, S_PLAYER_RESPAWN:10, S_PLAYER_TOOL:11,
    S_BLOCK_SPAWN:20, S_BLOCK_UPDATE:21, S_BLOCK_DELETE:22, S_BLOCK_LIST:23, S_PHYSICS_STATE:24,
    S_PISTON_LIST:30, S_PISTON_SPAWN:31, S_PISTON_UPDATE:32, S_PISTON_DELETE:33, S_PISTON_STATE:34,
    S_LEVER_LIST:40, S_LEVER_SPAWN:41, S_LEVER_DELETE:42, S_LEVER_STATE:43,
    S_SEAT_LIST:50, S_SEAT_SPAWN:51, S_SEAT_DELETE:52, S_SEAT_STATE:53,
    S_ENGINE_LIST:60, S_ENGINE_SPAWN:61, S_ENGINE_DELETE:62, S_ENGINE_STATE:63,
    S_PROP_LIST:70, S_PROP_SPAWN:71, S_PROP_DELETE:72, S_PROP_STATE:73,
    C_HELLO:100, C_PLAYER_STATE:101, C_CHAT:102, C_PING:103, C_PONG:104,
    C_PLAYER_HEALTH:105, C_PLAYER_DEATH:106, C_REQUEST_RESPAWN:107, C_PLAYER_TOOL:108,
    C_BLOCK_SPAWN:120, C_BLOCK_UPDATE:121, C_BLOCK_DELETE:122,
    C_PISTON_SPAWN:130, C_PISTON_DELETE:131, C_PISTON_TOGGLE:132, C_PISTON_UPDATE:133,
    C_LEVER_SPAWN:140, C_LEVER_DELETE:141, C_LEVER_TOGGLE:142, C_LEVER_LINK:143, C_LEVER_UNLINK:144, C_LEVER_UPDATE:145,
    C_SEAT_SPAWN:150, C_SEAT_DELETE:151, C_SEAT_SIT:152, C_SEAT_STAND:153, C_DRIVER_INPUT:154, C_SEAT_UPDATE:155,
    C_ENGINE_SPAWN:160, C_ENGINE_DELETE:161, C_ENGINE_TOGGLE:162, C_ENGINE_LINK:163, C_ENGINE_UNLINK:164,
    C_PROP_SPAWN:170, C_PROP_DELETE:171
};

class Reader {
    constructor(buf){this.buf=buf;this.pos=0;}
    u8(){const v=this.buf.readUInt8(this.pos);this.pos+=1;return v;}
    u16(){const v=this.buf.readUInt16LE(this.pos);this.pos+=2;return v;}
    u32(){const v=this.buf.readUInt32LE(this.pos);this.pos+=4;return v;}
    f32(){const v=this.buf.readFloatLE(this.pos);this.pos+=4;return v;}
    vec3(){return{x:this.f32(),y:this.f32(),z:this.f32()};}
    quat(){return{w:this.f32(),x:this.f32(),y:this.f32(),z:this.f32()};}
    str(){const len=this.u16();if(len===0)return'';const s=this.buf.slice(this.pos,this.pos+len).toString('utf8');this.pos+=len;return s;}
    readBlock(){return{blockId:this.u32(),shape:this.u8(),position:this.vec3(),rotation:this.quat(),size:this.vec3(),color:this.vec3(),anchored:this.u8(),canCollide:this.u8(),roughness:this.f32(),metallic:this.f32(),transparency:this.f32(),castShadow:this.u8(),materialName:this.str(),name:this.str(),ownerId:this.u32()};}
}

class Writer {
    constructor(){this.chunks=[];}
    u8(v){const b=Buffer.alloc(1);b.writeUInt8(v,0);this.chunks.push(b);}
    u16(v){const b=Buffer.alloc(2);b.writeUInt16LE(v,0);this.chunks.push(b);}
    u32(v){const b=Buffer.alloc(4);b.writeUInt32LE(v,0);this.chunks.push(b);}
    f32(v){const b=Buffer.alloc(4);b.writeFloatLE(v,0);this.chunks.push(b);}
    vec3(v){this.f32(v.x);this.f32(v.y);this.f32(v.z);}
    quat(v){this.f32(v.w);this.f32(v.x);this.f32(v.y);this.f32(v.z);}
    str(s){const buf=Buffer.from(s||'','utf8');this.u16(buf.length);if(buf.length>0)this.chunks.push(buf);}
    writeBlock(b){this.u32(b.blockId);this.u8(b.shape);this.vec3(b.position);this.quat(b.rotation);this.vec3(b.size);this.vec3(b.color);this.u8(b.anchored);this.u8(b.canCollide);this.f32(b.roughness);this.f32(b.metallic);this.f32(b.transparency);this.u8(b.castShadow);this.str(b.materialName);this.str(b.name);this.u32(b.ownerId);}
    writePiston(p){this.u32(p.pistonId);this.vec3(p.position);this.vec3(p.rotation);this.f32(p.extendDistance);this.f32(p.extendSpeed);this.f32(p.scale);this.vec3(p.color);this.f32(p.currentOffset);this.u8(p.extended?1:0);this.u8(p.isDefault);this.u32(p.ownerId);}
    writeLever(l){this.u32(l.leverId);this.vec3(l.position);this.vec3(l.rotation);this.f32(l.scale);this.u8(l.active?1:0);this.u32(l.linkedPistons.length);for(const pid of l.linkedPistons)this.u32(pid);this.u8(l.isDefault);this.u32(l.ownerId);}
    writeSeat(s){this.u32(s.seatId);this.vec3(s.position);this.vec3(s.rotation);this.u8(s.isDriver);this.u32(s.occupantId);this.u8(s.isDefault);this.u32(s.ownerId);}
    writeEngine(e){this.u32(e.engineId);this.vec3(e.position);this.vec3(e.rotation);this.u8(e.active?1:0);this.u32(e.linkedPropellers.length);for(const pid of e.linkedPropellers)this.u32(pid);this.u8(e.isDefault);this.u32(e.ownerId);}
    writeProp(p){this.u32(p.propellerId);this.vec3(p.position);this.vec3(p.rotation);this.u8(p.isDefault);this.u32(p.ownerId);}
    build(){return Buffer.concat(this.chunks);}
}

function send(ws,buf){if(ws.isBot)return;if(ws.readyState!==WebSocket.OPEN)return;try{ws.send(buf);}catch(e){}}
function broadcast(room,buf,exclude=null){for(const[ws]of room.clients){if(ws===exclude)continue;send(ws,buf);}}

let nextBotUserId=1000000;
const bots=new Map();
function spawnBot(name='Bot'){
    const room=findAvailableRoom();const playerId=room.nextPlayerId++;const userId=nextBotUserId++;const botId='bot_'+userId;
    const info={playerId,name,userId,isBot:true,health:PLAYER_MAX_HEALTH,isDead:false,holdingTool:false,rateLimits:null};
    const fakeWs={readyState:1,send:()=>{},isBot:true,botId};
    room.clients.set(fakeWs,info);
    const jw=new Writer();jw.u8(PT.S_PLAYER_JOIN);jw.u32(playerId);jw.str(name);broadcast(room,jw.build());
    const pos={x:(Math.random()-0.5)*20,y:5,z:(Math.random()-0.5)*20};const yaw=Math.random()*360;
    const interval=setInterval(()=>{if(!rooms.has(room.id)){clearInterval(interval);return;}const w=new Writer();w.u8(PT.S_PLAYER_STATE);w.u32(playerId);w.vec3(pos);w.f32(yaw);w.u8(0);w.u8(0);broadcast(room,w.build());},2000);
    bots.set(botId,{room,playerId,name,fakeWs,interval});return{botId,playerId,name,roomId:room.id};
}
function removeBot(botId){const bot=bots.get(botId);if(!bot)return false;clearInterval(bot.interval);bot.room.clients.delete(bot.fakeWs);const w=new Writer();w.u8(PT.S_PLAYER_LEAVE);w.u32(bot.playerId);broadcast(bot.room,w.build());bots.delete(botId);return true;}
app.post('/bots/add',(req,res)=>{const name=(req.body&&req.body.name)||'Bot'+Math.floor(Math.random()*1000);res.json({ok:true,bot:spawnBot(name)});});
app.get('/bots',(req,res)=>{const list=Array.from(bots.entries()).map(([id,b])=>({botId:id,name:b.name,playerId:b.playerId,roomId:b.room.id}));res.json({bots:list,count:list.length});});
app.delete('/bots/:id',(req,res)=>res.json({ok:removeBot(req.params.id)}));
app.delete('/bots',(req,res)=>{let count=0;for(const id of Array.from(bots.keys()))if(removeBot(id))count++;res.json({ok:true,removed:count});});

function createRateLimits(){return{msgCount:0,msgResetAt:Date.now()+1000,blockSpawnCount:0,blockSpawnResetAt:Date.now()+1000,chatCount:0,chatResetAt:Date.now()+10000};}
function checkRate(rl,type){const now=Date.now();if(type==='msg'){if(now>rl.msgResetAt){rl.msgCount=0;rl.msgResetAt=now+1000;}rl.msgCount++;return rl.msgCount<=MAX_MSGS_PER_SEC;}if(type==='block'){if(now>rl.blockSpawnResetAt){rl.blockSpawnCount=0;rl.blockSpawnResetAt=now+1000;}rl.blockSpawnCount++;return rl.blockSpawnCount<=MAX_BLOCK_SPAWNS_SEC;}if(type==='chat'){if(now>rl.chatResetAt){rl.chatCount=0;rl.chatResetAt=now+10000;}rl.chatCount++;return rl.chatCount<=MAX_CHAT_PER_10_SEC;}return true;}
function broadcastPlayerHealth(room,info){const w=new Writer();w.u8(PT.S_PLAYER_HEALTH);w.u32(info.playerId);w.f32(info.health);broadcast(room,w.build());}
function broadcastPlayerDeath(room,info){const w=new Writer();w.u8(PT.S_PLAYER_DEATH);w.u32(info.playerId);broadcast(room,w.build());}
function broadcastPlayerRespawn(room,info){const w=new Writer();w.u8(PT.S_PLAYER_RESPAWN);w.u32(info.playerId);w.f32(info.health);broadcast(room,w.build());}

wss.on('connection',(ws,req)=>{
    const realIP=req.headers['cf-connecting-ip']||req.headers['x-forwarded-for']||req.socket.remoteAddress;
    ws.isAlive=true;ws.room=null;ws.info=null;ws.lastMessageTime=Date.now();ws.realIP=realIP;ws.rateLimits=createRateLimits();
    ws.on('pong',()=>{ws.isAlive=true;});
    ws.on('message',(data)=>{
        ws.lastMessageTime=Date.now();
        if(!checkRate(ws.rateLimits,'msg'))return;
        try{
            const r=new Reader(data);const type=r.u8();

            if(type===PT.C_HELLO){
                const name=r.str();let userId=0;try{userId=r.u32();}catch(e){}
                if(userId===0||!name||name.length>32){ws.close();return;}
                let dup=false;for(const rm of rooms.values()){for(const[,i]of rm.clients){if(i.userId===userId&&!i.isBot){dup=true;break;}}if(dup)break;}
                if(dup){const w=new Writer();w.u8(PT.S_CHAT);w.u32(0);w.str("System");w.str("You are already connected from another session");send(ws,w.build());setTimeout(()=>{try{ws.close();}catch(e){}},500);return;}
                const room=findAvailableRoom();const playerId=room.nextPlayerId++;
                const info={playerId,name,userId,health:PLAYER_MAX_HEALTH,isDead:false,holdingTool:false,lastPosition:{x:0,y:5,z:0},joinedAt:Date.now()};
                room.clients.set(ws,info);ws.room=room;ws.info=info;

                const w=new Writer();w.u8(PT.S_WELCOME);w.u32(playerId);
                const others=Array.from(room.clients.entries()).filter(([wsx])=>wsx!==ws).map(([,i])=>i);
                w.u32(others.length);for(const o of others){w.u32(o.playerId);w.str(o.name);}
                send(ws,w.build());

                const bw=new Writer();bw.u8(PT.S_BLOCK_LIST);bw.u32(room.blocks.size);for(const b of room.blocks.values())bw.writeBlock(b);send(ws,bw.build());
                const pw2=new Writer();pw2.u8(PT.S_PISTON_LIST);pw2.u32(room.pistons.size);for(const p of room.pistons.values())pw2.writePiston(p);send(ws,pw2.build());
                const lw=new Writer();lw.u8(PT.S_LEVER_LIST);lw.u32(room.levers.size);for(const l of room.levers.values())lw.writeLever(l);send(ws,lw.build());
                const sw=new Writer();sw.u8(PT.S_SEAT_LIST);sw.u32(room.seats.size);for(const s of room.seats.values())sw.writeSeat(s);send(ws,sw.build());
                const ew=new Writer();ew.u8(PT.S_ENGINE_LIST);ew.u32(room.engines.size);for(const e of room.engines.values())ew.writeEngine(e);send(ws,ew.build());
                const prw=new Writer();prw.u8(PT.S_PROP_LIST);prw.u32(room.props.size);for(const p of room.props.values())prw.writeProp(p);send(ws,prw.build());

                for(const o of others){const hw=new Writer();hw.u8(PT.S_PLAYER_HEALTH);hw.u32(o.playerId);hw.f32(o.health);send(ws,hw.build());}
                for(const o of others){if(o.holdingTool){const tw=new Writer();tw.u8(PT.S_PLAYER_TOOL);tw.u32(o.playerId);tw.u8(1);send(ws,tw.build());}}

                const jw=new Writer();jw.u8(PT.S_PLAYER_JOIN);jw.u32(playerId);jw.str(name);broadcast(room,jw.build(),ws);
                log.info(`Player joined: ${name} (id=${playerId}, room=${room.id})`);
                return;
            }

            const room=ws.room,info=ws.info;if(!room||!info)return;

            if(type===PT.C_PLAYER_STATE){const pos=r.vec3();const yaw=r.f32();const anim=r.u8();const crouch=r.u8();if(!isValidVec3(pos)||!isFinite(yaw))return;if(Math.abs(pos.x)>5000||Math.abs(pos.y)>5000||Math.abs(pos.z)>5000)return;info.lastPosition=pos;const w=new Writer();w.u8(PT.S_PLAYER_STATE);w.u32(info.playerId);w.vec3(pos);w.f32(yaw);w.u8(anim);w.u8(crouch);broadcast(room,w.build(),ws);return;}
            if(type===PT.C_CHAT){if(!checkRate(ws.rateLimits,'chat')){const w=new Writer();w.u8(PT.S_CHAT);w.u32(0);w.str("System");w.str("Slow down!");send(ws,w.build());return;}let text=r.str();if(!text)return;if(text.length>200)text=text.substring(0,200);const w=new Writer();w.u8(PT.S_CHAT);w.u32(info.playerId);w.str(info.name);w.str(text);broadcast(room,w.build());return;}
            if(type===PT.C_PING){const seq=r.u32();const w=new Writer();w.u8(PT.S_PONG);w.u32(seq);send(ws,w.build());return;}
            if(type===PT.C_PLAYER_HEALTH){let hp=r.f32();if(!isFinite(hp))return;hp=clamp(hp,0,PLAYER_MAX_HEALTH);if(info.isDead)return;info.health=hp;broadcastPlayerHealth(room,info);return;}
            if(type===PT.C_PLAYER_DEATH){if(info.isDead)return;info.isDead=true;info.health=0;releaseSeatByPlayer(room,info.playerId);broadcastPlayerDeath(room,info);setTimeout(()=>{if(!ws.info||!ws.room)return;info.isDead=false;info.health=PLAYER_MAX_HEALTH;broadcastPlayerRespawn(room,info);},RESPAWN_DELAY_MS);return;}
            if(type===PT.C_REQUEST_RESPAWN){if(!info.isDead)return;info.isDead=false;info.health=PLAYER_MAX_HEALTH;broadcastPlayerRespawn(room,info);return;}
            if(type===PT.C_PLAYER_TOOL){const holding=r.u8()!==0;info.holdingTool=holding;const w=new Writer();w.u8(PT.S_PLAYER_TOOL);w.u32(info.playerId);w.u8(holding?1:0);broadcast(room,w.build(),ws);return;}

            // ═══ BLOCKS ═══
            if(type===PT.C_BLOCK_SPAWN){if(!checkRate(ws.rateLimits,'block'))return;if(room.blocks.size>=MAX_BLOCKS_PER_ROOM)return;const b=r.readBlock();if(!validateBlock(b))return;b.blockId=room.nextBlockId++;b.ownerId=info.playerId;room.blocks.set(b.blockId,b);const body=createRigidBodyForBlock(room,b);if(body){room.rigidBodies.set(b.blockId,body);if(!b.anchored)body.wakeUp();}const w=new Writer();w.u8(PT.S_BLOCK_SPAWN);w.writeBlock(b);broadcast(room,w.build(),ws);send(ws,w.build());return;}
            if(type===PT.C_BLOCK_UPDATE){const b=r.readBlock();if(!validateBlock(b))return;if(!room.blocks.has(b.blockId))return;const old=room.blocks.get(b.blockId);room.blocks.set(b.blockId,b);const nr=old.shape!==b.shape||old.anchored!==b.anchored||old.canCollide!==b.canCollide||Math.abs(old.size.x-b.size.x)>0.01||Math.abs(old.size.y-b.size.y)>0.01||Math.abs(old.size.z-b.size.z)>0.01;if(nr){removeRigidBody(room,b.blockId);const body=createRigidBodyForBlock(room,b);if(body){room.rigidBodies.set(b.blockId,body);if(!b.anchored)body.wakeUp();}}else{const body=room.rigidBodies.get(b.blockId);if(body){body.setTranslation(b.position,true);body.setRotation({x:b.rotation.x,y:b.rotation.y,z:b.rotation.z,w:b.rotation.w},true);body.setLinvel({x:0,y:0,z:0},true);body.setAngvel({x:0,y:0,z:0},true);body.wakeUp();}}const w=new Writer();w.u8(PT.S_BLOCK_UPDATE);w.writeBlock(b);broadcast(room,w.build(),ws);return;}
            if(type===PT.C_BLOCK_DELETE){const blockId=r.u32();if(!room.blocks.has(blockId))return;room.blocks.delete(blockId);removeRigidBody(room,blockId);const w=new Writer();w.u8(PT.S_BLOCK_DELETE);w.u32(blockId);broadcast(room,w.build());return;}

            // ═══ PISTONS ═══
            if(type===PT.C_PISTON_SPAWN){if(room.pistons.size>=MAX_PISTONS_PER_ROOM)return;const pos=r.vec3();if(!isValidVec3(pos))return;const p=createPistonData(room,pos,false);p.ownerId=info.playerId;room.pistons.set(p.pistonId,p);createPistonBodies(room,p);const w=new Writer();w.u8(PT.S_PISTON_SPAWN);w.writePiston(p);broadcast(room,w.build());return;}
            if(type===PT.C_PISTON_DELETE){const pid=r.u32();const p=room.pistons.get(pid);if(!p||p.isDefault)return;removePistonBodies(room,p);room.pistons.delete(pid);const w=new Writer();w.u8(PT.S_PISTON_DELETE);w.u32(pid);broadcast(room,w.build());return;}
            if(type===PT.C_PISTON_TOGGLE){const pid=r.u32();const p=room.pistons.get(pid);if(!p)return;p.extended=!p.extended;p.dirty=true;const w=new Writer();w.u8(PT.S_PISTON_STATE);w.u32(1);w.u32(p.pistonId);w.f32(p.currentOffset);w.u8(p.extended?1:0);broadcast(room,w.build());return;}
            if(type===PT.C_PISTON_UPDATE){const pid=r.u32();const pos=r.vec3();const rot=r.vec3();const p=room.pistons.get(pid);if(!p||!isValidVec3(pos))return;p.position=pos;if(rot)p.rotation=rot;removePistonBodies(room,p);createPistonBodies(room,p);const w=new Writer();w.u8(PT.S_PISTON_SPAWN);w.writePiston(p);broadcast(room,w.build(),ws);return;}

            // ═══ LEVERS ═══
            if(type===PT.C_LEVER_TOGGLE){const lid=r.u32();const l=room.levers.get(lid);if(!l)return;toggleLever(room,l);return;}
            if(type===PT.C_LEVER_SPAWN){if(room.levers.size>=MAX_LEVERS_PER_ROOM)return;const pos=r.vec3();if(!isValidVec3(pos))return;const lever=createLeverData(room,pos,false);lever.ownerId=info.playerId;room.levers.set(lever.leverId,lever);const w=new Writer();w.u8(PT.S_LEVER_SPAWN);w.writeLever(lever);broadcast(room,w.build());return;}
            if(type===PT.C_LEVER_DELETE){const lid=r.u32();const l=room.levers.get(lid);if(!l||l.isDefault)return;room.levers.delete(lid);const w=new Writer();w.u8(PT.S_LEVER_DELETE);w.u32(lid);broadcast(room,w.build());return;}
            if(type===PT.C_LEVER_LINK){const lid=r.u32();const pid=r.u32();const l=room.levers.get(lid);const p=room.pistons.get(pid);if(!l||!p)return;if(!l.linkedPistons.includes(pid))l.linkedPistons.push(pid);const w=new Writer();w.u8(PT.S_LEVER_SPAWN);w.writeLever(l);broadcast(room,w.build());return;}
            if(type===PT.C_LEVER_UNLINK){const lid=r.u32();const pid=r.u32();const l=room.levers.get(lid);if(!l)return;l.linkedPistons=l.linkedPistons.filter(id=>id!==pid);const w=new Writer();w.u8(PT.S_LEVER_SPAWN);w.writeLever(l);broadcast(room,w.build());return;}
            if(type===PT.C_LEVER_UPDATE){const lid=r.u32();const pos=r.vec3();const rot=r.vec3();const l=room.levers.get(lid);if(!l||!isValidVec3(pos))return;l.position=pos;if(rot)l.rotation=rot;const w=new Writer();w.u8(PT.S_LEVER_SPAWN);w.writeLever(l);broadcast(room,w.build(),ws);return;}

            // ═══ SEATS ═══
            if(type===PT.C_SEAT_SPAWN){
                if(room.seats.size>=MAX_SEATS_PER_ROOM)return;
                const pos=r.vec3();const isDriver=r.u8();if(!isValidVec3(pos))return;
                const seat=createSeatData(room,pos,isDriver,false);seat.ownerId=info.playerId;
                room.seats.set(seat.seatId,seat);
                const w=new Writer();w.u8(PT.S_SEAT_SPAWN);w.writeSeat(seat);broadcast(room,w.build());
                return;
            }
            if(type===PT.C_SEAT_DELETE){
                const sid=r.u32();const seat=room.seats.get(sid);if(!seat||seat.isDefault)return;
                if(seat.occupantId!==0){const ws2=new Writer();ws2.u8(PT.S_SEAT_STATE);ws2.u32(seat.seatId);ws2.u32(0);broadcast(room,ws2.build());}
                room.seats.delete(sid);
                const w=new Writer();w.u8(PT.S_SEAT_DELETE);w.u32(sid);broadcast(room,w.build());
                return;
            }
            if(type===PT.C_SEAT_SIT){
                const sid=r.u32();const seat=room.seats.get(sid);if(!seat||seat.occupantId!==0)return;
                releaseSeatByPlayer(room,info.playerId);
                seat.occupantId=info.playerId;
                const w=new Writer();w.u8(PT.S_SEAT_STATE);w.u32(seat.seatId);w.u32(info.playerId);broadcast(room,w.build());
                return;
            }
            if(type===PT.C_SEAT_STAND){
                const sid=r.u32();const seat=room.seats.get(sid);if(!seat||seat.occupantId!==info.playerId)return;
                seat.occupantId=0;seat.throttle=0;seat.steer=0;
                const w=new Writer();w.u8(PT.S_SEAT_STATE);w.u32(seat.seatId);w.u32(0);broadcast(room,w.build());
                return;
            }
            if(type===PT.C_DRIVER_INPUT){
                const sid=r.u32();const throttle=r.f32();const steer=r.f32();
                const seat=room.seats.get(sid);if(!seat||seat.occupantId!==info.playerId||!seat.isDriver)return;
                seat.throttle=clamp(throttle,-1,1);seat.steer=clamp(steer,-1,1);
                return;
            }
            if(type===PT.C_SEAT_UPDATE){
                const sid=r.u32();const pos=r.vec3();const rot=r.vec3();const seat=room.seats.get(sid);if(!seat||!isValidVec3(pos))return;
                seat.position=pos;if(rot)seat.rotation=rot;
                const w=new Writer();w.u8(PT.S_SEAT_SPAWN);w.writeSeat(seat);broadcast(room,w.build(),ws);
                return;
            }

            // ═══ ENGINE ═══
            if(type===PT.C_ENGINE_SPAWN){
                if(room.engines.size>=MAX_ENGINES_PER_ROOM)return;
                const pos=r.vec3();if(!isValidVec3(pos))return;
                const eng=createEngineData(room,pos,false);eng.ownerId=info.playerId;
                room.engines.set(eng.engineId,eng);
                const w=new Writer();w.u8(PT.S_ENGINE_SPAWN);w.writeEngine(eng);broadcast(room,w.build());
                return;
            }
            if(type===PT.C_ENGINE_DELETE){
                const eid=r.u32();const eng=room.engines.get(eid);if(!eng||eng.isDefault)return;
                room.engines.delete(eid);
                const w=new Writer();w.u8(PT.S_ENGINE_DELETE);w.u32(eid);broadcast(room,w.build());
                return;
            }
            if(type===PT.C_ENGINE_TOGGLE){
                const eid=r.u32();const eng=room.engines.get(eid);if(!eng)return;
                toggleEngine(room,eng);
                return;
            }
            if(type===PT.C_ENGINE_LINK){
                const eid=r.u32();const pid=r.u32();
                const eng=room.engines.get(eid);const prop=room.props.get(pid);
                if(!eng||!prop)return;
                if(!eng.linkedPropellers.includes(pid))eng.linkedPropellers.push(pid);
                const w=new Writer();w.u8(PT.S_ENGINE_SPAWN);w.writeEngine(eng);broadcast(room,w.build());
                return;
            }
            if(type===PT.C_ENGINE_UNLINK){
                const eid=r.u32();const pid=r.u32();
                const eng=room.engines.get(eid);if(!eng)return;
                eng.linkedPropellers=eng.linkedPropellers.filter(id=>id!==pid);
                const w=new Writer();w.u8(PT.S_ENGINE_SPAWN);w.writeEngine(eng);broadcast(room,w.build());
                return;
            }

            // ═══ PROPELLER ═══
            if(type===PT.C_PROP_SPAWN){
                if(room.props.size>=MAX_PROPS_PER_ROOM)return;
                const pos=r.vec3();if(!isValidVec3(pos))return;
                const prop=createPropellerData(room,pos,false);prop.ownerId=info.playerId;
                room.props.set(prop.propellerId,prop);
                const w=new Writer();w.u8(PT.S_PROP_SPAWN);w.writeProp(prop);broadcast(room,w.build());
                return;
            }
            if(type===PT.C_PROP_DELETE){
                const pid=r.u32();const prop=room.props.get(pid);if(!prop||prop.isDefault)return;
                for(const e of room.engines.values()){
                    if(e.linkedPropellers.includes(pid)){
                        e.linkedPropellers=e.linkedPropellers.filter(id=>id!==pid);
                        const ew=new Writer();ew.u8(PT.S_ENGINE_SPAWN);ew.writeEngine(e);broadcast(room,ew.build());
                    }
                }
                room.props.delete(pid);
                const w=new Writer();w.u8(PT.S_PROP_DELETE);w.u32(pid);broadcast(room,w.build());
                return;
            }

        }catch(e){log.error('WS msg error:',e.message);}
    });

    ws.on('close',()=>{
        const room=ws.room,info=ws.info;ws.room=null;ws.info=null;
        if(!room||!info)return;
        releaseSeatByPlayer(room,info.playerId);
        room.clients.delete(ws);
        const w=new Writer();w.u8(PT.S_PLAYER_LEAVE);w.u32(info.playerId);broadcast(room,w.build());
        log.info(`Player left: ${info.name} (id=${info.playerId})`);
        
        let rc=0;for(const[wsx]of room.clients)if(!wsx.isBot)rc++;
        if(rc===0&&rooms.size>1){
            saveRoomStateToFile(room); // Сохраняем карту перед закрытием комнаты
            try{for(const body of room.rigidBodies.values()){try{room.world.removeRigidBody(body);}catch(e){}}for(const p of room.pistons.values())removePistonBodies(room,p);room.rigidBodies.clear();room.pistons.clear();room.levers.clear();room.seats.clear();room.engines.clear();room.props.clear();if(room.world){room.world.free();room.world=null;}}catch(e){log.error('Cleanup:',e.message);}
            for(const[id,b]of Array.from(bots.entries()))if(b.room===room)removeBot(id);
            rooms.delete(room.id);log.info(`Removed empty room ${room.id}`);
        }
    });
    ws.on('error',()=>{});
});

setInterval(()=>{const now=Date.now();wss.clients.forEach(ws=>{if(ws.lastMessageTime&&now-ws.lastMessageTime>120000){try{ws.terminate();}catch(e){}return;}if(ws.isAlive===false){try{ws.terminate();}catch(e){}return;}ws.isAlive=false;try{ws.ping();}catch(e){}});},15000);

process.on('uncaughtException',(err)=>{
    log.error('FATAL:',err.message);
    log.error(err.stack);
});
process.on('unhandledRejection',(reason)=>log.error('FATAL Rejection:',reason));

const gracefulShutdown = () => {
    log.info('Shutting down server... Saving all worlds.');
    for (const room of rooms.values()) {
        saveRoomStateToFile(room);
    }
    wss.clients.forEach(ws=>{try{ws.close();}catch(e){}});
    server.close(()=>process.exit(0));
    setTimeout(()=>process.exit(1),5000);
};

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

(async()=>{
    try{
        await RAPIER.init();
        server.listen(PORT,()=>log.info(`TuCoria Server v0.8 on port ${PORT}`));
    }catch(e){
        log.error('Startup failed:',e);
        process.exit(1);
    }
})();
