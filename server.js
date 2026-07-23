const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

const servers = new Map();

function genId() {
    return Math.random().toString(36).substring(2, 15) +
           Math.random().toString(36).substring(2, 15);
}

setInterval(() => {
    const now = Date.now();
    for (const [id, srv] of servers) {
        if (now - srv.lastHeartbeat > 60000) {
            servers.delete(id);
        }
    }
}, 15000);

app.post('/servers', (req, res) => {
    const { name, port, maxPlayers } = req.body;
    if (!name || !port) return res.status(400).json({ error: 'name and port required' });

    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() ||
               req.socket.remoteAddress?.replace(/^::ffff:/, '') ||
               '127.0.0.1';

    const id = genId();
    const srv = {
        id,
        name: String(name).substring(0, 32),
        ip,
        port: parseInt(port),
        players: 1,
        maxPlayers: parseInt(maxPlayers) || 16,
        lastHeartbeat: Date.now(),
        createdAt: Date.now()
    };

    servers.set(id, srv);
    res.json({ serverId: id, server: srv });
});

app.post('/heartbeat', (req, res) => {
    const { serverId, players } = req.body;
    if (!serverId || !servers.has(serverId)) {
        return res.status(404).json({ error: 'server not found' });
    }
    const srv = servers.get(serverId);
    srv.lastHeartbeat = Date.now();
    if (typeof players === 'number') srv.players = players;
    res.json({ ok: true });
});

app.delete('/servers/:id', (req, res) => {
    servers.delete(req.params.id);
    res.json({ ok: true });
});

app.get('/servers', (req, res) => {
    const list = Array.from(servers.values()).map(s => ({
        id: s.id,
        name: s.name,
        ip: s.ip,
        port: s.port,
        players: s.players,
        maxPlayers: s.maxPlayers,
        uptime: Math.floor((Date.now() - s.createdAt) / 1000)
    }));
    res.json({ servers: list, count: list.length });
});

app.get('/', (req, res) => {
    res.send('TuCoria Server');
});

app.listen(PORT, () => {
    console.log(`[LOBBY] Listening on port ${PORT}`);
});
