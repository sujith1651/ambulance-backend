const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const { Expo } = require('expo-server-sdk');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*', methods: ['GET', 'POST'] },
});

const expo = new Expo();

app.use(cors());
app.use(express.json());

// ─── In-memory stores ─────────────────────────────────────────────────────────
const JWT_SECRET = 'ambulance_secret_2025';
const GOOGLE_MAPS_API_KEY = process.env.GOOGLE_MAPS_API_KEY || 'AIzaSyDehtJreZosPoaC6acYry6HJ9yn3L4rfWc';

const drivers = new Map();       // email → { id, email, passwordHash, name }
const activeAlerts = new Map();  // socketId → { driverName, latitude, longitude, routePolyline, hospitalName, timestamp }
const publicUsers = new Map();   // socketId → { pushToken, latitude, longitude, isDriver: false }
const driverSockets = new Set(); // socketIds of connected drivers
const accidentReports = new Map(); // reportId → { type, description, latitude, longitude, reporterSocketId, timestamp }

// ─── Seed default driver ──────────────────────────────────────────────────────
(async () => {
    const hash = await bcrypt.hash('driver123', 10);
    drivers.set('driver@alert.com', {
        id: uuidv4(), email: 'driver@alert.com', passwordHash: hash, name: 'Default Driver',
    });
    console.log('🚑  Seeded default driver  →  driver@alert.com / driver123');
})();

// ─── Geometry helpers ─────────────────────────────────────────────────────────

// Haversine distance in metres between two lat/lng points
function haversineMetres(lat1, lng1, lat2, lng2) {
    const R = 6371000;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLng = (lng2 - lng1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLng / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Minimum distance from point P to line segment AB (all in lat/lng degrees, result in metres)
function distPointToSegment(pLat, pLng, aLat, aLng, bLat, bLng) {
    const dx = bLat - aLat, dy = bLng - aLng;
    if (dx === 0 && dy === 0) return haversineMetres(pLat, pLng, aLat, aLng);
    let t = ((pLat - aLat) * dx + (pLng - aLng) * dy) / (dx * dx + dy * dy);
    t = Math.max(0, Math.min(1, t));
    return haversineMetres(pLat, pLng, aLat + t * dx, aLng + t * dy);
}

// Check if a user is within radiusMetres of ANY segment of the route polyline
function isOnRoute(userLat, userLng, polyline, radiusMetres = 1000) {
    if (!polyline || polyline.length < 2) return true; // no route → alert everyone
    for (let i = 0; i < polyline.length - 1; i++) {
        const dist = distPointToSegment(
            userLat, userLng,
            polyline[i].latitude, polyline[i].longitude,
            polyline[i + 1].latitude, polyline[i + 1].longitude
        );
        if (dist <= radiusMetres) return true;
    }
    return false;
}

// ─── Push Notifications ───────────────────────────────────────────────────────
async function sendPushToUsers(socketIds, title, body, data = {}) {
    const messages = [];
    for (const sid of socketIds) {
        const user = publicUsers.get(sid);
        if (user && user.pushToken && Expo.isExpoPushToken(user.pushToken)) {
            messages.push({ to: user.pushToken, sound: 'default', title, body, data });
        }
    }
    if (!messages.length) return;
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
        try { await expo.sendPushNotificationsAsync(chunk); } catch (e) { console.error('Push error:', e); }
    }
}

// Find public users along the ambulance route
function getAffectedPublicUsers(routePolyline) {
    const affected = [];
    for (const [sid, user] of publicUsers) {
        if (user.isDriver) continue;
        if (user.latitude == null) { affected.push(sid); continue; } // unknown location → include
        if (isOnRoute(user.latitude, user.longitude, routePolyline)) affected.push(sid);
    }
    return affected;
}

// ─── Auth Routes ──────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password || !name) return res.status(400).json({ error: 'All fields required' });
    if (drivers.has(email)) return res.status(409).json({ error: 'Email already registered' });
    const passwordHash = await bcrypt.hash(password, 10);
    const driver = { id: uuidv4(), email, passwordHash, name };
    drivers.set(email, driver);
    const token = jwt.sign({ id: driver.id, email, name }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, name, email });
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const driver = drivers.get(email);
    if (!driver) return res.status(404).json({ error: 'Driver not found' });
    const match = await bcrypt.compare(password, driver.passwordHash);
    if (!match) return res.status(401).json({ error: 'Invalid credentials' });
    const token = jwt.sign({ id: driver.id, email, name: driver.name }, JWT_SECRET, { expiresIn: '7d' });
    return res.json({ token, name: driver.name, email });
});

