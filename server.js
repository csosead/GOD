// ================================================================
// GOD Tactical Server  —  Express + Socket.io + Multer
// ================================================================
// Usage:
//   node server.js
//
// Environment variables (optional):
//   PORT        — HTTP port (default 3000)
//   GM_PASSWORD — GM admin password (default "godmode")
//
// PM2 deployment:
//   npm install -g pm2
//   pm2 start server.js --name god-tactical
//   pm2 save
//   pm2 startup
// ================================================================

const express   = require('express');
const http      = require('http');
const { Server } = require('socket.io');
const multer    = require('multer');
const path      = require('path');
const fs        = require('fs');
const crypto    = require('crypto');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] }
});

const PORT        = process.env.PORT        || 3000;
const GM_PASSWORD = process.env.GM_PASSWORD || 'godmode';

// ── Uploads folder ────────────────────────────────────────────────
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── Persistent room data ──────────────────────────────────────────
// Stored in rooms_data.json: { [roomId]: { gmPasswordHash, creationDate } }
const ROOMS_DATA_FILE = path.join(__dirname, 'rooms_data.json');
let roomsData = {};
try {
    if (fs.existsSync(ROOMS_DATA_FILE)) {
        roomsData = JSON.parse(fs.readFileSync(ROOMS_DATA_FILE, 'utf8'));
    }
} catch (e) {
    console.warn('Could not parse rooms_data.json — starting fresh:', e.message);
    roomsData = {};
}

function saveRoomsData() {
    fs.writeFileSync(ROOMS_DATA_FILE, JSON.stringify(roomsData, null, 2), 'utf8');
}

function hashPassword(pw) {
    return crypto.createHash('sha256').update(String(pw)).digest('hex');
}

/**
 * Verify GM password for a room.
 * If the room has no persisted data yet, any provided password creates it.
 * Returns true if verified (and creates the room entry as a side-effect if new).
 */
function verifyAndInitRoom(roomId, password) {
    if (!roomId || !password) return false;
    const data = roomsData[roomId];
    if (!data) {
        // First GM to claim this room — store their password
        roomsData[roomId] = {
            gmPasswordHash: hashPassword(password),
            creationDate:   new Date().toISOString()
        };
        saveRoomsData();
        return true;
    }
    return hashPassword(password) === data.gmPasswordHash;
}

// ── Multer storage with room-prefixed filenames ────────────────────
const storage = multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
        const roomId = sanitizeId(req.query.roomId || req.headers['x-gm-room-id'] || 'default');
        const safe = file.originalname
            .replace(/[^a-zA-Z0-9._\- ]/g, '_')
            .replace(/\s+/g, '_');
        const prefixed = `${roomId}___${safe}`;
        const dest = path.join(UPLOADS_DIR, prefixed);
        if (fs.existsSync(dest)) {
            cb(null, `${roomId}___${Date.now()}_${safe}`);
        } else {
            cb(null, prefixed);
        }
    }
});

const upload = multer({
    storage,
    fileFilter: (_req, file, cb) => {
        if (file.originalname.toLowerCase().endsWith('.gridmap')) {
            cb(null, true);
        } else {
            cb(new Error('Only .gridmap files are accepted'));
        }
    },
    limits: { fileSize: 200 * 1024 * 1024 } // 200 MB
});

// ── Helper: sanitize a roomId for use in filenames ─────────────────
function sanitizeId(id) {
    return String(id || 'default').toLowerCase().trim().replace(/[^a-z0-9_\-]/g, '_').slice(0, 64);
}

// ── Room state ────────────────────────────────────────────────────
/**
 * rooms[roomId] = {
 *   activeMap      : { filename, url } | null,
 *   drawings       : Array<DrawingRecord>,
 *   drawingsVisible: boolean,
 *   players        : Map<socketId, { callsign, isGM }>
 * }
 */
const rooms = {};

// Inactivity timers — only clear volatile drawings, never delete persistent data
const INACTIVITY_MS  = 60 * 60 * 1000; // 60 minutes
const roomTimers = {};

