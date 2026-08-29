'use strict';

const crypto = require('node:crypto');
const { getDb } = require('./db');
const { config } = require('./config');

const MIN_SEATS = config.plans.group.minSeats; // 3

/**
 * How long an invite code stays valid.
 *
 * Two minutes. A study group code is worth stealing: it grants access to a
 * private chat between named minors and to a leaderboard with their real study
 * data on it. A permanent six-character code that lives in the UI forever is
 * one screenshot away from being public, and screenshots of a group chat get
 * passed around a school constantly.
 *
 * A short window means the code has to be generated at the moment it is used,
 * so it is only ever valid while the owner is actually looking at the screen
 * and intending to invite someone.
 *
 * The cost is real: two minutes is not long enough to text a code to somebody
 * who is not with you. That is why the UI shows a countdown and a one-tap
 * regenerate button rather than hiding the expiry.
 */
const INVITE_TTL_MS = 2 * 60 * 1000;

function inviteExpiry(now = Date.now()) {
  return new Date(now + INVITE_TTL_MS).toISOString();
}

/** A NULL expiry counts as expired, which is how pre-existing codes are retired. */
function inviteIsValid(group, now = Date.now()) {
  if (!group || !group.invite_expires_at) return false;
  const at = Date.parse(group.invite_expires_at);
  return Number.isFinite(at) && at > now;
}

class GroupError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'GroupError';
    this.statusCode = statusCode;
  }
}

function generateInviteCode() {
  // Unambiguous alphabet: no 0/O or 1/I, so codes are easy to read aloud.
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(6);
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

function createGroup(ownerId, name) {
  const db = getDb();
  const trimmed = String(name || '').trim();
  if (!trimmed) throw new GroupError('Give your group a name.');
  if (trimmed.length > 50) throw new GroupError('Group name is too long.');

  const existing = db.prepare(`
    SELECT g.id FROM study_groups g
    JOIN group_members m ON m.group_id = g.id
    WHERE m.user_id = ?
  `).get(ownerId);
  if (existing) throw new GroupError('You are already in a study group. Leave it before starting a new one.');

  let code;
  for (let i = 0; i < 10; i++) {
    code = generateInviteCode();
    if (!db.prepare('SELECT id FROM study_groups WHERE invite_code = ?').get(code)) break;
  }

  const now = new Date().toISOString();
  const result = db.prepare(`
    INSERT INTO study_groups (name, invite_code, invite_expires_at, owner_id, seats_paid, active, created_at)
    VALUES (?, ?, ?, ?, 0, 0, ?)
  `).run(trimmed, code, inviteExpiry(), ownerId, now);

  const groupId = Number(result.lastInsertRowid);
  db.prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)')
    .run(groupId, ownerId, now);

  return getGroup(groupId);
}

/**
 * Mint a fresh invite code for the caller's group.
 *
 * Any member can invite, not just the owner, because that is how study groups
 * actually work. The old code stops working the instant this runs, so a code
 * that was shared too widely can be revoked by pressing the button again.
 */
function refreshInviteCode(userId) {
  const db = getDb();
  const membership = db.prepare('SELECT group_id FROM group_members WHERE user_id = ?').get(userId);
  if (!membership) throw new GroupError('You are not in a study group.', 404);

  let code;
  for (let i = 0; i < 10; i++) {
    code = generateInviteCode();
    if (!db.prepare('SELECT id FROM study_groups WHERE invite_code = ?').get(code)) break;
  }

  const expiresAt = inviteExpiry();
  db.prepare('UPDATE study_groups SET invite_code = ?, invite_expires_at = ? WHERE id = ?')
    .run(code, expiresAt, membership.group_id);

  return { inviteCode: code, inviteExpiresAt: expiresAt, expiresInMs: INVITE_TTL_MS };
}

function joinGroup(userId, inviteCode) {
  const db = getDb();
  const code = String(inviteCode || '').trim().toUpperCase();
  const group = db.prepare('SELECT * FROM study_groups WHERE invite_code = ?').get(code);
  if (!group) throw new GroupError('No group found with that invite code.', 404);

  const already = db.prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(group.id, userId);
  if (already) return getGroup(group.id);

  // Checked after the "already a member" case on purpose: someone who is
  // already in the group re-entering a stale code should not be told off.
  //
  // The message deliberately does not say whether the code was ever real. An
  // attacker guessing codes learns nothing from the difference between "wrong"
  // and "expired", and telling them a guess was briefly correct is exactly the
  // hint that makes guessing worth continuing.
  if (!inviteIsValid(group)) {
    throw new GroupError(
      'That invite code has expired. Codes last two minutes, so ask for a fresh one.',
      410
    );
  }

  const inOther = db.prepare('SELECT 1 FROM group_members WHERE user_id = ?').get(userId);
  if (inOther) throw new GroupError('You are already in a study group. Leave it first.');

  db.prepare('INSERT INTO group_members (group_id, user_id, joined_at) VALUES (?, ?, ?)')
    .run(group.id, userId, new Date().toISOString());

  return getGroup(group.id);
}