app.get('/api/health', (_, res) => res.json({ status: 'ok', activeAlerts: activeAlerts.size, accidentReports: accidentReports.size }));

// ─── Free Maps Proxy (OpenStreetMap Overpass + OSRM — no billing) ────────────
app.get('/api/maps/places', async (req, res) => {
    try {
        const { latitude, longitude, radiusMetres } = req.query;
        if (!latitude || !longitude) return res.status(400).json({ error: 'Missing coordinates' });

        const radius = radiusMetres || 5000;
        const overpassQuery = `[out:json][timeout:25];(node["amenity"~"hospital|clinic"](around:${radius},${latitude},${longitude});way["amenity"~"hospital|clinic"](around:${radius},${latitude},${longitude}););out center;`;
        const url = `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(overpassQuery)}`;

        const response = await fetch(url, { headers: { 'User-Agent': 'AmbulanceApp/1.0' } });
        const data = await response.json();

        const results = (data.elements || []).map(el => {
            const lat = el.lat ?? el.center?.lat;
            const lng = el.lon ?? el.center?.lon;
            const name = el.tags?.name || el.tags?.['name:en'] || 'Hospital';
            const address = [el.tags?.['addr:street'], el.tags?.['addr:city']].filter(Boolean).join(', ') || '';
            return { place_id: String(el.id), name, vicinity: address, geometry: { location: { lat, lng } } };
        }).filter(r => r.geometry.location.lat != null);

        res.json({ status: 'OK', results });
    } catch (e) {
        console.error('Places Proxy Error:', e);
        res.status(500).json({ error: 'Failed to fetch places' });
    }
});

app.get('/api/maps/directions', async (req, res) => {
    try {
        const { originLat, originLng, destLat, destLng } = req.query;
        if (!originLat || !originLng || !destLat || !destLng) return res.status(400).json({ error: 'Missing coordinates' });

        const url = `https://router.project-osrm.org/route/v1/driving/${originLng},${originLat};${destLng},${destLat}?overview=full&geometries=geojson`;
        const response = await fetch(url, { headers: { 'User-Agent': 'AmbulanceApp/1.0' } });
        const data = await response.json();

        if (data.code !== 'Ok' || !data.routes?.length) {
            return res.status(400).json({ error: 'No route found' });
        }

        const route = data.routes[0];
        const polyline = route.geometry.coordinates.map(([lng, lat]) => ({ latitude: lat, longitude: lng }));
        const durationText = `${Math.round(route.duration / 60)} min`;
        const distanceText = `${(route.distance / 1000).toFixed(1)} km`;

        res.json({ status: 'OK', polyline, durationText, distanceText });
    } catch (e) {
        console.error('Directions Proxy Error:', e);
        res.status(500).json({ error: 'Failed to fetch directions' });
    }
});