function resetInactivityTimer(roomId) {
    if (roomTimers[roomId]) clearTimeout(roomTimers[roomId]);
    roomTimers[roomId] = setTimeout(() => {
        const room = rooms[roomId];
        if (room && room.drawings.length > 0) {
            room.drawings = [];
            io.to(roomId).emit('drawings-cleared');
            console.log(`[inactivity] Cleared drawings for room "${roomId}" after 60 min`);
        }
    }, INACTIVITY_MS);
}

function getRoom(roomId) {
    if (!rooms[roomId]) {
        rooms[roomId] = {
            activeMap:       null,
            drawings:        [],
            drawingsVisible: true,
            focusOwner:      null,
            players:         new Map()
        };
    }
    resetInactivityTimer(roomId);
    return rooms[roomId];
}

function broadcastPlayerList(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    const list = Array.from(room.players.values())
        .filter(p => !p.isGM)
        .map(p => p.callsign);
    const count = io.sockets.adapter.rooms.get(roomId)?.size || 0;
    io.to(roomId).emit('player-list', list);
    io.to(roomId).emit('client-count', count);
}

/** Return the drawings each client should see based on visibility flag */
function visibleDrawings(room, isGM = false) {
    if (isGM || room.drawingsVisible) return room.drawings;
    return [];
}

// ── Middleware ────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── Auth helpers ──────────────────────────────────────────────────

/** Global GM check — used only for the /api/rooms admin endpoint */
function requireGM(req, res, next) {
    const pw = req.headers['x-gm-password'] || req.query.pw;
    if (pw !== GM_PASSWORD) return res.status(401).json({ error: 'Unauthorized — wrong GM password' });
    next();
}

/**
 * Per-room GM check.
 * Resolves roomId from params, body, query, or header.
 * Creates a persistent room entry on first successful auth.
 */
function requireRoomGM(req, res, next) {
    const pw     = req.headers['x-gm-password'] || req.query.pw;
    const roomId = sanitizeId(
        req.params.roomId ||
        (req.body && req.body.roomId) ||
        req.query.roomId ||
        req.headers['x-gm-room-id'] ||
        ''
    );

    if (!pw) return res.status(401).json({ error: 'Unauthorized — no GM password' });

    if (!verifyAndInitRoom(roomId || '_global', pw)) {
        return res.status(401).json({ error: 'Unauthorized — wrong GM password for room' });
    }

    req.gmRoomId = roomId;
    next();
}

// ── REST API ──────────────────────────────────────────────────────

// Upload a new .gridmap file — prefixed with roomId
app.post('/api/upload', requireRoomGM, upload.single('map'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No valid .gridmap file received' });
    res.json({
        filename:     req.file.filename,
        originalName: req.file.originalname,
        url:          `/uploads/${encodeURIComponent(req.file.filename)}`
    });
});

// List .gridmap files for a specific room (prefix-filtered)
app.get('/api/maps', requireRoomGM, (req, res) => {
    const roomId = req.gmRoomId || sanitizeId(req.query.roomId || '');
    const prefix = roomId ? `${roomId}___` : '';
    const files = fs.readdirSync(UPLOADS_DIR)
        .filter(f => f.toLowerCase().endsWith('.gridmap') && (prefix ? f.startsWith(prefix) : true))
        .map(f => ({
            filename: f,
            url:      `/uploads/${encodeURIComponent(f)}`,
            size:     fs.statSync(path.join(UPLOADS_DIR, f)).size
        }));
    res.json(files);
});

