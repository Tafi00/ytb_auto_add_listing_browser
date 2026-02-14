import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

const DATA_DIR = path.resolve(process.cwd(), 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'history.db'));
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    client_id TEXT NOT NULL,
    product_url TEXT NOT NULL,
    affiliate_url TEXT NOT NULL,
    meta_title TEXT DEFAULT '',
    meta_price TEXT DEFAULT '',
    meta_image TEXT DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  )
`);
db.exec(`CREATE INDEX IF NOT EXISTS idx_history_client ON history(client_id)`);

const insertStmt = db.prepare(`
  INSERT INTO history (client_id, product_url, affiliate_url, meta_title, meta_price, meta_image, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
`);

const selectByClientStmt = db.prepare(`
  SELECT * FROM history WHERE client_id = ? ORDER BY id DESC LIMIT 50
`);

const countAllStmt = db.prepare(`SELECT COUNT(*) as total FROM history`);

export function addHistory(clientId, entry) {
  insertStmt.run(
    clientId,
    entry.productUrl,
    entry.affiliateUrl,
    entry.metadata?.title || '',
    entry.metadata?.price || '',
    entry.metadata?.image || '',
    entry.createdAt || new Date().toISOString()
  );
}

export function getHistory(clientId) {
  return selectByClientStmt.all(clientId).map(row => ({
    productUrl: row.product_url,
    affiliateUrl: row.affiliate_url,
    metadata: { title: row.meta_title, price: row.meta_price, image: row.meta_image },
    createdAt: row.created_at,
  }));
}

export function getTotalLinks() {
  return countAllStmt.get().total;
}

export function clearAllHistory() {
  db.exec('DELETE FROM history');
}
