/* ============================================================
   Chat With Strangers — Server (Full v3)
   Auth + Email verify, Guest backup, Friends, Block/Report,
   Image + Voice + Video, Online count, Ice breakers,
   Filters (gender/country/interests), Moderation (auto-ban).
   ============================================================ */

const express = require('express');
const http = require('http');
const path = require('path');
const fs = require('fs');
const { Server } = require('socket.io');
const initSqlJs = require('sql.js');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const multer = require('multer');
const nodemailer = require('nodemailer');
const rateLimit = require('express-rate-limit');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { maxHttpBufferSize: 1e8 });

const SECRET = 'cws-change-this-secret-in-production';
const DB_FILE = path.join(__dirname, 'database.sqlite');
const BASE_URL = process.env.BASE_URL || 'http://localhost:3000';

// ---------- FOLDERS ----------
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// ---------- DATABASE ----------
let SQL = null;
let db = null;

function dbRun(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  stmt.step();
  stmt.free();
  saveDb();
}
function dbGet(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  let row = null;
  if (stmt.step()) row = stmt.getAsObject();
  stmt.free();
  return row;
}
function dbAll(sql, params = []) {
  const stmt = db.prepare(sql);
  stmt.bind(params);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}
function saveDb() {
  try {
    fs.writeFileSync(DB_FILE, Buffer.from(db.export()));
  } catch (e) { console.error('DB save error:', e); }
}

