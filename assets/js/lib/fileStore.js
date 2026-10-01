// ---------------------------------------------------------------------------
// File storage for teacher uploads.
//
// Uploaded files live in IndexedDB as Blobs, which the browser stores
// efficiently and outside the ~5 MB localStorage quota. When IndexedDB is
// unavailable (old browser, locked-down private mode) the caller can fall
// back to embedding a base64 data URL in the submission record — see
// saveFile()'s options.
//
// Everything is keyed by submission id, so metadata (localStorage) and bytes
// (IndexedDB) stay in sync.
// ---------------------------------------------------------------------------

const DB_NAME = 'schoolcloud-files';
const DB_VERSION = 1;
const STORE = 'files';

let dbPromise = null;

/** True when IndexedDB can be used in this browser. */
export function fileStoreSupported() {
  return typeof globalThis.indexedDB !== 'undefined' && globalThis.indexedDB !== null;
}

function openDatabase() {
  if (!fileStoreSupported()) return Promise.reject(new Error('IndexedDB is unavailable.'));
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = globalThis.indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB could not be opened.'));
    request.onblocked = () => reject(new Error('IndexedDB is blocked by another tab.'));
  });
  // A failed open must not be cached forever.
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

function withStore(mode, run) {
  return openDatabase().then(db => new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    try {
      result = run(store);
    } catch (error) {
      reject(error);
      return;
    }
    tx.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    tx.onerror = () => reject(tx.error || new Error('The file store request failed.'));
    tx.onabort = () => reject(tx.error || new Error('The file store request was aborted.'));
  }));
}

/** Store a Blob (or File) under a submission id. */
export function putFile(id, blob) {
  return withStore('readwrite', store => store.put(blob, id));
}

/** Fetch the stored Blob for a submission id, or null when there is none. */
export async function getFile(id) {
  try {
    const blob = await withStore('readonly', store => store.get(id));
    return blob instanceof Blob ? blob : null;
  } catch {
    return null;
  }
}

/** Remove the stored Blob for a submission id. */
export function deleteFile(id) {
  return withStore('readwrite', store => store.delete(id)).catch(() => undefined);
}

/**
 * Read a File as a base64 data URL (the localStorage fallback).
 * Returns '' when the file cannot be read.
 */
export function readAsDataUrl(file) {
  return new Promise(resolve => {
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ''));
      reader.onerror = () => resolve('');
      reader.readAsDataURL(file);
    } catch {
      resolve('');
    }
  });
}