// Delete a map file — verifies it belongs to requesting room
app.delete('/api/maps/:filename', requireRoomGM, (req, res) => {
    const filename = path.basename(req.params.filename); // prevent path traversal
    const roomId   = req.gmRoomId;

    // Security: ensure the file belongs to this room
    if (roomId && !filename.startsWith(`${roomId}___`)) {
        return res.status(403).json({ error: 'File does not belong to your room' });
    }

    const filePath = path.join(UPLOADS_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    fs.unlinkSync(filePath);
    res.json({ ok: true });
});

// Get current public room state (players call this on startup)
app.get('/api/room/:roomId', (req, res) => {
    const room = getRoom(req.params.roomId);
    const pw   = req.headers['x-gm-password'] || req.query.pw;
    const gm   = pw && roomsData[req.params.roomId]
        ? hashPassword(pw) === roomsData[req.params.roomId].gmPasswordHash
        : false;
    res.json({
        activeMap:       room.activeMap,
        drawingsVisible: room.drawingsVisible,
        drawings:        visibleDrawings(room, gm),
        drawingCount:    room.drawings.length
    });
});

// List all active rooms (admin — requires global GM password)
app.get('/api/rooms', requireGM, (_req, res) => {
    const summary = Object.entries(rooms).map(([id, r]) => ({
        roomId:          id,
        activeMap:       r.activeMap ? r.activeMap.filename : null,
        drawingCount:    r.drawings.length,
        drawingsVisible: r.drawingsVisible,
        persistent:      !!roomsData[id]
    }));
    res.json(summary);
});

// Activate a map for a room — broadcasts to all players in that room
app.post('/api/activate', requireRoomGM, (req, res) => {
    const { roomId = 'default', filename } = req.body;
    if (!filename) return res.status(400).json({ error: 'filename required' });

    const filePath = path.join(UPLOADS_DIR, path.basename(filename));
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on server' });

    const room = getRoom(roomId);
    room.activeMap = {
        filename,
        url: `/uploads/${encodeURIComponent(filename)}`
    };
    room.drawings = []; // reset drawings for new map
    resetInactivityTimer(roomId);

    io.to(roomId).emit('map-changed', room.activeMap);
    io.to(roomId).emit('drawings-updated', []);

    res.json({ ok: true, activeMap: room.activeMap });
});

// Clear all player drawings for a room (volatile only)
app.post('/api/clear/:roomId', requireRoomGM, (req, res) => {
    const room = getRoom(req.params.roomId);
    room.drawings = [];
    io.to(req.params.roomId).emit('drawings-cleared');
    res.json({ ok: true });
});

// Toggle whether submitted drawings are visible to players
app.post('/api/visibility/:roomId', requireRoomGM, (req, res) => {
    const room = getRoom(req.params.roomId);
    if (typeof req.body.visible === 'boolean') {
        room.drawingsVisible = req.body.visible;
    } else {
        room.drawingsVisible = !room.drawingsVisible;
    }
    io.to(req.params.roomId).emit(
        'drawings-updated',
        room.drawingsVisible ? room.drawings : []
    );
    io.to(req.params.roomId).emit('visibility-changed', room.drawingsVisible);
    res.json({ drawingsVisible: room.drawingsVisible });
});

// ── Socket.io ─────────────────────────────────────────────────────
io.on('connection', socket => {
    let currentRoom = null;
    let clientIsGM  = false;

    // Player (or GM viewer) joins a room
    socket.on('join-room', ({ roomId: _rjoin = 'default', password, callsign } = {}) => {
        const roomId = sanitizeId(_rjoin) || 'default';
        // Leave previous room if rejoining
        if (currentRoom && currentRoom !== roomId) {
            const prevRoom = rooms[currentRoom];
            if (prevRoom) {
                prevRoom.players.delete(socket.id);
                broadcastPlayerList(currentRoom);
            }
            socket.leave(currentRoom);
        }

        currentRoom = roomId;

        // Per-room GM authentication: creates room entry on first GM join
        clientIsGM = password ? verifyAndInitRoom(roomId, password) : false;

        socket.join(roomId);
        const room = getRoom(roomId);
        resetInactivityTimer(roomId);

        room.players.set(socket.id, {
            callsign: callsign || `P-${socket.id.slice(0, 4).toUpperCase()}`,
            isGM: clientIsGM
        });

        socket.emit('room-state', {
            activeMap:       room.activeMap,
            drawings:        visibleDrawings(room, clientIsGM),
            drawingsVisible: room.drawingsVisible,
            focusOwner:      room.focusOwner,
            isGM:            clientIsGM
        });

        broadcastPlayerList(roomId);
    });

    // Player submits their ghost plan
    socket.on('submit-plan', ({ roomId: _rsub = 'default', drawings: incoming } = {}) => {
        const roomId = sanitizeId(_rsub) || 'default';
        if (!Array.isArray(incoming)) return;
        const room = getRoom(roomId);
        resetInactivityTimer(roomId);

        incoming.forEach(d => {
            room.drawings.push({
                ...d,
                id:       `${socket.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                socketId: socket.id,
                isGM:     false
            });
        });

        if (room.drawingsVisible) {
            io.to(roomId).emit('drawings-updated', room.drawings);
        } else {
            socket.to(roomId).emit('drawings-updated-gm', room.drawings);
            socket.emit('drawings-updated', room.drawings);
        }
    });

    // ── Global focus ("Look at me!") ──────────────────────────────
    socket.on('set-global-focus', ({ roomId: _rfoc = 'default', callsign: cs } = {}) => {
        const roomId = sanitizeId(_rfoc) || 'default';
        const room = getRoom(roomId);
        room.focusOwner = cs || null;
        io.to(roomId).emit('focus-switched', room.focusOwner);
    });

    socket.on('clear-focus', ({ roomId: _rcf = 'default' } = {}) => {
        const roomId = sanitizeId(_rcf) || 'default';
        const room = getRoom(roomId);
        room.focusOwner = null;
        io.to(roomId).emit('focus-cleared');
    });

    // GM broadcasts a live in-progress stroke (uses authenticated clientIsGM flag)
    socket.on('gm-live-stroke', ({ roomId: _rls = 'default', stroke } = {}) => {
        const roomId = sanitizeId(_rls) || 'default';
        if (!clientIsGM) return;
        socket.to(roomId).emit('gm-live-stroke', stroke || null);
    });

    // GM submits drawings (uses authenticated clientIsGM flag)
    socket.on('gm-draw', ({ roomId: _rgd = 'default', drawings: incoming, hidden = false } = {}) => {
        const roomId = sanitizeId(_rgd) || 'default';
        if (!clientIsGM) return;
        const room = getRoom(roomId);
        resetInactivityTimer(roomId);

        incoming.forEach(d => {
            room.drawings.push({
                ...d,
                id:     `gm-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                isGM:   true,
                hidden
            });
        });

        if (hidden) {
            socket.emit('drawings-updated', room.drawings);
        } else {
            io.to(roomId).emit('drawings-updated', room.drawings);
        }
    });

    // GM undoes their last drawing
    socket.on('gm-undo', ({ roomId: _rgu = 'default' } = {}) => {
        const roomId = sanitizeId(_rgu) || 'default';
        if (!clientIsGM) return;
        const room = getRoom(roomId);
        for (let i = room.drawings.length - 1; i >= 0; i--) {
            if (room.drawings[i].isGM) {
                room.drawings.splice(i, 1);
                break;
            }
        }
        io.to(roomId).emit('drawings-updated', room.drawings);
    });

    // GM clears only their own drawings
    socket.on('gm-clear-own', ({ roomId: _rco = 'default' } = {}) => {
        const roomId = sanitizeId(_rco) || 'default';
        if (!clientIsGM) return;
        const room = getRoom(roomId);
        room.drawings = room.drawings.filter(d => !d.isGM);
        io.to(roomId).emit('drawings-updated', room.drawings);
    });

    socket.on('disconnect', () => {
        if (currentRoom) {
            const room = rooms[currentRoom];
            if (room) {
                room.players.delete(socket.id);
                broadcastPlayerList(currentRoom);
            }
        }
    });
});

// ── Error handler ─────────────────────────────────────────────────
app.use((err, _req, res, _next) => {
    console.error(err.message);
    res.status(400).json({ error: err.message });
});

// ── Start ─────────────────────────────────────────────────────────
server.listen(PORT, () => {
    console.log('╔══════════════════════════════════════════╗');
    console.log(`║  GOD Tactical Server  •  port ${PORT}       ║`);
    console.log(`║  GM Password: ${GM_PASSWORD.padEnd(27)}║`);
    console.log(`║  Player URL:  http://localhost:${PORT}/tactical_player.html  ║`);
    console.log(`║  GM URL:      http://localhost:${PORT}/gm_admin.html         ║`);
    console.log('╚══════════════════════════════════════════╝');
});
