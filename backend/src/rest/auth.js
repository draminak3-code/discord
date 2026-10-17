// =============================================================================
// REST: authentication & users (stateless HTTP ops — the "heart" of state mgmt)
// POST /api/auth/register | POST /api/auth/login | GET/PATCH /api/users/@me
// =============================================================================
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { db, seed } from '../db/index.js';
import { ensureDemoMembership } from './guilds.js';
import { snowflake } from '../lib/snowflake.js';
import { signJwt } from '../lib/jwt.js';

export const authRouter = Router();

const publicUser = (u) => ({
  id: u.id, username: u.username, discriminator: u.discriminator,
  avatar: u.avatar_hash, status: u.status, bot: u.bot,
});

authRouter.post('/register', async (req, res) => {
  const { username, email, password } = req.body || {};
  if (!username || !password || password.length < 6)
    return res.status(400).json({ code: 50035, message: 'Invalid form inputs' });
  if ([...db.tables.users.values()].some((u) => u.username === username))
    return res.status(409).json({ code: 40002, message: 'Username already taken' });

  const user = {
    id: snowflake(), username, discriminator: String(Math.floor(1000 + Math.random() * 9000)),
    email: email || null, password_hash: await bcrypt.hash(password, 10),
    avatar_hash: null, status: 'online', bot: false, created_at: Date.now(),
  };
  db.tables.users.set(user.id, user);
  ensureDemoMembership(user.id);
  const token = signJwt({ uid: user.id, username: user.username });
  res.status(201).json({ token, user: publicUser(user) });
});

authRouter.post('/login', async (req, res) => {
  const { username, password } = req.body || {};
  const user = [...db.tables.users.values()].find((u) => u.username === username);
  if (!user || !(await bcrypt.compare(password || '', user.password_hash)))
    return res.status(401).json({ code: 40001, message: 'Invalid credentials' }); // generic on purpose
  user.status = 'online';
  ensureDemoMembership(user.id);
  const token = signJwt({ uid: user.id, username: user.username });
  res.json({ token, user: publicUser(user) });
});

// ---------------------------------------------------------------------------
export const usersRouter = Router();

usersRouter.get('/@me', (req, res) => {
  const u = db.byId('users', req.user.uid);
  if (!u) return res.status(404).json({ message: 'Unknown User' });
  res.json(publicUser(u));
});

usersRouter.patch('/@me', (req, res) => {
  const u = db.byId('users', req.user.uid);
  if (!u) return res.status(404).json({ message: 'Unknown User' });
  if (req.body.username) u.username = String(req.body.username).slice(0, 32);
  if (typeof req.body.avatar !== 'undefined') u.avatar_hash = req.body.avatar; // hash/URL in production
  res.json(publicUser(u));
});

usersRouter.get('/:id', (req, res) => {
  const u = db.byId('users', req.params.id);
  if (!u) return res.status(404).json({ code: 10013, message: 'Unknown User' });
  res.json(publicUser(u));
});

// Friends management (REST — non-realtime relationship ops)
usersRouter.get('/@me/friends', (req, res) => {
  const rows = db.tables.friendships.filter(
    (f) => f.user_id === req.user.uid && f.status === 'accepted');
  res.json(rows.map((f) => publicUser(db.byId('users', f.friend_id))).filter(Boolean));
});

usersRouter.post('/@me/friends/:friendId', (req, res) => {
  const target = db.byId('users', req.params.friendId);
  if (!target) return res.status(404).json({ code: 10013, message: 'Unknown User' });
  db.tables.friendships.push({
    user_id: req.user.uid, friend_id: target.id, status: 'pending', created_at: Date.now(),
  });
  res.status(201).json(publicUser(target));
});
