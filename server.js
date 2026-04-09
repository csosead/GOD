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

const storage = multer.diskStorage({
    destination: UPLOADS_DIR,
    filename: (req, file, cb) => {
        // Sanitize filename, preserve extension
        const safe = file.originalname
            .replace(/[^a-zA-Z0-9._\- ]/g, '_')
            .replace(/\s+/g, '_');
        // If a file with that name already exists, prefix with a timestamp
        const dest = path.join(UPLOADS_DIR, safe);
        if (fs.existsSync(dest)) {
            cb(null, `${Date.now()}_${safe}`);
        } else {
            cb(null, safe);
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

function getRoom(roomId) {
    if (!rooms[roomId]) {
        rooms[roomId] = {
            activeMap:       null,
            drawings:        [],
            drawingsVisible: true,
            focusOwner:      null,   // callsign of whoever holds the spotlight, or null
            players:         new Map()
        };
    }
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
    return [];   // players see nothing until GM makes visible
}

// ── Middleware ────────────────────────────────────────────────────
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));
app.use('/uploads', express.static(UPLOADS_DIR));

// ── GM auth helper ────────────────────────────────────────────────
function isGM(req) {
    const pw = req.headers['x-gm-password'] || req.query.pw;
    return pw === GM_PASSWORD;
}
function requireGM(req, res, next) {
    if (!isGM(req)) return res.status(401).json({ error: 'Unauthorized — wrong GM password' });
    next();
}

// ── REST API ──────────────────────────────────────────────────────

// Upload a new .gridmap file
app.post('/api/upload', requireGM, upload.single('map'), (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'No valid .gridmap file received' });
    res.json({
        filename:     req.file.filename,
        originalName: req.file.originalname,
        url:          `/uploads/${encodeURIComponent(req.file.filename)}`
    });
});

// List all .gridmap files in the uploads folder
app.get('/api/maps', requireGM, (_req, res) => {
    const files = fs.readdirSync(UPLOADS_DIR)
        .filter(f => f.toLowerCase().endsWith('.gridmap'))
        .map(f => ({
            filename: f,
            url:      `/uploads/${encodeURIComponent(f)}`,
            size:     fs.statSync(path.join(UPLOADS_DIR, f)).size
        }));
    res.json(files);
});

