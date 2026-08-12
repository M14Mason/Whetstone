'use strict';

/**
 * Group chat, custom study sets, and bug reports.
 *
 * Chat channels are derived, not configured: a group gets #general plus one
 * room for every course that two or more of its members share. That is the
 * feature nobody else has bolted onto a study app, and it only works because
 * the app already knows which courses each student is enrolled in.
 */

const { getDb } = require('./db');
const courses = require('./courses');
const groups = require('./groups');

const MAX_MESSAGE = 1000;
const MAX_SET_TITLE = 80;
const MAX_CARDS_PER_SET = 200;

class SocialError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'SocialError';
    this.statusCode = statusCode;
  }
}

function assertMember(groupId, userId) {
  const row = getDb()
    .prepare('SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ?')
    .get(groupId, userId);
  if (!row) throw new SocialError('You are not a member of this group.', 403);
}

// ------------------------------------------------------------------ channels

/**
 * Channels for a group: #general, plus a room per course shared by 2+ members.
 * A private channel for a class only one person takes would just be a diary.
 */
function channelsFor(groupId) {
  const db = getDb();
  const members = db
    .prepare('SELECT user_id FROM group_members WHERE group_id = ?')
    .all(groupId)
    .map((r) => r.user_id);

  const counts = new Map();
  for (const userId of members) {
    const enrolled = db
      .prepare('SELECT course_id FROM user_courses WHERE user_id = ?')
      .all(userId)
      .map((r) => r.course_id);
    for (const id of new Set(enrolled)) counts.set(id, (counts.get(id) || 0) + 1);
  }

  const shared = [...counts.entries()]
    .filter(([, n]) => n >= 2)
    .map(([courseId, n]) => {
      const course = courses.getCourse(courseId);
      return course ? { id: courseId, name: course.name, members: n } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.members - a.members || a.name.localeCompare(b.name));

  const unread = db.prepare(
    'SELECT channel, COUNT(*) AS n FROM group_messages WHERE group_id = ? GROUP BY channel'
  ).all(groupId);
  const countByChannel = new Map(unread.map((r) => [r.channel, r.n]));

  return [
    { id: 'general', name: 'General', members: members.length, messages: countByChannel.get('general') || 0 },
    ...shared.map((c) => ({ ...c, messages: countByChannel.get(c.id) || 0 })),
  ];
}

function validChannel(groupId, channel) {
  return channelsFor(groupId).some((c) => c.id === channel);
}

// ------------------------------------------------------------------ messages

function postMessage(groupId, userId, channel, body) {
  assertMember(groupId, userId);
  const text = String(body || '').trim();
  if (!text) throw new SocialError('Message cannot be empty.');
  if (text.length > MAX_MESSAGE) throw new SocialError(`Keep messages under ${MAX_MESSAGE} characters.`);
  if (!validChannel(groupId, channel)) throw new SocialError('That channel does not exist for this group.', 404);

  const now = new Date().toISOString();
  const result = getDb().prepare(
    'INSERT INTO group_messages (group_id, user_id, channel, body, created_at) VALUES (?, ?, ?, ?, ?)'
  ).run(groupId, userId, channel, text, now);

  return { id: Number(result.lastInsertRowid), body: text, createdAt: now };
}

/** Messages oldest-first. `since` supports cheap polling for new messages. */
function getMessages(groupId, userId, channel, { since = 0, limit = 100 } = {}) {
  assertMember(groupId, userId);
  return getDb().prepare(`
    SELECT m.id, m.body, m.created_at, m.user_id, u.display_name
    FROM group_messages m
    JOIN users u ON u.id = m.user_id
    WHERE m.group_id = ? AND m.channel = ? AND m.id > ?
    ORDER BY m.id ASC
    LIMIT ?
  `).all(groupId, channel, Number(since) || 0, limit)
    .map((r) => ({
      id: r.id,
      body: r.body,
      createdAt: r.created_at,
      userId: r.user_id,
      displayName: r.display_name,
      mine: r.user_id === userId,
    }));
}

function deleteMessage(messageId, userId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM group_messages WHERE id = ?').get(messageId);
  if (!row) throw new SocialError('Message not found.', 404);

  const group = groups.getGroup(row.group_id);
  const isOwner = group && group.ownerId === userId;
  if (row.user_id !== userId && !isOwner) {
    throw new SocialError('You can only delete your own messages.', 403);
  }
  db.prepare('DELETE FROM group_messages WHERE id = ?').run(messageId);
  return { deleted: true };
}

// ---------------------------------------------------------------- custom sets

function createSet(userId, { title, courseId = null, cards = [] }) {
  const name = String(title || '').trim();
  if (!name) throw new SocialError('Give your set a title.');
  if (name.length > MAX_SET_TITLE) throw new SocialError('That title is too long.');
  if (courseId && !courses.getCourse(courseId)) throw new SocialError('Unknown course.');

  const db = getDb();
  const now = new Date().toISOString();
  const result = db.prepare(
    'INSERT INTO custom_sets (user_id, title, course_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, name, courseId, now, now);

  const setId = Number(result.lastInsertRowid);
  replaceCards(setId, userId, cards);
  return getSet(setId, userId);
}

function replaceCards(setId, userId, cards) {
  const db = getDb();
  const set = db.prepare('SELECT * FROM custom_sets WHERE id = ?').get(setId);
  if (!set) throw new SocialError('Set not found.', 404);
  if (set.user_id !== userId) throw new SocialError('That is not your set.', 403);

  const clean = (cards || [])
    .map((c) => ({ front: String(c.front || '').trim(), back: String(c.back || '').trim() }))
    .filter((c) => c.front && c.back)
    .slice(0, MAX_CARDS_PER_SET);

  db.prepare('DELETE FROM custom_cards WHERE set_id = ?').run(setId);
  const insert = db.prepare('INSERT INTO custom_cards (set_id, front, back, position) VALUES (?, ?, ?, ?)');
  clean.forEach((c, i) => insert.run(setId, c.front, c.back, i));
  db.prepare('UPDATE custom_sets SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), setId);

  return clean.length;
}

function getSet(setId, userId) {
  const db = getDb();
  const set = db.prepare('SELECT * FROM custom_sets WHERE id = ?').get(setId);
  if (!set) return null;
  if (set.user_id !== userId && !set.shared) return null;

  const cards = db
    .prepare('SELECT id, front, back FROM custom_cards WHERE set_id = ? ORDER BY position')
    .all(setId);
  const course = set.course_id ? courses.getCourse(set.course_id) : null;

  return {
    id: set.id,
    title: set.title,
    courseId: set.course_id,
    courseName: course ? course.name : null,
    shared: Boolean(set.shared),
    cardCount: cards.length,
    cards,
    mine: set.user_id === userId,
    updatedAt: set.updated_at,
  };
}

function listSets(userId) {
  return getDb().prepare(`
    SELECT s.*, (SELECT COUNT(*) FROM custom_cards WHERE set_id = s.id) AS card_count
    FROM custom_sets s WHERE s.user_id = ? ORDER BY s.updated_at DESC
  `).all(userId).map((s) => {
    const course = s.course_id ? courses.getCourse(s.course_id) : null;
    return {
      id: s.id,
      title: s.title,
      courseId: s.course_id,
      courseName: course ? course.name : null,
      shared: Boolean(s.shared),
      cardCount: s.card_count,
      updatedAt: s.updated_at,
    };
  });
}

function deleteSet(setId, userId) {
  const db = getDb();
  const set = db.prepare('SELECT * FROM custom_sets WHERE id = ?').get(setId);
  if (!set) throw new SocialError('Set not found.', 404);
  if (set.user_id !== userId) throw new SocialError('That is not your set.', 403);
  db.prepare('DELETE FROM custom_sets WHERE id = ?').run(setId);
  return { deleted: true };
}

// --------------------------------------------------------------- bug reports

function fileBug(userId, { title, body, page, userAgent, appVersion }) {
  const t = String(title || '').trim();
  const b = String(body || '').trim();
  if (!t) throw new SocialError('Give the bug a short title.');
  if (!b) throw new SocialError('Describe what happened.');

  const result = getDb().prepare(`
    INSERT INTO bug_reports (user_id, title, body, page, user_agent, app_version, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId || null, t.slice(0, 140), b.slice(0, 4000),
    String(page || '').slice(0, 200), String(userAgent || '').slice(0, 300),
    String(appVersion || '').slice(0, 40), new Date().toISOString()
  );
  return { id: Number(result.lastInsertRowid) };
}

function listBugs({ status = null, limit = 200 } = {}) {
  const db = getDb();
  const rows = status
    ? db.prepare('SELECT * FROM bug_reports WHERE status = ? ORDER BY id DESC LIMIT ?').all(status, limit)
    : db.prepare('SELECT * FROM bug_reports ORDER BY id DESC LIMIT ?').all(limit);
  return rows.map((r) => ({
    id: r.id, title: r.title, body: r.body, page: r.page,
    userAgent: r.user_agent, appVersion: r.app_version,
    status: r.status, createdAt: r.created_at, userId: r.user_id,
  }));
}

function myBugs(userId, limit = 50) {
  return getDb()
    .prepare('SELECT * FROM bug_reports WHERE user_id = ? ORDER BY id DESC LIMIT ?')
    .all(userId, limit)
    .map((r) => ({ id: r.id, title: r.title, status: r.status, createdAt: r.created_at }));
}

function setBugStatus(id, status) {
  const allowed = ['open', 'fixed', 'wontfix'];
  if (!allowed.includes(status)) throw new SocialError(`Status must be one of: ${allowed.join(', ')}`);
  getDb().prepare('UPDATE bug_reports SET status = ? WHERE id = ?').run(status, id);
  return { id, status };
}

module.exports = {
  channelsFor, postMessage, getMessages, deleteMessage,
  createSet, replaceCards, getSet, listSets, deleteSet,
  fileBug, listBugs, myBugs, setBugStatus,
  SocialError, MAX_MESSAGE, MAX_CARDS_PER_SET,
};