async function initDb() {
  SQL = await initSqlJs();
  if (fs.existsSync(DB_FILE)) {
    db = new SQL.Database(new Uint8Array(fs.readFileSync(DB_FILE)));
  } else {
    db = new SQL.Database();
  }

  db.run(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT UNIQUE,
      email TEXT UNIQUE,
      password TEXT,
      country TEXT DEFAULT 'US',
      gender TEXT DEFAULT 'any',
      interests TEXT DEFAULT '',
      avatar TEXT DEFAULT '',
      verified INTEGER DEFAULT 0,
      verify_token TEXT,
      banned INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      room_id TEXT,
      sender_id TEXT,
      sender_name TEXT,
      text TEXT,
      image TEXT,
      audio TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS guest_backups (
      guest_id TEXT PRIMARY KEY,
      history TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS friends (
      user_id TEXT,
      friend_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, friend_id)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS blocks (
      user_id TEXT,
      blocked_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, blocked_id)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      reporter_id TEXT,
      reported_id TEXT,
      reason TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);
  saveDb();
  console.log('📦 Database ready');
}

// ---------- MIDDLEWARE ----------
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
app.use('/api/', apiLimiter);

// ---------- UPLOAD ----------
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.bin';
    cb(null, `${uuidv4()}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^(image\/(jpeg|png|jpg|gif|webp)|audio\/(webm|mp3|mpeg|ogg|wav|m4a))/.test(file.mimetype))
      cb(null, true);
    else cb(new Error('Only images or audio allowed'));
  }
});

// ---------- EMAIL ----------
let mailer = null;
async function initMailer() {
  try {
    const testAccount = await nodemailer.createTestAccount();
    mailer = nodemailer.createTransport({
      host: 'smtp.ethereal.email',
      port: 587,
      secure: false,
      auth: { user: testAccount.user, pass: testAccount.pass }
    });
    console.log('📧 Email ready (Ethereal)');
  } catch {
    console.warn('⚠️ Email disabled');
  }
}
async function sendVerifyEmail(to, token, username) {
  if (!mailer) {
    console.log(`\n📧 VERIFY LINK for ${username}: ${BASE_URL}/api/verify?token=${token}\n`);
    return null;
  }
  const link = `${BASE_URL}/api/verify?token=${token}`;
  const info = await mailer.sendMail({
    from: '"Chat With Strangers" <no-reply@cws.test>',
    to,
    subject: 'Verify your account',
    html: `<h2>Welcome, ${username}!</h2>
           <p><a href="${link}">Click here to verify</a></p>`
  });
  const previewUrl = nodemailer.getTestMessageUrl(info);
  console.log(`\n📧 Verification for ${username}:\n   ${link}\n   Preview: ${previewUrl}\n`);
  return previewUrl;
}

// ---------- COUNTRIES ----------
const COUNTRIES = [
  { code: 'AF', name: 'Afghanistan' }, { code: 'AL', name: 'Albania' },
  { code: 'DZ', name: 'Algeria' }, { code: 'AR', name: 'Argentina' },
  { code: 'AM', name: 'Armenia' }, { code: 'AU', name: 'Australia' },
  { code: 'AT', name: 'Austria' }, { code: 'AZ', name: 'Azerbaijan' },
  { code: 'BH', name: 'Bahrain' }, { code: 'BD', name: 'Bangladesh' },
  { code: 'BY', name: 'Belarus' }, { code: 'BE', name: 'Belgium' },
  { code: 'BO', name: 'Bolivia' }, { code: 'BA', name: 'Bosnia' },
  { code: 'BR', name: 'Brazil' }, { code: 'BG', name: 'Bulgaria' },
  { code: 'KH', name: 'Cambodia' }, { code: 'CM', name: 'Cameroon' },
  { code: 'CA', name: 'Canada' }, { code: 'CL', name: 'Chile' },
  { code: 'CN', name: 'China' }, { code: 'CO', name: 'Colombia' },
  { code: 'CR', name: 'Costa Rica' }, { code: 'HR', name: 'Croatia' },
  { code: 'CU', name: 'Cuba' }, { code: 'CY', name: 'Cyprus' },
  { code: 'CZ', name: 'Czechia' }, { code: 'DK', name: 'Denmark' },
  { code: 'DO', name: 'Dominican Rep' }, { code: 'EC', name: 'Ecuador' },
  { code: 'EG', name: 'Egypt' }, { code: 'SV', name: 'El Salvador' },
  { code: 'EE', name: 'Estonia' }, { code: 'ET', name: 'Ethiopia' },
  { code: 'FI', name: 'Finland' }, { code: 'FR', name: 'France' },
  { code: 'GE', name: 'Georgia' }, { code: 'DE', name: 'Germany' },
  { code: 'GH', name: 'Ghana' }, { code: 'GR', name: 'Greece' },
  { code: 'GT', name: 'Guatemala' }, { code: 'HN', name: 'Honduras' },
  { code: 'HK', name: 'Hong Kong' }, { code: 'HU', name: 'Hungary' },
  { code: 'IS', name: 'Iceland' }, { code: 'IN', name: 'India' },
  { code: 'ID', name: 'Indonesia' }, { code: 'IR', name: 'Iran' },
  { code: 'IQ', name: 'Iraq' }, { code: 'IE', name: 'Ireland' },
  { code: 'IL', name: 'Israel' }, { code: 'IT', name: 'Italy' },
  { code: 'JM', name: 'Jamaica' }, { code: 'JP', name: 'Japan' },
  { code: 'JO', name: 'Jordan' }, { code: 'KZ', name: 'Kazakhstan' },
  { code: 'KE', name: 'Kenya' }, { code: 'KW', name: 'Kuwait' },
  { code: 'KG', name: 'Kyrgyzstan' }, { code: 'LV', name: 'Latvia' },
  { code: 'LB', name: 'Lebanon' }, { code: 'LY', name: 'Libya' },
  { code: 'LT', name: 'Lithuania' }, { code: 'LU', name: 'Luxembourg' },
  { code: 'MY', name: 'Malaysia' }, { code: 'MV', name: 'Maldives' },
  { code: 'MT', name: 'Malta' }, { code: 'MX', name: 'Mexico' },
  { code: 'MD', name: 'Moldova' }, { code: 'MC', name: 'Monaco' },
  { code: 'MN', name: 'Mongolia' }, { code: 'ME', name: 'Montenegro' },
  { code: 'MA', name: 'Morocco' }, { code: 'MM', name: 'Myanmar' },
  { code: 'NP', name: 'Nepal' }, { code: 'NL', name: 'Netherlands' },
  { code: 'NZ', name: 'New Zealand' }, { code: 'NI', name: 'Nicaragua' },
  { code: 'NG', name: 'Nigeria' }, { code: 'KP', name: 'North Korea' },
  { code: 'MK', name: 'North Macedonia' }, { code: 'NO', name: 'Norway' },
  { code: 'OM', name: 'Oman' }, { code: 'PK', name: 'Pakistan' },
  { code: 'PS', name: 'Palestine' }, { code: 'PA', name: 'Panama' },
  { code: 'PY', name: 'Paraguay' }, { code: 'PE', name: 'Peru' },
  { code: 'PH', name: 'Philippines' }, { code: 'PL', name: 'Poland' },
  { code: 'PT', name: 'Portugal' }, { code: 'QA', name: 'Qatar' },
  { code: 'RO', name: 'Romania' }, { code: 'RU', name: 'Russia' },
  { code: 'SA', name: 'Saudi Arabia' }, { code: 'RS', name: 'Serbia' },
  { code: 'SG', name: 'Singapore' }, { code: 'SK', name: 'Slovakia' },
  { code: 'SI', name: 'Slovenia' }, { code: 'ZA', name: 'South Africa' },
  { code: 'KR', name: 'South Korea' }, { code: 'ES', name: 'Spain' },
  { code: 'LK', name: 'Sri Lanka' }, { code: 'SD', name: 'Sudan' },
  { code: 'SE', name: 'Sweden' }, { code: 'CH', name: 'Switzerland' },
  { code: 'SY', name: 'Syria' }, { code: 'TW', name: 'Taiwan' },
  { code: 'TJ', name: 'Tajikistan' }, { code: 'TZ', name: 'Tanzania' },
  { code: 'TH', name: 'Thailand' }, { code: 'TN', name: 'Tunisia' },
  { code: 'TR', name: 'Turkey' }, { code: 'TM', name: 'Turkmenistan' },
  { code: 'UG', name: 'Uganda' }, { code: 'UA', name: 'Ukraine' },
  { code: 'AE', name: 'United Arab Emirates' }, { code: 'GB', name: 'United Kingdom' },
  { code: 'US', name: 'United States' }, { code: 'UY', name: 'Uruguay' },
  { code: 'UZ', name: 'Uzbekistan' }, { code: 'VE', name: 'Venezuela' },
  { code: 'VN', name: 'Vietnam' }, { code: 'YE', name: 'Yemen' },
  { code: 'ZM', name: 'Zambia' }, { code: 'ZW', name: 'Zimbabwe' },
  { code: 'UN', name: 'Unknown / Other' }
];

// ---------- ICE BREAKERS ----------
const ICE_BREAKERS = [
  "What's the most interesting thing that happened to you this week?",
  "If you could travel anywhere tomorrow, where would you go?",
  "What's a hobby you've always wanted to try?",
  "Coffee or tea — and why?",
  "What song are you listening to on repeat right now?",
  "Beach vacation or mountain cabin?",
  "What's the best meal you've ever had?",
  "Do you believe in luck? Why or why not?",
  "If you could have dinner with anyone, dead or alive, who?",
  "What's a small thing that made you smile today?",
  "Early bird or night owl?",
  "What's your go-to comfort movie?",
  "Sunrise or sunset?",
  "If your life had a soundtrack, what's the opening song?",
  "What's something you're proud of that nobody knows?",
  "Cats or dogs — or both?",
  "What's the last thing that made you laugh out loud?",
  "If you could instantly master one skill, what would it be?",
  "What's a book/movie that changed how you think?",
  "What's your favorite thing about the country you're from?"
];

// ---------- AUTH ----------
function signToken(user) {
  return jwt.sign({ id: user.id, username: user.username }, SECRET, { expiresIn: '7d' });
}
function verifyTokenFromReq(req) {
  const t = req.body.token || req.headers.authorization?.replace('Bearer ', '');
  if (!t) throw new Error('No token');
  return jwt.verify(t, SECRET);
}

app.post('/api/register', async (req, res) => {
  const { username, password, email, country, gender, interests, guestId } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Missing fields' });
  if (dbGet('SELECT id FROM users WHERE username = ?', [username]))
    return res.status(400).json({ error: 'Username already taken' });
  if (email && dbGet('SELECT id FROM users WHERE email = ?', [email]))
    return res.status(400).json({ error: 'Email already registered' });

  try {
    const hash = await bcrypt.hash(password, 10);
    const id = uuidv4();
    const verifyToken = uuidv4();
    const verified = email ? 0 : 1;

    dbRun(
      `INSERT INTO users (id, username, email, password, country, gender, interests, verified, verify_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [id, username, email || null, hash, country || 'UN', gender || 'any', interests || '', verified, verifyToken]
    );

    let migratedHistory = [];
    if (guestId) {
      const row = dbGet('SELECT history FROM guest_backups WHERE guest_id = ?', [guestId]);
      if (row && row.history) {
        migratedHistory = JSON.parse(row.history || '[]');
        dbRun('DELETE FROM guest_backups WHERE guest_id = ?', [guestId]);
      }
    }

    let previewUrl = null;
    if (email) {
      try { previewUrl = await sendVerifyEmail(email, verifyToken, username); } catch (e) {}
    }

    const user = { id, username, email: email || '', country: country || 'UN', gender: gender || 'any', interests: interests || '', avatar: '', verified };
    res.json({ token: signToken(user), user, migratedHistory, previewUrl });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Registration failed' });
  }
});