// ─── Socket.io ────────────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`✅  Connected: ${socket.id}`);

    // ── Public user registers (push token + initial location) ──────────────────
    socket.on('public:register', ({ pushToken, latitude, longitude }) => {
        publicUsers.set(socket.id, { pushToken, latitude, longitude, isDriver: false });
        console.log(`📱  Public registered (total: ${publicUsers.size})`);

        // Send any currently active alerts
        const alerts = Array.from(activeAlerts.values());
        if (alerts.length > 0) socket.emit('alert:current_active', alerts);

        // Send active accident reports
        const reports = Array.from(accidentReports.values());
        if (reports.length > 0) socket.emit('accidents:current', reports);
    });

    // ── Public user updates location (for route-based alerting) ───────────────
    socket.on('public:update_location', ({ latitude, longitude }) => {
        const user = publicUsers.get(socket.id);
        if (user) {
            user.latitude = latitude;
            user.longitude = longitude;
        }
    });

    // ── Driver registers ───────────────────────────────────────────────────────
    socket.on('driver:register', () => {
        driverSockets.add(socket.id);
        publicUsers.set(socket.id, { isDriver: true });

        // Send existing accident reports to driver
        const reports = Array.from(accidentReports.values());
        if (reports.length > 0) socket.emit('accidents:current', reports);
    });

    // ── Driver activates alert ─────────────────────────────────────────────────
    socket.on('driver:activate', async ({ driverName, latitude, longitude, routePolyline, hospitalName }) => {
        const alertInfo = {
            socketId: socket.id, driverName: driverName || 'Ambulance',
            latitude, longitude, routePolyline: routePolyline || [],
            hospitalName: hospitalName || 'Hospital', timestamp: Date.now(),
        };
        activeAlerts.set(socket.id, alertInfo);
        console.log(`🚨  Alert ACTIVATED by ${driverName} → ${hospitalName}`);

        // Find affected public users (within 1km of route)
        const affectedSids = getAffectedPublicUsers(routePolyline);
        console.log(`   Alerting ${affectedSids.length} public users on route`);

        // Emit to affected sockets
        for (const sid of affectedSids) {
            io.to(sid).emit('alert:new', alertInfo);
        }

        // Push notifications to affected users
        await sendPushToUsers(affectedSids,
            '🚨 AMBULANCE APPROACHING!',
            `Please clear the road. Ambulance heading to ${hospitalName || 'hospital'}.`,
            { type: 'alert_new', ...alertInfo }
        );
    });

    // ── Driver sends location update ───────────────────────────────────────────
    socket.on('driver:location', ({ latitude, longitude }) => {
        const alert = activeAlerts.get(socket.id);
        if (!alert) return;
        alert.latitude = latitude;
        alert.longitude = longitude;

        // Re-check which public users are now on the route
        const affectedSids = getAffectedPublicUsers(alert.routePolyline);
        for (const sid of affectedSids) {
            io.to(sid).emit('alert:location_update', { socketId: socket.id, latitude, longitude });
        }
    });

    // ── Driver deactivates alert ───────────────────────────────────────────────
    socket.on('driver:deactivate', async () => {
        const alert = activeAlerts.get(socket.id);
        if (!alert) return;
        activeAlerts.delete(socket.id);
        console.log(`✅  Alert CLEARED by ${alert.driverName}`);
        socket.broadcast.emit('alert:cleared', { socketId: socket.id });
        await sendPushToUsers(
            getAffectedPublicUsers(alert.routePolyline),
            '✅ Ambulance has passed',
            'The road is now clear. Thank you!',
            { type: 'alert_cleared' }
        );
    });

    // ── Public reports accident ────────────────────────────────────────────────
    socket.on('public:accident_report', async ({ type, description, latitude, longitude }) => {
        const reportId = uuidv4();
        const report = {
            reportId, type, description, latitude, longitude,
            reporterSocketId: socket.id, timestamp: Date.now(),
        };
        accidentReports.set(reportId, report);
        console.log(`🆘  Accident reported: ${type} at ${latitude}, ${longitude}`);

        // Broadcast to ALL drivers
        for (const sid of driverSockets) {
            io.to(sid).emit('accident:new', report);
        }
    });

    // ── Driver accepts/dismisses accident report ───────────────────────────────
    socket.on('driver:accept_report', ({ reportId }) => {
        accidentReports.delete(reportId);
        socket.broadcast.emit('accident:accepted', { reportId, driverSocketId: socket.id });
    });

    // ── Disconnect ─────────────────────────────────────────────────────────────
    socket.on('disconnect', async () => {
        console.log(`❌  Disconnected: ${socket.id}`);
        driverSockets.delete(socket.id);
        publicUsers.delete(socket.id);

        if (activeAlerts.has(socket.id)) {
            const alert = activeAlerts.get(socket.id);
            activeAlerts.delete(socket.id);
            socket.broadcast.emit('alert:cleared', { socketId: socket.id });
            console.log(`🧹  Auto-cleared alert for disconnected driver: ${alert.driverName}`);
        }
    });
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀  Server running on port ${PORT}`);
    console.log(`📡  Health: http://localhost:${PORT}/api/health\n`);
});