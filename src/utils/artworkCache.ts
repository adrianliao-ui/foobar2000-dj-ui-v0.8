// ============================================================================
// [高速雙層封面快取引擎] artworkCache.ts
// 結合「記憶體 Map (0ms 同步讀取)」與「IndexedDB (數百 MB 容量、跨重啟與最小化永久保存)」
// 徹底解決 localStorage 5MB 容量上限導致真實 Base64 封面被截斷、每次最小化開啟都要重新逐條向 C++ 宿主抓取封面的問題
// ============================================================================

const IDB_NAME = 'foobar_dj_artwork_idb_v1';
const IDB_STORE = 'covers';
const IDB_VERSION = 1;

// 記憶體快取：支援以正規化檔案路徑 (pathKey) 或專輯識別碼 (albumKey) 瞬間同步讀取
const memoryCoverCache = new Map<string, string>();
let idbLoadPromise: Promise<void> | null = null;
let idbInstance: IDBDatabase | null = null;

function normalizePathKey(rawPath?: string | null): string {
    if (!rawPath) return '';
    return rawPath.split('|')[0].trim().toLowerCase();
}

function normalizeAlbumKey(artist?: string | null, album?: string | null): string {
    const cleanAlbum = (album ?? '').trim().toLowerCase();
    if (!cleanAlbum || cleanAlbum === 'unknown album' || cleanAlbum === '?') {
        return '';
    }
    const cleanArtist = (artist ?? '').trim().toLowerCase();
    return `album::${cleanArtist}::${cleanAlbum}`;
}

function openArtworkIdb(): Promise<IDBDatabase | null> {
    if (idbInstance) return Promise.resolve(idbInstance);
    if (typeof window === 'undefined' || !window.indexedDB) {
        return Promise.resolve(null);
    }

    return new Promise((resolve) => {
        try {
            const req = window.indexedDB.open(IDB_NAME, IDB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(IDB_STORE)) {
                    db.createObjectStore(IDB_STORE);
                }
            };
            req.onsuccess = () => {
                idbInstance = req.result;
                resolve(idbInstance);
            };
            req.onerror = () => {
                resolve(null);
            };
        } catch {
            resolve(null);
        }
    });
}

/**
 * 啟動時一次性將 IndexedDB 中的所有真實專輯封面載入記憶體 Map
 * 若已在同一個瀏覽器執行緒載入過，直接 0ms 完成
 */
export function ensureArtworkCacheLoaded(): Promise<void> {
    if (idbLoadPromise) return idbLoadPromise;

    idbLoadPromise = (async () => {
        const db = await openArtworkIdb();
        if (!db) return;

        await new Promise<void>((resolve) => {
            try {
                const tx = db.transaction(IDB_STORE, 'readonly');
                const store = tx.objectStore(IDB_STORE);
                const cursorReq = store.openCursor();
                cursorReq.onsuccess = () => {
                    const cursor = cursorReq.result;
                    if (cursor) {
                        const k = String(cursor.key);
                        const v = cursor.value;
                        if (typeof v === 'string' && v.length > 0) {
                            memoryCoverCache.set(k, v);
                        }
                        cursor.continue();
                    } else {
                        resolve();
                    }
                };
                cursorReq.onerror = () => resolve();
            } catch {
                resolve();
            }
        });
    })();

    return idbLoadPromise;
}

/**
 * 同步從記憶體快取取得真實封面（0ms 零延遲）
 */
export function getCachedCoverSync(
    trackPath?: string | null,
    artist?: string | null,
    album?: string | null
): string | undefined {
    const pKey = normalizePathKey(trackPath);
    if (pKey) {
        const byPath = memoryCoverCache.get(pKey);
        if (byPath) return byPath;
    }
    const aKey = normalizeAlbumKey(artist, album);
    if (aKey) {
        const byAlbum = memoryCoverCache.get(aKey);
        if (byAlbum) return byAlbum;
    }
    return undefined;
}

/**
 * 寫入真實封面至記憶體快取並背景非同步持久化至 IndexedDB
 */
export function setCachedCover(
    trackPath: string | undefined | null,
    coverDataUrl: string,
    artist?: string | null,
    album?: string | null
): void {
    if (!coverDataUrl || typeof coverDataUrl !== 'string') return;

    const pKey = normalizePathKey(trackPath);
    const aKey = normalizeAlbumKey(artist, album);

    const entriesToWrite: Array<[string, string]> = [];
    if (pKey && memoryCoverCache.get(pKey) !== coverDataUrl) {
        memoryCoverCache.set(pKey, coverDataUrl);
        entriesToWrite.push([pKey, coverDataUrl]);
    }
    if (aKey && !memoryCoverCache.has(aKey)) {
        memoryCoverCache.set(aKey, coverDataUrl);
        entriesToWrite.push([aKey, coverDataUrl]);
    }

    if (entriesToWrite.length === 0) return;

    void (async () => {
        const db = await openArtworkIdb();
        if (!db) return;
        try {
            const tx = db.transaction(IDB_STORE, 'readwrite');
            const store = tx.objectStore(IDB_STORE);
            for (const [k, v] of entriesToWrite) {
                store.put(v, k);
            }
        } catch {
            // ignore IDB quota/transaction errors
        }
    })();
}