app.get('/api/verify', (req, res) => {
  const { token } = req.query;
  const user = dbGet('SELECT id, username FROM users WHERE verify_token = ?', [token]);
  if (!user) return res.send('<h1>❌ Invalid or expired token</h1>');
  dbRun('UPDATE users SET verified = 1, verify_token = NULL WHERE id = ?', [user.id]);
  res.send(`<h1>✅ Email verified!</h1><p>Welcome ${user.username}. You can close this tab.</p>`);
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;
  const user = dbGet('SELECT * FROM users WHERE username = ? OR email = ?', [username, username]);
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  if (user.banned) return res.status(403).json({ error: 'Account suspended for violating community guidelines.' });
  const ok = await bcrypt.compare(password, user.password);
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  res.json({
    token: signToken(user),
    user: {
      id: user.id,
      username: user.username,
      email: user.email || '',
      country: user.country,
      gender: user.gender || 'any',
      interests: user.interests,
      avatar: user.avatar,
      verified: user.verified
    }
  });
});

app.post('/api/profile', (req, res) => {
  const { country, gender, interests, avatar } = req.body;
  try {
    const { id } = verifyTokenFromReq(req);
    const fields = [], values = [];
    if (country !== undefined) { fields.push('country = ?'); values.push(country); }
    if (gender !== undefined) { fields.push('gender = ?'); values.push(gender); }
    if (interests !== undefined) { fields.push('interests = ?'); values.push(interests); }
    if (avatar !== undefined) { fields.push('avatar = ?'); values.push(avatar); }
    if (fields.length) {
      values.push(id);
      dbRun(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, values);
    }
    const user = dbGet('SELECT id, username, email, country, gender, interests, avatar, verified FROM users WHERE id = ?', [id]);
    res.json({ user });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

app.post('/api/upload-avatar', upload.single('avatar'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: '/uploads/' + req.file.filename });
});

app.post('/api/upload-media', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json({ url: '/uploads/' + req.file.filename, type: req.file.mimetype });
});