// Delete a map file from the library
app.delete('/api/maps/:filename', requireGM, (req, res) => {
    const filename = path.basename(req.params.filename); // prevent path traversal
    const filePath = path.join(UPLOADS_DIR, filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found' });
    fs.unlinkSync(filePath);
    res.json({ ok: true });
});

// Get current public room state (players call this on startup)
app.get('/api/room/:roomId', (req, res) => {
    const room = getRoom(req.params.roomId);
    const gm   = isGM(req);
    res.json({
        activeMap:       room.activeMap,
        drawingsVisible: room.drawingsVisible,
        drawings:        visibleDrawings(room, gm),
        drawingCount:    room.drawings.length
    });
});

// List all active rooms (GM only)
app.get('/api/rooms', requireGM, (_req, res) => {
    const summary = Object.entries(rooms).map(([id, r]) => ({
        roomId:         id,
        activeMap:      r.activeMap ? r.activeMap.filename : null,
        drawingCount:   r.drawings.length,
        drawingsVisible: r.drawingsVisible
    }));
    res.json(summary);
});

// Activate a map for a room — broadcasts to all players in that room
app.post('/api/activate', requireGM, (req, res) => {
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

    // Push to all players in the room
    io.to(roomId).emit('map-changed', room.activeMap);
    io.to(roomId).emit('drawings-updated', []);

    res.json({ ok: true, activeMap: room.activeMap });
});

// Clear all player drawings for a room
app.post('/api/clear/:roomId', requireGM, (req, res) => {
    const room = getRoom(req.params.roomId);
    room.drawings = [];
    io.to(req.params.roomId).emit('drawings-cleared');
    res.json({ ok: true });
});

// Toggle whether submitted drawings are visible to players
app.post('/api/visibility/:roomId', requireGM, (req, res) => {
    const room = getRoom(req.params.roomId);
    // Allow explicit set via body, or toggle
    if (typeof req.body.visible === 'boolean') {
        room.drawingsVisible = req.body.visible;
    } else {
        room.drawingsVisible = !room.drawingsVisible;
    }
    // Notify players: send drawings if visible, empty array if hidden
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
    socket.on('join-room', ({ roomId = 'default', password, callsign } = {}) => {
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
        clientIsGM  = (password === GM_PASSWORD);

        socket.join(roomId);
        const room = getRoom(roomId);

        // Track this connection
        room.players.set(socket.id, {
            callsign: callsign || `P-${socket.id.slice(0, 4).toUpperCase()}`,
            isGM: clientIsGM
        });

        // Send the full current state to the new joiner
        socket.emit('room-state', {
            activeMap:       room.activeMap,
            drawings:        visibleDrawings(room, clientIsGM),
            drawingsVisible: room.drawingsVisible,
            focusOwner:      room.focusOwner,
            isGM:            clientIsGM   // lets the client confirm it was authenticated as GM
        });

        // Notify everyone of updated player list & count
        broadcastPlayerList(roomId);
    });

    // Player submits their ghost plan — drawings become visible on server
    socket.on('submit-plan', ({ roomId = 'default', drawings: incoming } = {}) => {
        if (!Array.isArray(incoming)) return;
        const room = getRoom(roomId);

        incoming.forEach(d => {
            room.drawings.push({
                ...d,
                id:       `${socket.id}-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                socketId: socket.id,
                isGM:     false
            });
        });

        // Broadcast only if drawings are currently visible to players
        if (room.drawingsVisible) {
            io.to(roomId).emit('drawings-updated', room.drawings);
        } else {
            // Still tell the GM viewer (if any) about new drawings
            socket.to(roomId).emit('drawings-updated-gm', room.drawings);
            socket.emit('drawings-updated', room.drawings); // echo back to submitter only
        }
    });

    // ── Global focus ("Look at me!") ──────────────────────────────
    // Any client can claim the spotlight; only one holder at a time.
    socket.on('set-global-focus', ({ roomId = 'default', callsign: cs } = {}) => {
        const room = getRoom(roomId);
        room.focusOwner = cs || null;
        io.to(roomId).emit('focus-switched', room.focusOwner);
    });

    socket.on('clear-focus', ({ roomId = 'default' } = {}) => {
        const room = getRoom(roomId);
        room.focusOwner = null;
        io.to(roomId).emit('focus-cleared');
    });

    // GM broadcasts a live in-progress stroke so players can see it as a pointer
    socket.on('gm-live-stroke', ({ roomId = 'default', stroke, password } = {}) => {
        if (password !== GM_PASSWORD) return;
        // Broadcast to everyone else in the room (no persistence)
        socket.to(roomId).emit('gm-live-stroke', stroke || null);
    });

    // GM submits their own (possibly hidden) template drawings
    socket.on('gm-draw', ({ roomId = 'default', drawings: incoming, password, hidden = false } = {}) => {
        if (password !== GM_PASSWORD) return;
        const room = getRoom(roomId);

        incoming.forEach(d => {
            room.drawings.push({
                ...d,
                id:     `gm-${Date.now()}-${Math.random().toString(36).slice(2)}`,
                isGM:   true,
                hidden  // if true, broadcast only to GM viewers
            });
        });

        if (hidden) {
            // Only the GM's own socket sees hidden drawings
            socket.emit('drawings-updated', room.drawings);
        } else {
            io.to(roomId).emit('drawings-updated', room.drawings);
        }
    });

    // GM undoes their last drawing on the server
    socket.on('gm-undo', ({ roomId = 'default', password } = {}) => {
        if (password !== GM_PASSWORD) return;
        const room = getRoom(roomId);
        // Remove the most recent GM drawing
        for (let i = room.drawings.length - 1; i >= 0; i--) {
            if (room.drawings[i].isGM) {
                room.drawings.splice(i, 1);
                break;
            }
        }
        io.to(roomId).emit('drawings-updated', room.drawings);
    });

    // GM clears only their own drawings (keeps player drawings intact)
    socket.on('gm-clear-own', ({ roomId = 'default', password } = {}) => {
        if (password !== GM_PASSWORD) return;
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
