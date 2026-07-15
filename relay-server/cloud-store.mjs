import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const GAME_ID_PATTERN = /^[a-f0-9]{64}$/;
const MAX_SAVE_BYTES = 1_500_000;
const MAX_SAVES_PER_GAME = 20;

function normalizeGameId(value) {
  const gameId = String(value || '').toLowerCase();
  if (!GAME_ID_PATTERN.test(gameId)) throw new Error('游戏标识无效');
  return gameId;
}

function normalizeText(value, maxLength) {
  return String(value || '').trim().slice(0, maxLength);
}

export function createCloudStore(dataDir) {
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const databasePath = path.join(dataDir, 'pwa-nes.sqlite3');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS cloud_saves (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      game_id TEXT NOT NULL,
      rom_name TEXT NOT NULL,
      label TEXT NOT NULL,
      state_data TEXT NOT NULL,
      game_frame INTEGER NOT NULL DEFAULT 0,
      device_id TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS cloud_saves_game_created
      ON cloud_saves(game_id, id DESC);
    CREATE TABLE IF NOT EXISTS game_library (
      game_id TEXT PRIMARY KEY,
      rom_name TEXT NOT NULL,
      favorite INTEGER NOT NULL DEFAULT 0,
      play_count INTEGER NOT NULL DEFAULT 0,
      play_seconds INTEGER NOT NULL DEFAULT 0,
      last_played_at TEXT NOT NULL
    );
  `);

  const listStatement = database.prepare(`
    SELECT id, game_id AS gameId, rom_name AS romName, label, game_frame AS gameFrame,
           device_id AS deviceId, created_at AS createdAt, length(state_data) AS encodedBytes
      FROM cloud_saves WHERE game_id = ? ORDER BY id DESC LIMIT ${MAX_SAVES_PER_GAME}
  `);
  const getStatement = database.prepare(`
    SELECT id, game_id AS gameId, rom_name AS romName, label, state_data AS data,
           game_frame AS gameFrame, device_id AS deviceId, created_at AS createdAt
      FROM cloud_saves WHERE id = ?
  `);
  const insertStatement = database.prepare(`
    INSERT INTO cloud_saves(game_id, rom_name, label, state_data, game_frame, device_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  const deleteStatement = database.prepare('DELETE FROM cloud_saves WHERE id = ?');
  const pruneStatement = database.prepare(`
    DELETE FROM cloud_saves WHERE game_id = ? AND id NOT IN (
      SELECT id FROM cloud_saves WHERE game_id = ? ORDER BY id DESC LIMIT ${MAX_SAVES_PER_GAME}
    )
  `);
  const listLibraryStatement = database.prepare(`
    SELECT game_id AS gameId, rom_name AS romName, favorite, play_count AS playCount,
           play_seconds AS playSeconds, last_played_at AS lastPlayedAt
      FROM game_library ORDER BY favorite DESC, last_played_at DESC LIMIT 500
  `);
  const getLibraryStatement = database.prepare(`
    SELECT game_id AS gameId, rom_name AS romName, favorite, play_count AS playCount,
           play_seconds AS playSeconds, last_played_at AS lastPlayedAt
      FROM game_library WHERE game_id = ?
  `);
  const upsertLibraryStatement = database.prepare(`
    INSERT INTO game_library(game_id, rom_name, favorite, play_count, play_seconds, last_played_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(game_id) DO UPDATE SET
      rom_name = excluded.rom_name,
      favorite = excluded.favorite,
      play_count = excluded.play_count,
      play_seconds = excluded.play_seconds,
      last_played_at = excluded.last_played_at
  `);

  return {
    databasePath,
    listSaves(gameId) {
      return listStatement.all(normalizeGameId(gameId));
    },
    getSave(id) {
      return getStatement.get(Math.max(1, Math.floor(Number(id) || 0))) || null;
    },
    createSave(value = {}) {
      const gameId = normalizeGameId(value.gameId);
      const data = String(value.data || '');
      if (!data || data.length > MAX_SAVE_BYTES || !/^[A-Za-z0-9+/=]+$/.test(data)) {
        throw new Error('云存档数据无效或过大');
      }
      const createdAt = new Date().toISOString();
      const result = insertStatement.run(
        gameId,
        normalizeText(value.romName, 240) || 'NES 游戏',
        normalizeText(value.label, 80) || '手动存档',
        data,
        Math.max(0, Math.floor(Number(value.gameFrame) || 0)),
        normalizeText(value.deviceId, 80),
        createdAt,
      );
      pruneStatement.run(gameId, gameId);
      return getStatement.get(Number(result.lastInsertRowid));
    },
    deleteSave(id) {
      return Number(deleteStatement.run(Math.max(1, Math.floor(Number(id) || 0))).changes) > 0;
    },
    listLibrary() {
      return listLibraryStatement.all().map((item) => ({ ...item, favorite: Boolean(item.favorite) }));
    },
    updateLibrary(gameId, value = {}) {
      const normalizedId = normalizeGameId(gameId);
      const current = getLibraryStatement.get(normalizedId);
      const favorite = typeof value.favorite === 'boolean' ? value.favorite : Boolean(current?.favorite);
      const playCount = Math.max(0, Number(current?.playCount) || 0) + (value.incrementPlay ? 1 : 0);
      const playSeconds = Math.max(0, Number(current?.playSeconds) || 0) + Math.max(0, Math.floor(Number(value.addPlaySeconds) || 0));
      upsertLibraryStatement.run(
        normalizedId,
        normalizeText(value.romName, 240) || 'NES 游戏',
        favorite ? 1 : 0,
        playCount,
        playSeconds,
        new Date().toISOString(),
      );
      const result = getLibraryStatement.get(normalizedId);
      return result ? { ...result, favorite: Boolean(result.favorite) } : null;
    },
    close() {
      database.close();
    },
  };
}
