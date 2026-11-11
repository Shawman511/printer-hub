// Users, sessions and sign-in, persisted in data/auth.json. Passwords are
// stored as scrypt hashes; session tokens only as SHA-256 hashes, so the file
// alone can't be used to sign in.
//
// Roles: admin (everything, including users), operator (control printers and
// files, edit jobs), viewer (watch status, cameras and logs only).
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { EventEmitter } = require('node:events');

const ROLES = ['admin', 'operator', 'viewer'];
const SESSION_DAYS = 30;
const SHORT_SESSION_MS = 12 * 3600 * 1000; // "keep me signed in" off
const USERNAME = /^[a-z0-9._-]{3,32}$/;
const MIN_PASSWORD = 8;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const hashPassword = (password, salt) => new Promise((resolve, reject) => {
  crypto.scrypt(String(password).normalize('NFKC'), salt, 64, SCRYPT, (err, key) => (err ? reject(err) : resolve(key.toString('hex'))));
});

function checkPassword(pw) {
  if (typeof pw !== 'string' || pw.length < MIN_PASSWORD) throw new Error(`Password must be at least ${MIN_PASSWORD} characters`);
  if (pw.length > 200) throw new Error('Password is too long');
}
function checkUsername(name) {
  const u = String(name || '').trim().toLowerCase();
  if (!USERNAME.test(u)) throw new Error('Username must be 3–32 characters: letters, numbers, . _ -');
  return u;
}

