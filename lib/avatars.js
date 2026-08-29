'use strict';

/**
 * The avatar catalogue. One list, used by both sides.
 *
 * This file exists because there used to be two lists. The client rendered
 * sixteen avatars; the server validated against a hardcoded array of eight.
 * Picking any of the eight newer ones returned "Unknown avatar." and the
 * profile silently refused to save, with no clue as to why.
 *
 * That is the classic duplicated-constant bug: both lists were correct when
 * written, and one of them was updated. The fix is not to paste the missing
 * eight ids into the server; it is to delete the second list entirely. The
 * server validates against this array, and the client is handed the same array
 * over /api/me, so there is nothing left to drift.
 *
 * Paths are drawn on a 24x24 grid and rendered as stroked SVG. They are
 * deliberately geometric rather than pictorial: a stroke inherits currentColor,
 * so one definition works on light and dark backgrounds without a second asset,
 * and it stays legible at the 26px the topbar renders it at.
 */

const AVATARS = [
  { id: 'flame',   label: 'Ember',   path: 'M12 2.8c3.4 3.3 5.6 6 5.6 9.2a5.6 5.6 0 11-11.2 0c0-1.7.6-3 1.7-4.4.5 1 1.2 1.7 2 2 .3-2.5.9-4.6 1.9-6.8z' },
  { id: 'leaf',    label: 'Leaf',    path: 'M20 4c0 9-5 14-11 14a5.6 5.6 0 01-5-3C4 8 11 4 20 4zM4.5 20c2-4.5 5-7.5 9-9.5' },
  { id: 'bolt',    label: 'Bolt',    path: 'M13.5 2.5L5 13.2h5.2L9.8 21.5 19 10.4h-5.4z' },
  { id: 'star',    label: 'Star',    path: 'M12 3l2.7 5.6 6.1.85-4.45 4.3 1.06 6.05L12 16.95 6.59 19.8l1.06-6.05L3.2 9.45l6.1-.85z' },
  { id: 'moon',    label: 'Moon',    path: 'M20 14.5A8.5 8.5 0 019.6 4a8.5 8.5 0 1010.4 10.5z' },
  { id: 'wave',    label: 'Wave',    path: 'M2.5 9c2.5-3 4.7-3 7 0s4.5 3 7 0 4.5-3 5-1.5M2.5 16c2.5-3 4.7-3 7 0s4.5 3 7 0 4.5-3 5-1.5' },
  { id: 'peak',    label: 'Peak',    path: 'M2.5 19.5l6-11 4 6.5 3-4.5 6 9z' },
  { id: 'orbit',   label: 'Orbit',   path: 'M12 7.5a4.5 4.5 0 100 9 4.5 4.5 0 000-9zM4.6 7.2c3.4-2 12.4-2.6 15.4.6M19.4 16.8c-3.4 2-12.4 2.6-15.4-.6' },
  { id: 'anchor',  label: 'Anchor',  path: 'M12 7.8v13M12 3a2.4 2.4 0 100 4.8 2.4 2.4 0 000-4.8zM7.5 11.5h9M4 15a8 8 0 0016 0' },
  { id: 'compass', label: 'Compass', path: 'M12 2.8a9.2 9.2 0 100 18.4 9.2 9.2 0 000-18.4zM15.8 8.2l-2 5.6-5.6 2 2-5.6z' },
  { id: 'prism',   label: 'Prism',   path: 'M12 3l9 16H3zM12 3v16M7.5 11h9' },
  { id: 'key',     label: 'Key',     path: 'M15.5 3.5a5.5 5.5 0 100 11 5.5 5.5 0 000-11zM11.6 11.4L3 20v1.2h3.4v-2.4h2.4v-2.4h2.2z' },
  { id: 'feather', label: 'Feather', path: 'M20.5 3.5C13 3.5 7 8 7 15v3l-3.5 3.5M7 18c8 0 12-4.5 12-9.5M10 15h6' },
  { id: 'cog',     label: 'Cog',     path: 'M12 8.4a3.6 3.6 0 100 7.2 3.6 3.6 0 000-7.2zM12 1.8v3M12 19.2v3M22.2 12h-3M5 12H1.8M19.2 4.8l-2.1 2.1M6.9 17.1l-2.1 2.1M19.2 19.2l-2.1-2.1M6.9 6.9L4.8 4.8' },
  { id: 'droplet', label: 'Droplet', path: 'M12 2.6l5.4 7.6a6.6 6.6 0 11-10.8 0z' },
  { id: 'lantern', label: 'Lantern', path: 'M8.5 3h7M12 3v2.5M6.5 5.5h11l-1.5 12a2 2 0 01-2 1.8h-4a2 2 0 01-2-1.8zM12 19.3V22' },
];

const AVATAR_IDS = AVATARS.map((a) => a.id);
const DEFAULT_AVATAR = 'flame';

function isValidAvatar(id) {
  return AVATAR_IDS.includes(String(id));
}

module.exports = { AVATARS, AVATAR_IDS, DEFAULT_AVATAR, isValidAvatar };
