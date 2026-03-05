const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const Database = require('better-sqlite3');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');

const app = express();
const PORT = process.env.PORT || 3000;
app.set('trust proxy', 1); // Trust first proxy for rate limiting if behind a reverse proxy

// CONFIG
const UPLOAD_DIR = path.join(__dirname, 'uploads');
const TTL = 24 * 60 * 60 * 1000; // 24 hours

// Ensure upload directory exists
if (!fs.existsSync(UPLOAD_DIR)) {
    fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// DB
const db = new Database('files.db');

// Using WAL mode for better concurrency
db.pragma('journal_mode = WAL');

// Create table if not exists
db.prepare(`
CREATE TABLE IF NOT EXISTS files (
    code TEXT PRIMARY KEY,
    stored_name TEXT,
    original_name TEXT,
    mime TEXT,
    size INTEGER,
    created_at INTEGER,
    expires_at INTEGER,
    passhash TEXT
)
`).run();

// SECURITY
// Helmet 8.x configuration
app.use(
    helmet({
        contentSecurityPolicy: {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'", "'unsafe-inline'", "https://cdn.jsdelivr.net"],
                styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
                fontSrc: ["'self'", "https://fonts.gstatic.com"],
                imgSrc: ["'self'", "data:"],
                connectSrc: ["'self'", "https://cdn.jsdelivr.net"],
                // Prevent forced HTTPS upgrade to allow local testing without SSL
                // upgradeInsecureRequests: null
            }
        }
    })
);

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Rate Limit v8 standards
const limiter = rateLimit({
    windowMs: 60 * 1000, // 1 minute
    limit: 30, // limit each IP to 30 requests per windowMs
    standardHeaders: 'draft-8', // Return rate limit info in the `RateLimit-*` headers
    legacyHeaders: false, // Disable the `X-RateLimit-*` headers
    message: { error: 'Too many requests, please try again later.' }
});

// MULTER 2.1.0 configuration
const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, UPLOAD_DIR),
    filename: (req, file, cb) => {
        const unique = Date.now() + '-' + Math.random().toString(36).slice(2);
        cb(null, unique);
    }
});

const upload = multer({
    storage,
    limits: {
        fileSize: 200 * 1024 * 1024, // 200MB
        files: 1, // Only allow 1 file per upload
        fields: 6, // code, password, ttl, etc.
        parts: 10 // Total parts (files + fields)
    }
});

// HELPERS
function generateCode() {
    return Math.floor(100000 + Math.random() * 900000).toString(); // 6-digit code
}

function hash(text) {
    if (!text) return null; // Handle empty password case
    return crypto.createHash('sha256').update(text).digest('hex'); // SHA-256 is more secure than MD5
}

// ROUTES

// Upload endpoint
app.post('/upload', limiter, (req, res) => {
    upload.single('file')(req, res, (err) => {
        if (err) {
            if (err.code === 'LIMIT_FILE_SIZE') {
                return res.status(400).json({ error: 'File is too large (maximum limit: 200MB).' });
            }
            return res.status(400).json({ error: err.message });
        }

        if (!req.file) {
            return res.status(400).json({ error: 'No file uploaded.' });
        }

        try {
            let code;
            let isUnique = false;

            // Prevent code collisions
            while (!isUnique) {
                code = generateCode();
                const existing = db.prepare(`SELECT code FROM files WHERE code=?`).get(code);
                if (!existing) isUnique = true;
            }

            const now = Date.now();
            const passHash = req.body.passphrase ? hash(req.body.passphrase) : null;

            db.prepare(`
            INSERT INTO files VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            `).run(
                code,
                req.file.filename,
                req.file.originalname,
                req.file.mimetype,
                req.file.size,
                now,
                now + TTL,
                passHash
            );

            res.json({ code, expires_at: now + TTL });
        } catch (dbError) {
            console.error('Database error during upload:', dbError);
            res.status(500).json({ error: 'Internal server error.' });
        }
    });
});

// File Info endpoint
app.post('/api/info', (req, res) => {
    const { code, passphrase } = req.body;
    const row = db.prepare(`SELECT * FROM files WHERE code=?`).get(code);

    if (!row) return res.status(404).json({ error: 'File not found.' });
    if (Date.now() > row.expires_at) return res.status(410).json({ error: 'File has expired.' });
    if (row.passhash && hash(passphrase) !== row.passhash) return res.status(403).json({ error: 'Incorrect passphrase.' });

    res.json({
        name: row.original_name,
        size: row.size,
        mime: row.mime,
        previewable: row.mime.startsWith('image/') || row.mime.startsWith('text/') || row.mime === 'application/pdf'
    });
});

// Preview endpoint
app.post('/api/preview', (req, res) => {
    const { code, passphrase } = req.body;
    const row = db.prepare(`SELECT * FROM files WHERE code=?`).get(code);

    if (!row) return res.status(404).json({ error: 'File not found.' });
    if (Date.now() > row.expires_at) return res.status(410).json({ error: 'File has expired.' });
    if (row.passhash && hash(passphrase) !== row.passhash) return res.status(403).json({ error: 'Incorrect passphrase.' });

    const filePath = path.join(UPLOAD_DIR, row.stored_name);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on server.' });

    res.setHeader('Content-Type', row.mime);
    res.sendFile(filePath);
});

// Download (one-time) endpoint
app.post('/redeem', (req, res) => {
    const { code, passphrase } = req.body;
    const row = db.prepare(`SELECT * FROM files WHERE code=?`).get(code);

    if (!row) return res.status(404).json({ error: 'File not found.' });
    if (Date.now() > row.expires_at) return res.status(410).json({ error: 'File has expired.' });
    if (row.passhash && hash(passphrase) !== row.passhash) return res.status(403).json({ error: 'Incorrect passphrase.' });

    const filePath = path.join(UPLOAD_DIR, row.stored_name);

    // Immediately delete the file to prevent race conditions multiple downloads
    db.prepare(`DELETE FROM files WHERE code=?`).run(code);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'File not found on server.' });

    res.download(filePath, row.original_name, (err) => {
        if (err) console.error('Download error:', err);
        // Asynchronously delete the file after sending response
        fs.unlink(filePath, (unlinkErr) => {
            if (unlinkErr && unlinkErr.code !== 'ENOENT') {
                console.error('Cleanup error:', unlinkErr);
            }
        });
    });
});

// Cleanup job to remove expired files every hour
setInterval(() => {
    const now = Date.now();
    const expired = db.prepare(`SELECT * FROM files WHERE expires_at < ?`).all(now);

    for (const file of expired) {
        const filePath = path.join(UPLOAD_DIR, file.stored_name);
        fs.unlink(filePath, (err) => {
            if (err && err.code !== 'ENOENT') console.error('Failed to delete expired file:', err);
        });
    }

    db.prepare(`DELETE FROM files WHERE expires_at < ?`).run(now);
}, 60 * 60 * 1000); // Every hour

// Global error handler
app.use((err, req, res, _next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something broke on the server!' });
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`Server is running on http://localhost:${PORT}`);
});

server.timeout = 10 * 60 * 1000; // 10 minutes timeout for long uploads/downloads