class AuthStore extends EventEmitter {
  constructor(dataDir) {
    super();
    this.file = path.join(dataDir, 'auth.json');
    const saved = fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {};
    this.users = saved.users || [];
    this.sessions = saved.sessions || [];
    this.failures = new Map(); // key -> { count, until }
    this.setupCode = null;
    this.prune();
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ users: this.users, sessions: this.sessions }, null, 1), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  // ---- First run --------------------------------------------------------------

  needsSetup() { return this.users.length === 0; }

  // A one-time code printed in the server log, so only someone who can read the
  // log (the person running the hub) can create the first admin.
  issueSetupCode() {
    if (!this.needsSetup()) return null;
    if (!this.setupCode) this.setupCode = crypto.randomBytes(5).toString('hex').toUpperCase().replace(/(.{5})/, '$1-');
    return this.setupCode;
  }

  async setup({ code, username, password }, ip) {
    if (!this.needsSetup()) throw new Error('Setup is already done');
    const keys = [`setup:${ip}`];
    if (this.throttled(keys)) throw Object.assign(new Error('Too many wrong setup codes. Try again in 15 minutes.'), { status: 429 });
    const want = Buffer.from(String(this.setupCode || ''));
    const got = Buffer.from(String(code || '').trim().toUpperCase());
    if (!this.setupCode || want.length !== got.length || !crypto.timingSafeEqual(want, got)) {
      this.fail(keys);
      throw new Error('Wrong setup code. It is printed in the hub\'s log.');
    }
    if (this.settingUp) throw new Error('Setup is already in progress');
    this.settingUp = true;
    try {
      const user = await this.createUser({ username, password, role: 'admin' });
      this.setupCode = null;
      return user;
    } finally {
      this.settingUp = false;
    }
  }

  // ---- Users --------------------------------------------------------------------

  publicUser(u) { return u && { id: u.id, username: u.username, role: u.role, createdAt: u.createdAt, lastLoginAt: u.lastLoginAt || null }; }
  listUsers() { return this.users.map((u) => this.publicUser(u)); }
  getUser(id) { return this.users.find((u) => u.id === id); }

  async createUser({ username, password, role = 'operator' }) {
    const name = checkUsername(username);
    if (this.users.some((u) => u.username === name)) throw new Error('That username is taken');
    if (!ROLES.includes(role)) throw new Error('Unknown role');
    checkPassword(password);
    const salt = crypto.randomBytes(16).toString('hex');
    const user = { id: crypto.randomUUID(), username: name, role, salt, hash: await hashPassword(password, salt), createdAt: Date.now() };
    this.users.push(user);
    this.save();
    return this.publicUser(user);
  }

  admins() { return this.users.filter((u) => u.role === 'admin'); }

  async updateUser(id, { role, password }, actor) {
    const user = this.getUser(id);
    if (!user) throw new Error('Unknown user');
    if (role != null) {
      if (!ROLES.includes(role)) throw new Error('Unknown role');
      if (user.role === 'admin' && role !== 'admin' && this.admins().length === 1) throw new Error('There has to be at least one admin');
      user.role = role;
    }
    if (password != null) {
      checkPassword(password);
      user.salt = crypto.randomBytes(16).toString('hex');
      user.hash = await hashPassword(password, user.salt);
      // A reset signs the user out everywhere (except the admin doing it to themself).
      this.revokeWhere((s) => s.userId === id && s.id !== actor?.sessionId);
    }
    this.save();
    this.emit('change');
    return this.publicUser(user);
  }

  deleteUser(id, actor) {
    const user = this.getUser(id);
    if (!user) throw new Error('Unknown user');
    if (id === actor?.user.id) throw new Error('You can\'t delete your own account');
    if (user.role === 'admin' && this.admins().length === 1) throw new Error('There has to be at least one admin');
    this.users = this.users.filter((u) => u !== user);
    this.revokeWhere((s) => s.userId === id);
    this.save();
  }

  async changeOwnPassword(ctx, current, next) {
    const user = this.getUser(ctx.user.id);
    if (!(await this.verify(user, current))) throw new Error('Current password is wrong');
    checkPassword(next);
    user.salt = crypto.randomBytes(16).toString('hex');
    user.hash = await hashPassword(next, user.salt);
    this.revokeWhere((s) => s.userId === user.id && s.id !== ctx.sessionId);
    this.save();
  }

  async verify(user, password) {
    if (!user || typeof password !== 'string') return false;
    const hash = Buffer.from(await hashPassword(password, user.salt), 'hex');
    return crypto.timingSafeEqual(hash, Buffer.from(user.hash, 'hex'));
  }

  // ---- Sign-in --------------------------------------------------------------------

  // Locks an address out for 15 minutes after 8 wrong passwords. Counting per
  // username as well would let anyone lock a known account out.
  throttled(keys) {
    const now = Date.now();
    return keys.some((k) => { const f = this.failures.get(k); return f && f.until > now; });
  }
  fail(keys) {
    const now = Date.now();
    // Old entries go, so the list can't grow without end.
    for (const [k, f] of this.failures) if (f.until < now && now - f.at > 15 * 60 * 1000) this.failures.delete(k);
    for (const k of keys) {
      const f = this.failures.get(k) || { count: 0, until: 0 };
      f.count++;
      f.at = now;
      if (f.count >= 8) { f.until = now + 15 * 60 * 1000; f.count = 0; }
      this.failures.set(k, f);
    }
  }

  async login({ username, password, remember }, { ip, userAgent }) {
    const name = String(username || '').trim().toLowerCase();
    const keys = [`ip:${ip}`];
    if (this.throttled(keys)) throw Object.assign(new Error('Too many failed sign-ins. Try again in 15 minutes.'), { status: 429 });
    const user = this.users.find((u) => u.username === name);
    // Hash even for unknown users so timing doesn't reveal which usernames exist.
    const ok = user ? await this.verify(user, password) : (await hashPassword(String(password || ''), 'x'), false);
    if (!ok) {
      this.fail(keys);
      throw Object.assign(new Error('Wrong username or password'), { status: 401 });
    }
    for (const k of keys) this.failures.delete(k);
    user.lastLoginAt = Date.now();
    return this.createSession(user, { remember: remember !== false, ip, userAgent });
  }

  createSession(user, { remember, ip, userAgent }) {
    const token = crypto.randomBytes(32).toString('base64url');
    const now = Date.now();
    const ttl = remember ? SESSION_DAYS * 86400 * 1000 : SHORT_SESSION_MS;
    const session = {
      id: crypto.randomUUID(), tokenHash: sha256(token), userId: user.id, remember: !!remember,
      createdAt: now, lastSeen: now, expiresAt: now + ttl, ip, userAgent: String(userAgent || '').slice(0, 200),
    };
    this.sessions.push(session);
    this.save();
    return { token, session, maxAge: remember ? Math.round(ttl / 1000) : null };
  }

  // The signed-in user for a session token, or null. Sliding expiry: use keeps
  // a session alive (saved at most every 10 minutes).
  resolve(token) {
    if (!token) return null;
    const h = sha256(token);
    const s = this.sessions.find((x) => x.tokenHash === h);
    if (!s) return null;
    const now = Date.now();
    if (s.expiresAt < now) { this.revokeWhere((x) => x === s); this.save(); return null; }
    const user = this.getUser(s.userId);
    if (!user) return null;
    if (now - s.lastSeen > 10 * 60 * 1000) {
      s.lastSeen = now;
      s.expiresAt = now + (s.remember ? SESSION_DAYS * 86400 * 1000 : SHORT_SESSION_MS);
      this.save();
    }
    return { user: this.publicUser(user), sessionId: s.id };
  }

  listSessions(userId, currentId) {
    return this.sessions.filter((s) => s.userId === userId).map((s) => ({
      id: s.id, createdAt: s.createdAt, lastSeen: s.lastSeen, ip: s.ip, userAgent: s.userAgent, current: s.id === currentId,
    })).sort((a, b) => b.lastSeen - a.lastSeen);
  }

  revoke(userId, sessionId) {
    const n = this.revokeWhere((s) => s.userId === userId && s.id === sessionId);
    if (!n) throw new Error('Unknown session');
    this.save();
  }

  revokeOthers(ctx) {
    this.revokeWhere((s) => s.userId === ctx.user.id && s.id !== ctx.sessionId);
    this.save();
  }

  logout(ctx) {
    this.revokeWhere((s) => s.id === ctx.sessionId);
    this.save();
  }

  // Removes sessions and tells the server, which closes their live streams.
  revokeWhere(pred) {
    const gone = this.sessions.filter(pred);
    if (!gone.length) return 0;
    this.sessions = this.sessions.filter((s) => !gone.includes(s));
    this.emit('revoked', gone.map((s) => s.id));
    return gone.length;
  }

  prune() {
    const now = Date.now();
    if (this.revokeWhere((s) => s.expiresAt < now || !this.getUser(s.userId))) this.save();
  }
}

// Which roles may make a request. Reads are open to every signed-in user.
function allowed(role, method, pathname) {
  if (role === 'admin') return true;
  // "/api//users" reaches the same route as "/api/users".
  pathname = pathname.replace(/\/{2,}/g, '/');
  if (pathname.startsWith('/api/users') || pathname.startsWith('/api/printer-setup')) return false;
  if (method === 'GET' || method === 'HEAD') return true;
  return role === 'operator';
}

module.exports = { AuthStore, ROLES, allowed };