function leaveGroup(userId) {
  const db = getDb();
  const membership = db.prepare('SELECT * FROM group_members WHERE user_id = ?').get(userId);
  if (!membership) throw new GroupError('You are not in a study group.', 404);

  db.prepare('DELETE FROM group_members WHERE user_id = ?').run(userId);

  const remaining = memberCount(membership.group_id);
  if (remaining === 0) {
    db.prepare('DELETE FROM study_groups WHERE id = ?').run(membership.group_id);
    return { deleted: true };
  }

  // If the group drops below the paid seat count, it can no longer be active.
  const group = db.prepare('SELECT * FROM study_groups WHERE id = ?').get(membership.group_id);
  if (group && remaining < Math.max(MIN_SEATS, group.seats_paid)) {
    db.prepare('UPDATE study_groups SET active = 0 WHERE id = ?').run(group.id);
  }
  return { deleted: false };
}

function memberCount(groupId) {
  const row = getDb().prepare('SELECT COUNT(*) AS n FROM group_members WHERE group_id = ?').get(groupId);
  return row ? row.n : 0;
}

function getGroup(groupId) {
  const db = getDb();
  const group = db.prepare('SELECT * FROM study_groups WHERE id = ?').get(groupId);
  if (!group) return null;

  const members = db.prepare(`
    SELECT u.id, u.display_name, m.joined_at
    FROM group_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.group_id = ?
    ORDER BY m.joined_at ASC
  `).all(groupId);

  const codeLive = inviteIsValid(group);
  return {
    id: group.id,
    name: group.name,
    // Never hand out a dead code. Returning it and letting the client decide
    // whether to show it would mean the expired code is still sitting in the
    // JSON, and "not rendered" is not the same as "not disclosed".
    inviteCode: codeLive ? group.invite_code : null,
    inviteExpiresAt: codeLive ? group.invite_expires_at : null,
    inviteTtlMs: INVITE_TTL_MS,
    ownerId: group.owner_id,
    seatsPaid: group.seats_paid,
    active: Boolean(group.active),
    memberCount: members.length,
    minSeats: MIN_SEATS,
    seatsNeededToActivate: Math.max(0, MIN_SEATS - members.length),
    members,
    createdAt: group.created_at,
  };
}

function getGroupForUser(userId) {
  const row = getDb().prepare('SELECT group_id FROM group_members WHERE user_id = ?').get(userId);
  return row ? getGroup(row.group_id) : null;
}

/**
 * A group can only be paid for once it has at least MIN_SEATS members.
 * This is enforced here, not just in the UI.
 */
function assertCanActivate(groupId) {
  const count = memberCount(groupId);
  if (count < MIN_SEATS) {
    throw new GroupError(
      `Study Group needs at least ${MIN_SEATS} members before it can be activated. You have ${count}.`,
      400
    );
  }
  return count;
}

function activateGroup(groupId, seatsPaid) {
  const db = getDb();
  const count = assertCanActivate(groupId);
  const seats = Math.max(seatsPaid || count, MIN_SEATS);
  db.prepare('UPDATE study_groups SET active = 1, seats_paid = ? WHERE id = ?').run(seats, groupId);
  return getGroup(groupId);
}

function deactivateGroup(groupId) {
  getDb().prepare('UPDATE study_groups SET active = 0 WHERE id = ?').run(groupId);
  return getGroup(groupId);
}

/**
 * Leaderboard ranked by improvement, not raw score.
 *
 * This is deliberate. Ranking by accuracy would just tell the strongest student
 * they're the strongest and everyone else that they're behind, which is exactly
 * the dynamic that makes people quit. Ranking by ability gained over the window
 * means a student climbing from 40% to 65% outranks one coasting at 90%.
 */
function leaderboard(groupId, windowDays = 7) {
  const db = getDb();
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000).toISOString();

  const members = db.prepare(`
    SELECT u.id, u.display_name
    FROM group_members m
    JOIN users u ON u.id = m.user_id
    WHERE m.group_id = ?
  `).all(groupId);

  const rows = members.map((member) => {
    const stats = db.prepare(`
      SELECT COUNT(*) AS answered, COALESCE(SUM(correct), 0) AS correct
      FROM attempts WHERE user_id = ? AND answered_at >= ?
    `).get(member.id, since);

    const topicsImproved = db.prepare(`
      SELECT COUNT(*) AS n FROM topic_state
      WHERE user_id = ? AND attempts >= 3 AND ewma_correct >= 0.85
    `).get(member.id);

    const answered = stats.answered || 0;
    const correct = stats.correct || 0;
    const accuracy = answered === 0 ? 0 : correct / answered;

    // Improvement score: volume matters, accuracy matters, mastered topics matter.
    // Volume is square-rooted so grinding alone can't dominate the board.
    const score = Math.round(Math.sqrt(answered) * 10 * (0.5 + accuracy) + (topicsImproved.n || 0) * 5);

    return {
      userId: member.id,
      displayName: member.display_name,
      answered,
      correct,
      accuracyPercent: answered === 0 ? null : Math.round(accuracy * 100),
      topicsMastered: topicsImproved.n || 0,
      score,
    };
  });

  return rows
    .sort((a, b) => b.score - a.score || b.answered - a.answered)
    .map((row, i) => ({ ...row, rank: i + 1 }));
}

module.exports = {
  createGroup,
  joinGroup,
  leaveGroup,
  getGroup,
  getGroupForUser,
  activateGroup,
  deactivateGroup,
  assertCanActivate,
  leaderboard,
  memberCount,
  generateInviteCode,
  refreshInviteCode,
  inviteIsValid,
  INVITE_TTL_MS,
  GroupError,
  MIN_SEATS,
};
