/**
 * The IndexedDB database the studio's store lives in: every session's
 * branch, and each app database's log beside them. Kept apart from
 * `store.js` so the database worker can name it without loading the
 * world.
 */
export const STORE_DB = "agex-studio";