app.get('/api/guest/:guestId/backup', (req, res) => {
  const row = dbGet('SELECT history FROM guest_backups WHERE guest_id = ?', [req.params.guestId]);
  res.json({ history: row && row.history ? JSON.parse(row.history) : [] });
});

app.get('/api/countries', (req, res) => res.json(COUNTRIES));
app.get('/api/icebreakers', (req, res) => res.json(ICE_BREAKERS));

// ---------- FRIENDS ----------
app.get('/api/friends', (req, res) => {
  try {
    const { id } = verifyTokenFromReq(req);
    const rows = dbAll(`
      SELECT u.id, u.username, u.country, u.gender, u.avatar
      FROM friends f
      JOIN users u ON u.id = f.friend_id
      WHERE f.user_id = ?
      ORDER BY f.created_at DESC
    `, [id]);
    res.json({ friends: rows });
  } catch { res.status(401).json({ error: 'Auth' }); }
});

app.post('/api/friends/add', (req, res) => {
  const { friendUsername } = req.body;
  try {
    const { id } = verifyTokenFromReq(req);
    const friend = dbGet('SELECT id, username, country, gender, avatar FROM users WHERE username = ?', [friendUsername]);
    if (!friend) return res.status(404).json({ error: 'User not found' });
    if (friend.id === id) return res.status(400).json({ error: 'Cannot add yourself' });
    dbRun('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)', [id, friend.id]);
    dbRun('INSERT OR IGNORE INTO friends (user_id, friend_id) VALUES (?, ?)', [friend.id, id]);
    res.json({ friend });
  } catch { res.status(401).json({ error: 'Auth' }); }
});

