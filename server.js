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
    cors: {
        origin: '*',
        methods: ['GET', 'POST'],
    },
});

const expo = new Expo();

app.use(cors());
app.use(express.json());

// ─── In-memory stores ────────────────────────────────────────────────────────
const JWT_SECRET = 'ambulance_secret_2025';
const drivers = new Map();      // email → { id, email, passwordHash, name }
const activeAlerts = new Map(); // socketId → { driverId, name, latitude, longitude, timestamp }
const publicTokens = new Set(); // Expo push tokens for public users

// ─── Seed a default driver ────────────────────────────────────────────────────
(async () => {
    const hash = await bcrypt.hash('driver123', 10);
    drivers.set('driver@alert.com', {
        id: uuidv4(),
        email: 'driver@alert.com',
        passwordHash: hash,
        name: 'Default Driver',
    });
    console.log('🚑  Seeded default driver  →  driver@alert.com / driver123');
})();

// ─── Auth Routes ─────────────────────────────────────────────────────────────
app.post('/api/auth/register', async (req, res) => {
    const { email, password, name } = req.body;
    if (!email || !password || !name)
        return res.status(400).json({ error: 'All fields required' });
    if (drivers.has(email))
        return res.status(409).json({ error: 'Email already registered' });

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

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/api/health', (_, res) => res.json({ status: 'ok', activeAlerts: activeAlerts.size }));

// ─── Socket.io: send Expo push notification to all public users ───────────────
async function sendPushNotification(title, body, data = {}) {
    const messages = [];
    for (const token of publicTokens) {
        if (!Expo.isExpoPushToken(token)) continue;
        messages.push({ to: token, sound: 'default', title, body, data });
    }
    if (messages.length === 0) return;

    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
        try {
            await expo.sendPushNotificationsAsync(chunk);
        } catch (err) {
            console.error('Push notification error:', err);
        }
    }
}

// ─── Socket.io Events ─────────────────────────────────────────────────────────
io.on('connection', (socket) => {
    console.log(`✅  Client connected: ${socket.id}`);

    // Public user registers their Expo push token
    socket.on('public:register_token', (token) => {
        if (token && Expo.isExpoPushToken(token)) {
            publicTokens.add(token);
            console.log(`📱  Registered push token (total: ${publicTokens.size})`);
        }
        // Send any currently active alerts to this new public user
        const currentAlerts = Array.from(activeAlerts.values());
        if (currentAlerts.length > 0) {
            socket.emit('alert:current_active', currentAlerts);
        }
    });

    // Driver activates alert
    socket.on('driver:activate', async (data) => {
        const { driverName, latitude, longitude, token } = data;
        const alertInfo = {
            socketId: socket.id,
            driverName: driverName || 'Ambulance',
            latitude,
            longitude,
            timestamp: Date.now(),
        };
        activeAlerts.set(socket.id, alertInfo);
        console.log(`🚨  Alert ACTIVATED by ${driverName} at ${latitude}, ${longitude}`);

        // Broadcast to all public users via socket
        socket.broadcast.emit('alert:new', alertInfo);

        // Send push notification to all registered public users
        await sendPushNotification(
            '🚨 AMBULANCE APPROACHING!',
            `Please clear the road immediately. An ambulance is nearby.`,
            { type: 'alert_new', ...alertInfo }
        );
    });

    // Driver sends location update
    socket.on('driver:location', (data) => {
        const { latitude, longitude } = data;
        if (activeAlerts.has(socket.id)) {
            const alert = activeAlerts.get(socket.id);
            alert.latitude = latitude;
            alert.longitude = longitude;
            activeAlerts.set(socket.id, alert);
            // Broadcast location update to public users
            socket.broadcast.emit('alert:location_update', {
                socketId: socket.id,
                latitude,
                longitude,
            });
        }
    });

    // Driver deactivates alert
    socket.on('driver:deactivate', async () => {
        if (activeAlerts.has(socket.id)) {
            const alert = activeAlerts.get(socket.id);
            activeAlerts.delete(socket.id);
            console.log(`✅  Alert CLEARED by ${alert.driverName}`);

            // Broadcast clearance to all public users via socket
            socket.broadcast.emit('alert:cleared', { socketId: socket.id });

            // Send push notification that alert is cleared
            await sendPushNotification(
                '✅ Ambulance has passed',
                'The road is now clear. Thank you for cooperating.',
                { type: 'alert_cleared' }
            );
        }
    });

    // Handle disconnect (auto-clear alert if driver disconnects)
    socket.on('disconnect', async () => {
        console.log(`❌  Client disconnected: ${socket.id}`);
        if (activeAlerts.has(socket.id)) {
            const alert = activeAlerts.get(socket.id);
            activeAlerts.delete(socket.id);
            socket.broadcast.emit('alert:cleared', { socketId: socket.id });
            await sendPushNotification(
                '✅ Ambulance has passed',
                'The road is now clear. Thank you for cooperating.',
                { type: 'alert_cleared' }
            );
            console.log(`🧹  Auto-cleared alert for disconnected driver: ${alert.driverName}`);
        }
    });
});

// ─── Start server ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`\n🚀  Ambulance Alert Server running on port ${PORT}`);
    console.log(`📡  Listening on all interfaces (0.0.0.0:${PORT})`);
    console.log(`🌐  Local:   http://localhost:${PORT}`);
    console.log(`   Health:  http://localhost:${PORT}/api/health\n`);
});