app.post('/api/friends/remove', (req, res) => {
  const { friendId } = req.body;
  try {
    const { id } = verifyTokenFromReq(req);
    dbRun('DELETE FROM friends WHERE user_id = ? AND friend_id = ?', [id, friendId]);
    dbRun('DELETE FROM friends WHERE user_id = ? AND friend_id = ?', [friendId, id]);
    res.json({ ok: true });
  } catch { res.status(401).json({ error: 'Auth' }); }
});

// ---------- BLOCKS / REPORTS / MODERATION ----------
app.post('/api/block', (req, res) => {
  const { blockedUsername } = req.body;
  try {
    const { id } = verifyTokenFromReq(req);
    const target = dbGet('SELECT id FROM users WHERE username = ?', [blockedUsername]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    dbRun('INSERT OR IGNORE INTO blocks (user_id, blocked_id) VALUES (?, ?)', [id, target.id]);
    res.json({ ok: true });
  } catch { res.status(401).json({ error: 'Auth' }); }
});

app.get('/api/blocks', (req, res) => {
  try {
    const { id } = verifyTokenFromReq(req);
    const rows = dbAll('SELECT blocked_id FROM blocks WHERE user_id = ?', [id]);
    res.json({ blocked: rows.map(r => r.blocked_id) });
  } catch { res.status(401).json({ error: 'Auth' }); }
});

app.post('/api/report', (req, res) => {
  const { reportedUsername, reason } = req.body;
  try {
    const { id } = verifyTokenFromReq(req);
    const target = dbGet('SELECT id FROM users WHERE username = ?', [reportedUsername]);
    if (!target) return res.status(404).json({ error: 'User not found' });
    dbRun('INSERT INTO reports (id, reporter_id, reported_id, reason) VALUES (?, ?, ?, ?)',
      [uuidv4(), id, target.id, reason || '']);

    // Auto-ban: if reported by 3+ different users, ban them
    const reportCount = dbGet(
      'SELECT COUNT(DISTINCT reporter_id) as c FROM reports WHERE reported_id = ?',
      [target.id]
    );
    if (reportCount && reportCount.c >= 3) {
      dbRun('UPDATE users SET banned = 1 WHERE id = ?', [target.id]);
      console.log(`🚫 Auto-banned user ${reportedUsername} after ${reportCount.c} reports`);
    }

    res.json({ ok: true, autoBanned: reportCount && reportCount.c >= 3 });
  } catch { res.status(401).json({ error: 'Auth' }); }
});

// ---------- SOCKET.IO + MATCHING ----------
const waitingQueue = [];
const activeRooms = new Map();
const socketUsers = new Map();

function getPartnerSocket(roomId, myId) {
  const room = io.sockets.adapter.rooms.get(roomId);
  if (!room) return null;
  for (const sid of room) if (sid !== myId) return io.sockets.sockets.get(sid);
  return null;
}
function isBlocked(a, b) {
  if (!a || !b) return false;
  return !!dbGet('SELECT 1 FROM blocks WHERE user_id = ? AND blocked_id = ?', [a, b]);
}
function broadcastOnlineCount() {
  io.emit('online-count', { count: io.sockets.sockets.size });
}

function filterMatch(socket, cand) {
  // Gender filter (either side 'any' = accept)
  const myWant = socket.wantGender || 'any';
  const theirWant = cand.socket.wantGender || 'any';
  const myGender = socket.gender || 'any';
  const theirGender = cand.socket.gender || 'any';

  if (myWant !== 'any' && theirGender !== 'any' && myWant !== theirGender) return false;
  if (theirWant !== 'any' && myGender !== 'any' && theirWant !== myGender) return false;

  // Country filter
  const myWantCountry = socket.wantCountry || 'any';
  const theirWantCountry = cand.socket.wantCountry || 'any';
  const myCountry = socket.country || 'UN';
  const theirCountry = cand.socket.country || 'UN';

  if (myWantCountry !== 'any' && theirCountry !== myWantCountry) return false;
  if (theirWantCountry !== 'any' && myCountry !== theirWantCountry) return false;

  // Block check
  if (socket.userId && cand.socket.userId) {
    if (isBlocked(socket.userId, cand.socket.userId)) return false;
    if (isBlocked(cand.socket.userId, socket.userId)) return false;
  }

  return true;
}

function interestScore(socket, cand) {
  const a = socket.interests || new Set();
  const b = cand.interests || new Set();
  let overlap = 0;
  for (const i of a) if (b.has(i)) overlap++;
  return overlap;
}

function tryMatch(socket) {
  // Get all eligible candidates
  const candidates = [];
  for (let i = 0; i < waitingQueue.length; i++) {
    const cand = waitingQueue[i];
    if (cand.socket.id === socket.id) continue;
    if (!cand.socket.connected) { waitingQueue.splice(i, 1); i--; continue; }
    if (!filterMatch(socket, cand)) continue;
    candidates.push({ idx: i, cand, score: interestScore(socket, cand) });
  }

  if (candidates.length === 0) {
    waitingQueue.push({
      socket,
      interests: socket.interests || new Set()
    });
    socket.emit('waiting');
    return;
  }

  // Pick highest interest overlap
  candidates.sort((a, b) => b.score - a.score);
  const chosen = candidates[0];
  const partner = chosen.cand.socket;
  waitingQueue.splice(chosen.idx, 1);

  const roomId = uuidv4();
  socket.join(roomId);
  partner.join(roomId);
  activeRooms.set(socket.id, roomId);
  activeRooms.set(partner.id, roomId);

  const payload = (other) => ({
    roomId,
    partner: {
      name: other.displayName,
      userId: other.userId || '',
      country: other.country || 'UN',
      gender: other.gender || 'any',
      avatar: other.avatar || '',
      interests: other.interestsArr || []
    }
  });

  socket.emit('chat-start', payload(partner));
  partner.emit('chat-start', payload(socket));
}

io.on('connection', (socket) => {
  broadcastOnlineCount();

  socket.on('find-partner', ({ displayName, userId, country, gender, avatar, interests, wantGender, wantCountry }) => {
    socket.displayName = displayName || 'Stranger';
    socket.userId = userId || '';
    socket.country = country || 'UN';
    socket.gender = gender || 'any';
    socket.avatar = avatar || '';
    socket.interestsArr = Array.isArray(interests) ? interests : [];
    socket.interests = new Set(socket.interestsArr);
    socket.wantGender = wantGender || 'any';
    socket.wantCountry = wantCountry || 'any';
    socketUsers.set(socket.id, socket.userId);
    tryMatch(socket);
  });

  socket.on('typing', ({ isTyping }) => {
    const roomId = activeRooms.get(socket.id);
    if (!roomId) return;
    const partner = getPartnerSocket(roomId, socket.id);
    if (partner) partner.emit('partner-typing', { isTyping });
  });

  socket.on('message', ({ text, image, audio }) => {
    const roomId = activeRooms.get(socket.id);
    if (!roomId) return;
    if (!text && !image && !audio) return;
    const msg = {
      id: uuidv4(),
      sender: 'me',
      text: text || '',
      image: image || '',
      audio: audio || '',
      time: new Date().toISOString()
    };
    dbRun(
      'INSERT INTO messages (id, room_id, sender_id, sender_name, text, image, audio) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [msg.id, roomId, socket.id, socket.displayName, msg.text, msg.image, msg.audio]
    );
    socket.emit('message', msg);
    const partner = getPartnerSocket(roomId, socket.id);
    if (partner) partner.emit('message', { ...msg, sender: 'them' });
  });

  // ---------- VIDEO SIGNALING (WebRTC) ----------
  socket.on('video-offer', ({ offer }) => {
    const roomId = activeRooms.get(socket.id);
    if (!roomId) return;
    const partner = getPartnerSocket(roomId, socket.id);
    if (partner) partner.emit('video-offer', { offer });
  });

  socket.on('video-answer', ({ answer }) => {
    const roomId = activeRooms.get(socket.id);
    if (!roomId) return;
    const partner = getPartnerSocket(roomId, socket.id);
    if (partner) partner.emit('video-answer', { answer });
  });

  socket.on('video-ice', ({ candidate }) => {
    const roomId = activeRooms.get(socket.id);
    if (!roomId) return;
    const partner = getPartnerSocket(roomId, socket.id);
    if (partner) partner.emit('video-ice', { candidate });
  });

  socket.on('video-toggle', ({ enabled }) => {
    const roomId = activeRooms.get(socket.id);
    if (!roomId) return;
    const partner = getPartnerSocket(roomId, socket.id);
    if (partner) partner.emit('video-toggle', { enabled });
  });

  socket.on('save-guest-backup', ({ guestId, history }) => {
    if (!guestId) return;
    const existing = dbGet('SELECT guest_id FROM guest_backups WHERE guest_id = ?', [guestId]);
    if (existing) {
      dbRun('UPDATE guest_backups SET history = ?, updated_at = CURRENT_TIMESTAMP WHERE guest_id = ?',
        [JSON.stringify(history), guestId]);
    } else {
      dbRun('INSERT INTO guest_backups (guest_id, history) VALUES (?, ?)',
        [guestId, JSON.stringify(history)]);
    }
  });

  socket.on('next', () => disconnectFromRoom(socket));
  socket.on('disconnect', () => {
    disconnectFromRoom(socket);
    const idx = waitingQueue.findIndex(w => w.socket.id === socket.id);
    if (idx !== -1) waitingQueue.splice(idx, 1);
    socketUsers.delete(socket.id);
    broadcastOnlineCount();
  });
});

function disconnectFromRoom(socket) {
  const roomId = activeRooms.get(socket.id);
  if (!roomId) return;
  socket.leave(roomId);
  activeRooms.delete(socket.id);
  const room = io.sockets.adapter.rooms.get(roomId);
  if (room) {
    for (const sid of [...room]) {
      const s = io.sockets.sockets.get(sid);
      if (s) {
        s.emit('partner-left');
        activeRooms.delete(sid);
        s.leave(roomId);
      }
    }
  }
}

// ---------- START ----------
const PORT = process.env.PORT || 3000;
(async () => {
  await initDb();
  await initMailer();
  server.listen(PORT, () => {
    console.log(`✅ Chat With Strangers running at http://localhost:${PORT}`);
  });
})();