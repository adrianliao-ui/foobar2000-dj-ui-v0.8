import fb from 'foo-webview-sdk';
import type { Track as FbSdkTrack } from 'foo-webview-sdk';
import type { StereoVULevels } from '../types/player';
import type { Track } from '../types/track';
import {
    ensureArtworkCacheLoaded,
    getCachedCoverSync,
    setCachedCover,
} from '../utils/artworkCache';
import { floorDurationToTenth } from '../utils/formatTime';
import neonOdysseyCover from '../assets/images/album_neon_odyssey_1794501495588.jpg';
import undergroundVol2Cover from '../assets/images/album_underground_vol2_1794501496336.jpg';
import prismKinetixCover from '../assets/images/album_prism_kinetix_1794501497646.jpg';
import frostbiteKryoCover from '../assets/images/album_frostbite_kryo_1794501499609.jpg';

/**
 * 擴充全域 Window 型別，支援 WebView2 容器
 * (註：window.fb2k 已由 foo-webview-sdk 內建型別宣告為 NativeFb2k)
 */
interface WebView2Bridge {
    postMessage: (message: string) => void;
    addEventListener?: (
        type: 'message',
        listener: (event: { data: unknown }) => void
    ) => void;
    removeEventListener?: (
        type: 'message',
        listener: (event: { data: unknown }) => void
    ) => void;
    hostObjects?: Record<string, unknown>;
}

declare global {
    interface Window {
        chrome?: {
            webview?: WebView2Bridge;
        };
    }
}

/**
 * 由 foobar2000 C++ 宿主主動推播至前端的事件格式 (Phase 7 & 方向 A 實機對接規格)
 */
export type HostToClientMessage =
    | {
          event: 'HOST_HANDSHAKE_ACK';
          payload: {
              foobarVersion: string;
              componentVersion: string;
              audioDevice: string;
              wsEndpoint?: string;
          };
      }
    | {
          event: 'HOST_AUDIO_METERS';
          payload: {
              vuLevels: StereoVULevels;
              spectrumBins: number[];
          };
      }
    | {
          event: 'HOST_PLAYBACK_STATE';
          payload: {
              isPlaying: boolean;
              trackTimeSeconds?: number;
              hostState?: 'playing' | 'paused' | 'stopped';
          };
      }
    | {
          event: 'HOST_TRACK_CHANGED';
          payload: {
              path: string;
              absolutePath?: string;
              handle?: string;
              title?: string;
              artist?: string;
              album?: string;
              duration?: number;
              position?: number;
              playlistRowIndex?: number | null;
          };
      }
    | {
          event: 'HOST_LIBRARY_UPDATED';
          payload: {
              tracks: Track[];
          };
      }
    | {
          event: 'HOST_WINDOW_STATE_CHANGED';
          payload: {
              isMinimized: boolean;
              isActive: boolean;
          };
      };

/**
 * [修復最小化背景自然切歌後路徑比對失敗]
 * 造成錯誤的原因：foobar2000 的 `playback.getPosition` 回傳路徑帶有 `file://` 或 `file-relative://` 前綴，
 * 且可能帶有 `|subsong:N` 後綴或斜線方向差異 (`/` vs `\`)，導致與佇列內的 `C:\...` 路徑直接 `===` 比對失敗並退回前一首歌。
 * 修改的目的：統一清除協定前綴、subsong 後綴、解碼百分比字元並統一斜線與大小寫，確保跨端點路徑 100% 精準匹配。
 */
export const normalizeAudioPathForMatch = (
    rawPath?: string | null
): string => {
    if (!rawPath || typeof rawPath !== 'string') return '';
    const parts = rawPath.split('|');
    let cleaned = (parts[0] ?? '').trim();
    if (!cleaned) return '';
    cleaned = cleaned.replace(/^file(?:-relative)?:\/{2,3}/i, '');
    try {
        if (cleaned.includes('%')) {
            cleaned = decodeURIComponent(cleaned);
        }
    } catch {
        // 忽略非標準 URI 編碼
    }
    const baseNorm = cleaned.replace(/\//g, '\\').trim().toLowerCase();

    // [修復同卡片 CUE / Subsong 子軌誤判]
    // 錯誤原因：先前無條件以 split('|')[0] 捨棄所有後綴，導致單一音檔 + CUE 的不同曲目（如 |subsong:1 與 |subsong:2）正規化後完全相同，被誤判為同一首歌。
    // 修改目的：當帶有非 0 的子軌編號時統一保留 `|subsong:N` 標記，而預設單軌（無後綴或 subsong 0）則維持純路徑以確保跨端點相容。
    if (parts.length > 1) {
        const subRaw = parts.slice(1).join('|').trim().toLowerCase();
        const subMatch = subRaw.match(/(?:subsong:)?(\d+)/);
        if (subMatch) {
            const subIdx = Number(subMatch[1]);
            if (Number.isFinite(subIdx) && subIdx > 0) {
                return `${baseNorm}|subsong:${subIdx}`;
            }
        }
    }
    return baseNorm;
};

/**
 * 擷取音檔路徑的純檔名（不含路徑與副檔名），作為相對路徑與絕對路徑比對時的第二層安全備援
 */
export const extractFilenameStemForMatch = (
    rawPath?: string | null
): string => {
    const norm = normalizeAudioPathForMatch(rawPath).split('|')[0] ?? '';
    if (!norm) return '';
    const segments = norm.split('\\').filter(Boolean);
    const fileName = segments[segments.length - 1] ?? '';
    return fileName.replace(/\.[^.]+$/, '').trim();
};

/**
 * foobar2000 本機已建立的播放清單摘要資訊 (供智慧媒體庫下拉選單匯入使用)
 */
export interface FoobarPlaylistSummary {
    index: number;
    guid?: string;
    name: string;
    trackCount: number;
    isActive?: boolean;
    isPlaying?: boolean;
    isAutoplaylist?: boolean;
    isLocked?: boolean;
}

/**
 * Bridge IPC 雙向通訊紀錄項目（供 HostBridgeModal 即時診斷檢視）
 */
export interface BridgeLogEntry {
    id: string;
    timestamp: string;
    direction: 'CLIENT_TO_HOST' | 'HOST_TO_CLIENT';
    type: string;
    summary: string;
}

const MAX_BRIDGE_LOGS = 40;
let bridgeLogs: BridgeLogEntry[] = [];
const bridgeLogListeners = new Set<(logs: BridgeLogEntry[]) => void>();

// 記錄目前已在 foobar2000 宿主載入/播放中的音訊檔案路徑，以及切歌過渡與 Silence 靜音標記
let currentHostPlayingPath: string | null = null;
let currentHostPlayingRowIndex: number | null = null;
// [修復問題 2：追蹤當前播放曲目是否已實際綁定於同步後的「DJ Workflow Set」播放清單游標]
// 造成錯誤的原因：當「DJ Workflow Set」執行 clear() 重寫、或啟動時曲目原本載入自其他歌單時，foobar2000 底層的播放游標會與清單列索引脫鉤（重置為第 0 列），
// 若此時僅呼叫 player.play() / player.seek() 而未呼叫 playlist.playTrack() 綁定列索引，最小化背景播完當前曲目後 foobar2000 就會自動跳回第 0 列（第一首歌）！
// 修改的目的：確保每次清單重建或首次從主時間軸播放時，皆透過 playlist.playTrack 明確綁定「DJ Workflow Set」的對應列索引。
let isCurrentTrackBoundToSyncedDjPlaylist = false;
let isSwitchingTrackOnHost = false;
let isHostPausedForSilence = false;
let cachedDjPlaylistIndex: number | null = null;
const djPlaylistRowByPath = new Map<string, number>();
let djPlaylistRowCount = 0;
// [修復問題 3：保存當前畫布計算出的完整播放佇列路徑順序與已寫入宿主之簽章，確保「DJ Workflow Set」與 flatQueue 100% 同步且無殘留曲目]
let latestOrderedQueuePaths: string[] = [];
let lastSyncedQueueSignature = '__UNSYNCED__';
let latestSpectrumBins: number[] = Array.from({ length: 64 }, () => 0);

export const getCurrentHostPlayingPath = (): string | null =>
    currentHostPlayingPath;

export const appendBridgeLog = (
    direction: 'CLIENT_TO_HOST' | 'HOST_TO_CLIENT',
    type: string,
    payloadObj: unknown
): void => {
    const now = new Date();
    const timestamp = now.toTimeString().split(' ')[0];
    let summary: string;
    try {
        const raw =
            typeof payloadObj === 'string'
                ? payloadObj
                : JSON.stringify(payloadObj);
        summary = raw.length > 130 ? `${raw.slice(0, 130)}...` : raw;
    } catch {
        summary = String(payloadObj);
    }

    const entry: BridgeLogEntry = {
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        timestamp,
        direction,
        type,
        summary,
    };

    bridgeLogs = [entry, ...bridgeLogs].slice(0, MAX_BRIDGE_LOGS);
    for (const listener of bridgeLogListeners) {
        listener(bridgeLogs);
    }
};

export const getBridgeLogs = (): BridgeLogEntry[] => bridgeLogs;

export const clearBridgeLogs = (): void => {
    bridgeLogs = [];
    for (const listener of bridgeLogListeners) {
        listener(bridgeLogs);
    }
};

export const subscribeToBridgeLogs = (
    listener: (logs: BridgeLogEntry[]) => void
): (() => void) => {
    bridgeLogListeners.add(listener);
    listener(bridgeLogs);
    return () => {
        bridgeLogListeners.delete(listener);
    };
};

/**
 * 檢查當前是否運行於 NereaFantasia/foo_ui_webview2 (fb.isAvailable() / window.fb2k) 或 WebView2 容器內
 */
export const isFoobarWebView = (): boolean => {
    if (typeof window === 'undefined') return false;
    try {
        if (fb.isAvailable()) return true;
    } catch {
        // 忽略初始化前檢查例外
    }
    return Boolean(window.fb2k || window.chrome?.webview);
};

/**
 * 探測當前 foo_ui_webview2 / foo-webview-sdk 環境狀態（供診斷視窗檢視）
 */
export const probeFoobarHostEnvironment = (): {
    hasWebView: boolean;
    hostObjectNames: string[];
    detectedMethods: string[];
    isLibraryEnabled: boolean | null;
} => {
    const hasWebView = isFoobarWebView();
    const hostObjectNames: string[] = [];
    const detectedMethods: string[] = [];

    if (typeof window !== 'undefined') {
        if (fb.isAvailable() || window.fb2k) {
            hostObjectNames.push(
                'window.fb2k (BridgeCore)',
                'foo-webview-sdk v2.2'
            );
            detectedMethods.push(
                'fb.library.getAll',
                'fb.library.search',
                'jitQueue.playNow',
                'playback.playPath',
                'fb.player.seek',
                'fb.audio.subscribeSpectrum',
                'audio.getWaveform (Stereo VU)'
            );
        } else if (window.chrome?.webview) {
            hostObjectNames.push('window.chrome.webview');
        }
    }

    return {
        hasWebView,
        hostObjectNames,
        detectedMethods,
        isLibraryEnabled: fb.isAvailable() ? true : null,
    };
};

/**
 * 根據索引生成確定性的合成波形陣列
 */
const buildDeterministicWaveform = (seedIndex: number): number[] => {
    return Array.from({ length: 10 }, (_, i) => {
        const val =
            0.25 +
            Math.abs(Math.sin((seedIndex + 1) * 1.7 + i * 0.85)) * 0.7;
        return Number(val.toFixed(2));
    });
};

/**
 * foobar2000 預設與常見擴充組件可播放的所有音訊與容器副檔名清單
 */
export const FOOBAR_PLAYABLE_EXTENSIONS: readonly string[] = [
    'flac',
    'mp3',
    'wav',
    'aiff',
    'aif',
    'aifc',
    'm4a',
    'mp4',
    'm4b',
    'aac',
    'ogg',
    'oga',
    'opus',
    'alac',
    'ape',
    'wv',
    'tak',
    'tta',
    'mpc',
    'mp+',
    'mpp',
    'spx',
    'wma',
    'asf',
    'ac3',
    'dts',
    'dtshd',
    'dsf',
    'dff',
    'dsd',
    'sacd',
    'iso',
    'mka',
    'mkv',
    'webm',
    'cda',
    'cue',
    'mod',
    'xm',
    'it',
    's3m',
    'mtm',
    'umx',
    'vgm',
    'vgz',
    'spc',
    'nsf',
    'psf',
    'gbs',
    'hes',
    'sid',
    'shn',
    'ofr',
    'ofs',
    'rkau',
    'la',
    'pac',
    'au',
    'snd',
    'voc',
    'w64',
    'rf64',
    'caf',
    'oma',
    'aa3',
    'at3',
    'mid',
    'midi',
    'kar',
    'rmi',
    'mp2',
    'mp1',
    'amr',
    '3gp',
];

/**
 * 動態向 foobar2000 查詢當前已註冊的所有可播放輸入格式 (discovery.getInputFormats)，並與預設清單合併
 */
export const getFoobarPlayableExtensions = async (): Promise<string[]> => {
    const extSet = new Set<string>(FOOBAR_PLAYABLE_EXTENSIONS);
    if (fb.isAvailable() || window.fb2k) {
        try {
            const res = await fb.discovery.getInputFormats();
            if (
                res &&
                res.success !== false &&
                'fileTypes' in res &&
                Array.isArray(res.fileTypes)
            ) {
                for (const ft of res.fileTypes) {
                    if (typeof ft.mask === 'string') {
                        // 解析如 "*.FLAC;*.OGA" 的遮罩字串
                        const parts = ft.mask.split(/[;,]+/);
                        for (const p of parts) {
                            const cleaned = p
                                .trim()
                                .replace(/^\*\./, '')
                                .replace(/^\./, '')
                                .toLowerCase();
                            if (
                                cleaned &&
                                cleaned !== '*' &&
                                /^[a-z0-9+_]+$/.test(cleaned)
                            ) {
                                extSet.add(cleaned);
                            }
                        }
                    }
                }
            }
        } catch {
            // 忽略選用格式探測例外
        }
    }
    return Array.from(extSet);
};

/**
 * 判斷檔案名稱或路徑是否為 foobar2000 可播放的音訊檔案格式
 */
export const isPlayableAudioFileName = (
    fileNameOrPath: string,
    allowedExtensions: readonly string[] = FOOBAR_PLAYABLE_EXTENSIONS
): boolean => {
    const clean = fileNameOrPath.split('|')[0].trim();
    const dotIdx = clean.lastIndexOf('.');
    if (dotIdx < 0 || dotIdx === clean.length - 1) return false;
    const ext = clean.slice(dotIdx + 1).toLowerCase();
    return allowedExtensions.includes(ext);
};

interface EnrichedTrackExtraMeta {
    title?: string;
    artist?: string;
    album?: string;
    durationSec?: number;
    codec?: string;
    sampleRateHz?: number;
    genre?: string;
    coverDataUrl?: string;
}

/**
 * 將 foo-webview-sdk 的 Track 結構轉換為本播放器的標準 Track 結構
 * 注意：
 * 1. 絕不退回虛擬假封面 COVER_POOL（無封面時為 undefined）
 * 2. 絕不讀取音檔內建 BPM / Key Tag，初始給予基準值 124 / 8A，由 audioAnalyzer 真實 PCM 計算完成後覆寫更新
 */
const mapSdkTrackToAppTrack = (
    sdkTrack: Partial<FbSdkTrack>,
    index: number,
    extraMeta?: EnrichedTrackExtraMeta
): Track => {
    // 優先使用 absolutePath 作為本地實體播放路徑，若含有非 0 subsong 則使用 handle
    const hasSubsong =
        typeof sdkTrack.subsong === 'number' && sdkTrack.subsong > 0;
    const rawPath = hasSubsong
        ? sdkTrack.handle || sdkTrack.absolutePath || sdkTrack.path || ''
        : sdkTrack.absolutePath ||
          sdkTrack.path ||
          sdkTrack.handle ||
          `foobar://track/${index}`;

    const fileNameFallback =
        rawPath
            .split('|')[0]
            .split(/[\\/]/)
            .pop()
            ?.replace(/\.[^/.]+$/, '') || `Track #${index + 1}`;

    const parentFolderFallback =
        rawPath
            .split('|')[0]
            .split(/[\\/]/)
            .slice(-2, -1)[0] || 'foobar2000 Media Library';

    const title = (
        sdkTrack.title ||
        extraMeta?.title ||
        fileNameFallback
    ).trim();
    const artist = (
        sdkTrack.artist ||
        sdkTrack.albumArtist ||
        extraMeta?.artist ||
        'Unknown Artist'
    ).trim();
    const album = (
        sdkTrack.album ||
        extraMeta?.album ||
        parentFolderFallback
    ).trim();

    // 造成原錯誤的原因：先前以 Math.floor 強制無條件捨去至整數秒，每首曲目最多損失 0.99 秒，導致佇列總長度與背景計時產生累積誤差。
    // 本次修改的目的：改用 floorDurationToTenth 保留至 0.1s 精度向下取整，將單曲截斷誤差縮小 10 倍且確保絕不超過實體音檔 EOF。
    const rawDuration =
        typeof extraMeta?.durationSec === 'number' && extraMeta.durationSec > 1
            ? extraMeta.durationSec
            : typeof sdkTrack.duration === 'number' && sdkTrack.duration > 1
              ? sdkTrack.duration
              : 210;
    const duration = floorDurationToTenth(rawDuration);

    // BPM 與駱駝色輪色號統一由 audioAnalyzer.ts 真實 PCM 音訊分析計算，不讀取內建 Tag
    const bpm = 124;
    const key = '8A';

    const genre = (
        sdkTrack.genre ||
        extraMeta?.genre ||
        'Electronic / DJ'
    ).trim();
    const rating =
        typeof sdkTrack.rating === 'number' &&
        sdkTrack.rating >= 1 &&
        sdkTrack.rating <= 5
            ? Math.round(sdkTrack.rating)
            : 4;

    const albumSlug = (sdkTrack.albumId || album)
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
        .replace(/^-|-$/g, '');

    const codecPart =
        sdkTrack.codec ||
        extraMeta?.codec ||
        rawPath.split('|')[0].split('.').pop()?.toUpperCase() ||
        'FLAC';
    const rawSr =
        sdkTrack.sampleRate && sdkTrack.sampleRate > 0
            ? sdkTrack.sampleRate
            : extraMeta?.sampleRateHz && extraMeta.sampleRateHz > 0
              ? extraMeta.sampleRateHz
              : 44100;
    const srPart = `${(rawSr / 1000).toFixed(1).replace(/\.0$/, '')}kHz`;

    return {
        id: sdkTrack.handle || rawPath || `fb2k-track-${index + 1}`,
        albumId: `album-${albumSlug || 'default'}`,
        title,
        artist,
        album,
        duration,
        bpm,
        key,
        genre,
        rating,
        path: rawPath,
        coverUrl: extraMeta?.coverDataUrl || undefined,
        format: `${codecPart} / ${srPart}`,
        waveform: buildDeterministicWaveform(index),
        cuePoints: {
            mixIn: 0,
            mixOut: duration,
        },
    };
};

/**
 * 查詢 foobar2000 Media Library 是否已設定且包含曲目
 */
export const fetchMediaLibraryStatus = async (): Promise<{
    isConfigured: boolean;
    count: number;
}> => {
    if (!fb.isAvailable() && !window.fb2k) {
        return {
            isConfigured: true,
            count: MOCK_LIBRARY_TRACKS.length,
        };
    }

    try {
        if (window.fb2k?.invoke) {
            const countRes = (await window.fb2k.invoke(
                'library.getCount',
                {}
            )) as { success?: boolean; count?: number };
            if (
                countRes &&
                countRes.success !== false &&
                typeof countRes.count === 'number'
            ) {
                return {
                    isConfigured: countRes.count > 0,
                    count: countRes.count,
                };
            }
        }
        const allRes = await fb.library.getAll(0, 1);
        const total =
            allRes && allRes.success !== false && 'total' in allRes
                ? Number(allRes.total) || 0
                : 0;
        return {
            isConfigured: total > 0,
            count: total,
        };
    } catch {
        return { isConfigured: false, count: 0 };
    }
};

/**
 * [核心功能] 嚴格讀取 NereaFantasia/foo_ui_webview2 的真實 Media Library (絕不自動混入 Active Playlist)
 * 若使用者未在 foobar2000 設定 Media Library，回傳空陣列 []，由上層依據 2d 規則決定是否切換至可用 Playlist 或顯示空狀態
 */
export const fetchTracksFromNativeFoobarHost = async (): Promise<
    Track[] | null
> => {
    if (!fb.isAvailable() && !window.fb2k) {
        appendBridgeLog(
            'HOST_TO_CLIENT',
            'SDK_NOT_AVAILABLE',
            '目前未偵測到 window.fb2k (NereaFantasia/foo_ui_webview2 BridgeCore)'
        );
        return null;
    }

    let rawSdkTracks: Array<Partial<FbSdkTrack>> = [];

    // 1. 優先透過 fb.library.getAll(0, 500) 取得 foobar2000 Media Library 曲目
    try {
        appendBridgeLog('CLIENT_TO_HOST', 'fb.library.getAll', {
            offset: 0,
            limit: 500,
        });
        const allRes = await fb.library.getAll(0, 500);
        if (
            allRes &&
            allRes.success !== false &&
            'tracks' in allRes &&
            Array.isArray(allRes.tracks) &&
            allRes.tracks.length > 0
        ) {
            rawSdkTracks = allRes.tracks;
            appendBridgeLog(
                'HOST_TO_CLIENT',
                'fb.library.getAll',
                `成功從 Media Library 讀取 ${rawSdkTracks.length} / ${allRes.total} 首曲目`
            );
        }
    } catch (err) {
        appendBridgeLog(
            'HOST_TO_CLIENT',
            'library.getAll_ERR',
            String(err)
        );
    }

    // 2. 若 getAll 為空，嘗試呼叫 fb.library.search('ALL', 500)
    if (rawSdkTracks.length === 0) {
        try {
            appendBridgeLog('CLIENT_TO_HOST', 'fb.library.search', {
                query: 'ALL',
                limit: 500,
            });
            const searchRes = await fb.library.search('ALL', 500);
            if (
                searchRes &&
                searchRes.success !== false &&
                'tracks' in searchRes &&
                Array.isArray(searchRes.tracks) &&
                searchRes.tracks.length > 0
            ) {
                rawSdkTracks = searchRes.tracks;
                appendBridgeLog(
                    'HOST_TO_CLIENT',
                    'fb.library.search',
                    `成功透過搜尋讀取 ${rawSdkTracks.length} 首曲目`
                );
            }
        } catch (err) {
            appendBridgeLog(
                'HOST_TO_CLIENT',
                'library.search_ERR',
                String(err)
            );
        }
    }

    if (rawSdkTracks.length === 0) {
        return [];
    }

    return await enrichAndMapSdkTracks(rawSdkTracks);
};

// 避免同一路徑或同一資料夾重複發送 IPC 請求的記憶體鎖與資料夾快取
const inFlightCoverRequests = new Map<string, Promise<string | undefined>>();
const globalFolderCoverCache = new Map<string, string | null>();

/**
 * 單曲真實封面即時查詢：優先從 Memory + IndexedDB 快取 0ms 讀取；
 * 若尚未快取，嘗試透過 getForTrack / getByPath / 同資料夾外部封面擷取並寫入 IndexedDB 永久快取
 */
export const fetchSingleTrackRealCover = async (
    trackPath: string,
    artist?: string,
    album?: string
): Promise<string | undefined> => {
    if (!trackPath) return undefined;
    const cleanPath = trackPath.split('|')[0];

    await ensureArtworkCacheLoaded();
    const cached = getCachedCoverSync(cleanPath, artist, album);
    if (cached) {
        return cached;
    }

    if (!fb.isAvailable() && !window.fb2k) {
        return undefined;
    }

    const requestKey = cleanPath.toLowerCase();
    const existingReq = inFlightCoverRequests.get(requestKey);
    if (existingReq) {
        return existingReq;
    }

    const task = (async (): Promise<string | undefined> => {
        try {
            const res = await fb.artwork.getForTrack(cleanPath, 'front');
            if (
                res &&
                res.success !== false &&
                'available' in res &&
                res.available &&
                res.dataUrl
            ) {
                setCachedCover(cleanPath, res.dataUrl, artist, album);
                return res.dataUrl;
            }
        } catch {
            // ignore
        }

        try {
            const byPathRes = await fb.artwork.getByPath(cleanPath, 'front');
            if (
                byPathRes &&
                byPathRes.success !== false &&
                'available' in byPathRes &&
                byPathRes.available &&
                byPathRes.dataUrl
            ) {
                setCachedCover(cleanPath, byPathRes.dataUrl, artist, album);
                return byPathRes.dataUrl;
            }
        } catch {
            // ignore
        }

        // 備援：檢查該音訊檔所在資料夾是否有 cover.jpg / folder.jpg 等外部圖片檔（同資料夾只查一次）
        const lastSep = Math.max(
            cleanPath.lastIndexOf('\\'),
            cleanPath.lastIndexOf('/')
        );
        if (lastSep > 2) {
            const dirPath = cleanPath.slice(0, lastSep);
            const dirKey = dirPath.toLowerCase();
            if (!globalFolderCoverCache.has(dirKey)) {
                let foundDirCover: string | null = null;
                try {
                    const folderImgs =
                        await fb.artwork.getFolderImages(dirPath);
                    if (
                        folderImgs &&
                        folderImgs.success !== false &&
                        'images' in folderImgs &&
                        Array.isArray(folderImgs.images) &&
                        folderImgs.images.length > 0
                    ) {
                        const preferred =
                            folderImgs.images.find((img) =>
                                /^(cover|folder|front|album)/i.test(img.name)
                            ) ?? folderImgs.images[0];
                        if (preferred?.path) {
                            const fileReadRes = await fb.file.read(
                                preferred.path,
                                { encoding: 'binary' }
                            );
                            if (
                                fileReadRes &&
                                fileReadRes.success !== false &&
                                'content' in fileReadRes &&
                                fileReadRes.content
                            ) {
                                const ext = preferred.name
                                    .split('.')
                                    .pop()
                                    ?.toLowerCase();
                                const mime =
                                    ext === 'png'
                                        ? 'image/png'
                                        : ext === 'webp'
                                          ? 'image/webp'
                                          : 'image/jpeg';
                                foundDirCover = `data:${mime};base64,${fileReadRes.content}`;
                            }
                        }
                    }
                } catch {
                    // ignore
                }
                globalFolderCoverCache.set(dirKey, foundDirCover);
            }

            const folderCover = globalFolderCoverCache.get(dirKey);
            if (folderCover) {
                setCachedCover(cleanPath, folderCover, artist, album);
                return folderCover;
            }
        }

        return undefined;
    })();

    inFlightCoverRequests.set(requestKey, task);
    try {
        return await task;
    } finally {
        inFlightCoverRequests.delete(requestKey);
    }
};

/**
 * 為一批 SDK 曲目批次查詢真實基本資訊 (titleformat.evalFieldsBatch) 與已快取或批次真實專輯封面
 * 移除阻塞式的逐首 80 次串行 IPC 迴圈，讓智慧媒體庫清單與畫布節點在 <50ms 內秒開渲染！
 */
const enrichAndMapSdkTracks = async (
    rawSdkTracks: Array<Partial<FbSdkTrack>>
): Promise<Track[]> => {
    await ensureArtworkCacheLoaded();

    const paths = rawSdkTracks.map((t, idx) =>
        t.subsong && t.subsong > 0 && t.handle
            ? t.handle
            : t.absolutePath || t.path || t.handle || `foobar://track/${idx}`
    );
    const metaByIndex = new Map<number, EnrichedTrackExtraMeta>();

    if ((fb.isAvailable() || window.fb2k?.invoke) && paths.length > 0) {
        // 1. 透過 titleformat.evalFieldsBatch 一次批量補齊曲名、演出者、專輯、精確秒數、編碼與取樣率
        try {
            const tfRes = await fb.titleformat.evalFieldsBatch(paths, {
                title: '%title%',
                artist: '$if2(%artist%,%album artist%)',
                album: '%album%',
                lengthSec: '%length_seconds_fp%',
                codec: '%codec%',
                samplerate: '%samplerate%',
                genre: '%genre%',
            });

            if (
                tfRes &&
                tfRes.success !== false &&
                'results' in tfRes &&
                Array.isArray(tfRes.results)
            ) {
                tfRes.results.forEach((row, idx) => {
                    const cleanVal = (v?: string) =>
                        v && v !== '?' && v.trim() !== ''
                            ? v.trim()
                            : undefined;
                    const durNum = Number(row.lengthSec);
                    const srNum = Number(row.samplerate);
                    metaByIndex.set(idx, {
                        title: cleanVal(row.title),
                        artist: cleanVal(row.artist),
                        album: cleanVal(row.album),
                        durationSec:
                            Number.isFinite(durNum) && durNum > 0
                                ? durNum
                                : undefined,
                        codec: cleanVal(row.codec),
                        sampleRateHz:
                            Number.isFinite(srNum) && srNum > 0
                                ? srNum
                                : undefined,
                        genre: cleanVal(row.genre),
                    });
                });
            }
        } catch {
            // 忽略標籤查詢例外
        }

        // 2. 先從 Memory + IndexedDB 快取瞬間掛載已知封面，僅對尚未快取的曲目進行快速 getBatch 查詢
        const uncachedIndices: number[] = [];
        for (let idx = 0; idx < paths.length; idx++) {
            const cleanPath = paths[idx].split('|')[0];
            const prev = metaByIndex.get(idx);
            const artist = prev?.artist ?? rawSdkTracks[idx]?.artist;
            const album = prev?.album ?? rawSdkTracks[idx]?.album;
            const cachedCover = getCachedCoverSync(cleanPath, artist, album);
            if (cachedCover) {
                metaByIndex.set(idx, {
                    ...(prev ?? {}),
                    coverDataUrl: cachedCover,
                });
            } else {
                uncachedIndices.push(idx);
            }
        }

        // 僅針對尚未在 IndexedDB 快取中的前 40 首曲目執行一次快速批次 getBatch，不阻塞初次列表渲染
        if (uncachedIndices.length > 0) {
            const batchTargetIndices = uncachedIndices.slice(0, 40);
            const chunkPaths = batchTargetIndices.map((idx) =>
                paths[idx].split('|')[0]
            );
            try {
                const batchArtRes = await fb.artwork.getBatch(
                    chunkPaths,
                    'front'
                );
                if (
                    batchArtRes &&
                    batchArtRes.success !== false &&
                    'artworks' in batchArtRes &&
                    Array.isArray(batchArtRes.artworks)
                ) {
                    batchArtRes.artworks.forEach((row, localIdx) => {
                        const globalIdx = batchTargetIndices[localIdx];
                        if (
                            globalIdx !== undefined &&
                            row &&
                            row.available &&
                            row.dataUrl
                        ) {
                            const prev = metaByIndex.get(globalIdx) ?? {};
                            const artist =
                                prev.artist ?? rawSdkTracks[globalIdx]?.artist;
                            const album =
                                prev.album ?? rawSdkTracks[globalIdx]?.album;
                            setCachedCover(
                                chunkPaths[localIdx],
                                row.dataUrl,
                                artist,
                                album
                            );
                            metaByIndex.set(globalIdx, {
                                ...prev,
                                coverDataUrl: row.dataUrl,
                            });
                        }
                    });
                }
            } catch {
                // ignore batch error; background hydration will fill any remaining covers
            }
        }
    }

    return rawSdkTracks.map((sdkTrack, idx) =>
        mapSdkTrackToAppTrack(sdkTrack, idx, metaByIndex.get(idx))
    );
};

/**
 * [修復畫布既有卡片與快取曲目時長進位問題]
 * 錯誤原因：已保存在 localStorage (`foobar_dj_autosave_project_v1` / `foobar_dj_working_library_tracks_v1`) 的專輯卡片曲目，
 *          其 `duration` 為先前已四捨五入的整數（如 261），單純執行 `Math.floor(261)` 無法還原真實的 `260.52s -> 260s`。
 * 修改目的：向 foobar2000 批次查詢 `%length_seconds_fp%` 浮點數秒數並無條件捨去 (`Math.floor`)，供畫布節點與媒體庫快取自動校準時長。
 */
export const queryTracksExactFloorDurations = async (
    rawPaths: string[]
): Promise<Map<string, number>> => {
    const result = new Map<string, number>();
    if (!fb.isAvailable() && !window.fb2k?.invoke) {
        return result;
    }

    const validPaths = Array.from(
        new Set(
            rawPaths.filter(
                (p) =>
                    Boolean(p) &&
                    !p.startsWith('foobar://') &&
                    !p.startsWith('C:\\Music\\DJ_Set\\') &&
                    !p.startsWith('local-file-')
            )
        )
    );
    if (validPaths.length === 0) {
        return result;
    }

    try {
        const tfRes = await fb.titleformat.evalFieldsBatch(validPaths, {
            lengthSec: '%length_seconds_fp%',
        });
        if (
            tfRes &&
            tfRes.success !== false &&
            'results' in tfRes &&
            Array.isArray(tfRes.results)
        ) {
            tfRes.results.forEach((row, idx) => {
                const path = validPaths[idx];
                const durNum = Number(row?.lengthSec);
                if (path && Number.isFinite(durNum) && durNum > 1) {
                    // 造成原錯誤的原因：整數秒 Math.floor 會截斷最多 0.99s 尾音，造成跨曲累積時間軸偏移。
                    // 本次修改的目的：統一使用 0.1s 精度向下取整 (floorDurationToTenth)，兼顧精準度與防超界安全。
                    const floored = floorDurationToTenth(durNum);
                    result.set(path, floored);
                    const norm = normalizeAudioPathForMatch(path);
                    if (norm) {
                        result.set(norm, floored);
                    }
                }
            });
        }
    } catch {
        // 忽略查詢例外
    }

    return result;
};

// 瀏覽器離線預覽專用的模擬播放清單儲存體 (支援新建、覆寫、改名、刪除)
let mockPlaylistsStore: Array<{
    name: string;
    tracks: Track[];
    isAutoplaylist?: boolean;
    isLocked?: boolean;
}> | null = null;

const getOrInitMockPlaylistsStore = () => {
    if (!mockPlaylistsStore) {
        mockPlaylistsStore = [
            {
                name: 'Default (預設播放清單)',
                tracks: [...MOCK_LIBRARY_TRACKS],
            },
            {
                name: 'Melodic Techno & Progressive',
                tracks: MOCK_LIBRARY_TRACKS.slice(0, 3),
            },
            {
                name: 'Deep & Peak Time Selection',
                tracks: MOCK_LIBRARY_TRACKS.slice(3, 6),
            },
        ];
    }
    return mockPlaylistsStore;
};

/**
 * 讀取 foobar2000 本機已建立的所有播放清單清單 (供智慧媒體庫下拉清單匯入)
 */
export const fetchFoobarPlaylists = async (): Promise<
    FoobarPlaylistSummary[]
> => {
    if (!fb.isAvailable() && !window.fb2k) {
        const store = getOrInitMockPlaylistsStore();
        return store.map((pl, idx) => ({
            index: idx,
            name: pl.name,
            trackCount: pl.tracks.length,
            isActive: idx === 0,
            isAutoplaylist: Boolean(pl.isAutoplaylist),
            isLocked: Boolean(pl.isLocked),
        }));
    }

    try {
        const allRes = await fb.playlist.getAll();
        if (
            allRes &&
            allRes.success !== false &&
            'playlists' in allRes &&
            Array.isArray(allRes.playlists)
        ) {
            return allRes.playlists
                .filter((p) => p.name !== 'DJ Workflow Set')
                .map((p) => ({
                    index: p.index,
                    guid: p.guid,
                    name: p.name || `Playlist #${p.index + 1}`,
                    trackCount:
                        typeof p.trackCount === 'number' ? p.trackCount : 0,
                    isActive: Boolean(p.isActive),
                    isPlaying: Boolean(p.isPlaying),
                    isAutoplaylist: Boolean(p.isAutoplaylist),
                    isLocked: Boolean(p.isLocked),
                }));
        }
    } catch (err) {
        appendBridgeLog(
            'HOST_TO_CLIENT',
            'playlist.getAll_ERR',
            String(err)
        );
    }
    return [];
};

/**
 * 根據播放清單索引從 foobar2000 匯入該播放清單內的所有曲目
 */
export const fetchTracksFromFoobarPlaylist = async (
    playlistIndex: number
): Promise<Track[] | null> => {
    if (!fb.isAvailable() && !window.fb2k) {
        const store = getOrInitMockPlaylistsStore();
        const found = store[playlistIndex];
        return found ? [...found.tracks] : [];
    }

    try {
        const plRes = await fb.playlist.getTracks(playlistIndex, 0, 500);
        if (
            plRes &&
            plRes.success !== false &&
            'tracks' in plRes &&
            Array.isArray(plRes.tracks)
        ) {
            if (plRes.tracks.length === 0) {
                return [];
            }
            return await enrichAndMapSdkTracks(plRes.tracks);
        }
    } catch (err) {
        appendBridgeLog(
            'HOST_TO_CLIENT',
            'playlist.getTracks_ERR',
            String(err)
        );
    }
    return null;
};

/**
 * 將一批路徑靜默寫入指定 foobar2000 播放清單
 * [修復問題 2 & 問題 3：解決跨 foobar2000 歌單或非媒體庫曲目寫入「DJ Workflow Set」時漏歌與切歌卡頓的問題]
 * 造成錯誤的原因：
 * 1. 先前步驟 1 (`playlist.addHandles`) 與步驟 2 (`library.addToPlaylist`) 只要 `addedCount > 0`（哪怕 4 首歌裡只成功加入 1 首）就立即 `return`，
 *    導致來自其他 foobar2000 歌單（或不在 Media Library 目錄內）的後續曲目完全沒被寫入「DJ Workflow Set」。
 * 2. 當「DJ Workflow Set」漏掉後續曲目時，最小化背景播完第一首就會直接跳回第一首，或在切歌瞬間才臨時進行多次失敗的 IPC 重試造成聲音卡頓。
 * 修改的目的：
 * 嚴格驗證寫入數量 `addedCount === validPaths.length`；若批次寫入數量不足，立即清空重試 `playlist.addPathsSequential` 或逐首依序寫入，
 * 確保無論曲目來自哪一個 foobar2000 歌單或外部資料夾，100% 按照 `flatQueue` 順序完整預先就緒於「DJ Workflow Set」。
 */
const addPathsToFoobarPlaylistSilent = async (
    playlistIndex: number,
    paths: string[]
): Promise<number> => {
    const validPaths = paths.filter(
        (p) =>
            Boolean(p) &&
            !p.startsWith('foobar://') &&
            !p.startsWith('C:\\Music\\DJ_Set\\') &&
            !p.startsWith('local-file-')
    );
    if (validPaths.length === 0 || !window.fb2k?.invoke) {
        return 0;
    }

    // 1. 優先透過 playlist.addHandles 直接由 metadb_handle 寫入（僅當全部曲目皆存在 handle 且完整加入時才直接完成）
    try {
        const handleRes = (await window.fb2k.invoke('playlist.addHandles', {
            playlist: playlistIndex,
            handles: validPaths,
        })) as { success?: boolean; addedCount?: number };
        if (
            handleRes &&
            handleRes.success !== false &&
            typeof handleRes.addedCount === 'number'
        ) {
            if (handleRes.addedCount === validPaths.length) {
                return handleRes.addedCount;
            }
            if (handleRes.addedCount > 0) {
                // 若僅部分曲目有現成 handle，先清空避免重複，改由下方支援跨歌單完整路徑的方法寫入
                try {
                    await fb.playlist.clear(playlistIndex);
                } catch {
                    // ignore
                }
            }
        }
    } catch {
        // fallback
    }

    // [修復問題 2：播放或跳轉時閃現 Processing files 視窗]
    // 造成原錯誤的原因：先前將 `playlist.addPathsSequential` 排在步驟 2（早於 `library.addToPlaylist`），
    // 而 `playlist.addPathsSequential` 在 C++ 底層會觸發 `process_locations_async` 並彈出 `Processing files` 對話框；
    // 且 `library.addToPlaylist` 回傳欄位可能為 `added` 或 `addedCount`。
    // 本次修改的目的：嚴格遵循 README 5.6 規範，優先使用純記憶體建立 metadb_handle 的 `playlist.addHandles` 與 `library.addToPlaylist`，
    // 僅針對不在媒體庫內的外部單曲才於逐首保底最後一步使用 `playlist.addPathsSequential`，徹底消除 `Processing files` 閃窗。
    // 2. 優先使用 library.addToPlaylist 於記憶體直接建立 metadb_handle（完全不觸發 Processing files 彈窗）
    try {
        const libRes = (await window.fb2k.invoke('library.addToPlaylist', {
            playlist: playlistIndex,
            paths: validPaths,
        })) as { success?: boolean; added?: number; addedCount?: number };
        if (libRes && libRes.success !== false) {
            const added = libRes.added ?? libRes.addedCount ?? 0;
            if (added === validPaths.length) {
                return added;
            }
            if (added > 0) {
                try {
                    await fb.playlist.clear(playlistIndex);
                } catch {
                    // ignore
                }
            }
        }
    } catch {
        // fallback
    }

    // 3. 逐首依序靜默寫入：每首皆優先走 addHandles -> library.addToPlaylist，僅當該單曲非媒體庫檔案時才退回 addPathsSequential
    let totalAdded = 0;
    for (const singlePath of validPaths) {
        let singleAdded = false;
        try {
            const hRes = (await window.fb2k.invoke('playlist.addHandles', {
                playlist: playlistIndex,
                handles: [singlePath],
            })) as { success?: boolean; addedCount?: number };
            if (hRes && hRes.success !== false && (hRes.addedCount ?? 0) > 0) {
                singleAdded = true;
                totalAdded += 1;
            }
        } catch {
            // continue
        }

        if (!singleAdded) {
            try {
                const lRes = (await window.fb2k.invoke(
                    'library.addToPlaylist',
                    {
                        playlist: playlistIndex,
                        paths: [singlePath],
                    }
                )) as {
                    success?: boolean;
                    added?: number;
                    addedCount?: number;
                };
                if (
                    lRes &&
                    lRes.success !== false &&
                    (lRes.added ?? lRes.addedCount ?? 0) > 0
                ) {
                    singleAdded = true;
                    totalAdded += 1;
                }
            } catch {
                // continue
            }
        }

        if (!singleAdded) {
            try {
                const sRes = (await window.fb2k.invoke(
                    'playlist.addPathsSequential',
                    {
                        playlist: playlistIndex,
                        paths: [singlePath],
                    }
                )) as { success?: boolean; addedCount?: number };
                if (
                    sRes &&
                    sRes.success !== false &&
                    (sRes.addedCount ?? 1) > 0
                ) {
                    totalAdded += 1;
                }
            } catch {
                // ignore
            }
        }
    }

    return totalAdded;
};

/**
 * [功能 1] 在 foobar2000 建立一個新的播放清單，並將計算好的 Flat Play Queue 寫入該清單
 */
export const createFoobarPlaylistWithTracks = async (
    playlistName: string,
    queue: Array<{ trackId: string; path: string }>,
    allTracksPool: Track[] = []
): Promise<{
    success: boolean;
    index?: number;
    name: string;
    addedCount: number;
    error?: string;
}> => {
    const cleanName = playlistName.trim() || `DJ Set ${new Date().toLocaleTimeString()}`;

    if (!fb.isAvailable() && !window.fb2k) {
        const store = getOrInitMockPlaylistsStore();
        const trackMap = new Map(allTracksPool.map((t) => [t.id, t]));
        const resolvedTracks = queue
            .map(
                (q) =>
                    trackMap.get(q.trackId) ??
                    MOCK_LIBRARY_TRACKS.find((m) => m.id === q.trackId)
            )
            .filter((t): t is Track => Boolean(t));
        store.push({
            name: cleanName,
            tracks: resolvedTracks,
        });
        return {
            success: true,
            index: store.length - 1,
            name: cleanName,
            addedCount: resolvedTracks.length,
        };
    }

    try {
        cachedDjPlaylistIndex = null;
        const created = await fb.playlist.create(cleanName);
        if (
            !created ||
            created.success === false ||
            !('index' in created) ||
            typeof created.index !== 'number'
        ) {
            return {
                success: false,
                name: cleanName,
                addedCount: 0,
                error: '建立 foobar2000 播放清單失敗',
            };
        }

        const newIndex = created.index;
        const paths = queue.map((q) => q.path);
        const addedCount = await addPathsToFoobarPlaylistSilent(
            newIndex,
            paths
        );

        appendBridgeLog('CLIENT_TO_HOST', 'playlist.createAndWrite', {
            name: cleanName,
            index: newIndex,
            addedCount,
        });

        return {
            success: true,
            index: newIndex,
            name: cleanName,
            addedCount: addedCount || paths.length,
        };
    } catch (err) {
        return {
            success: false,
            name: cleanName,
            addedCount: 0,
            error: String(err),
        };
    }
};

/**
 * [功能 2a] 在 foobar2000 建立一個新的空白 Playlist
 */
export const createBlankFoobarPlaylist = async (
    playlistName: string
): Promise<{
    success: boolean;
    index?: number;
    name: string;
    error?: string;
}> => {
    const cleanName = playlistName.trim() || 'New Playlist';

    if (!fb.isAvailable() && !window.fb2k) {
        const store = getOrInitMockPlaylistsStore();
        store.push({
            name: cleanName,
            tracks: [],
        });
        return {
            success: true,
            index: store.length - 1,
            name: cleanName,
        };
    }

    try {
        cachedDjPlaylistIndex = null;
        const created = await fb.playlist.create(cleanName);
        if (
            created &&
            created.success !== false &&
            'index' in created &&
            typeof created.index === 'number'
        ) {
            appendBridgeLog('CLIENT_TO_HOST', 'fb.playlist.create', {
                name: cleanName,
                index: created.index,
            });
            return {
                success: true,
                index: created.index,
                name: cleanName,
            };
        }
        return {
            success: false,
            name: cleanName,
            error: 'foobar2000 拒絕建立空白播放清單',
        };
    } catch (err) {
        return {
            success: false,
            name: cleanName,
            error: String(err),
        };
    }
};

/**
 * [功能 2c] 將當前智慧媒體庫內的曲目清單覆寫入下拉選單所選中的 foobar2000 Playlist
 */
export const overwriteFoobarPlaylist = async (
    playlistIndex: number,
    tracks: Track[]
): Promise<{
    success: boolean;
    count: number;
    error?: string;
}> => {
    if (!fb.isAvailable() && !window.fb2k) {
        const store = getOrInitMockPlaylistsStore();
        const target = store[playlistIndex];
        if (!target) {
            return {
                success: false,
                count: 0,
                error: '找不到指定的播放清單',
            };
        }
        if (target.isAutoplaylist || target.isLocked) {
            return {
                success: false,
                count: 0,
                error: '此播放清單為鎖定或自動播放清單，無法覆寫',
            };
        }
        target.tracks = [...tracks];
        return {
            success: true,
            count: tracks.length,
        };
    }

    try {
        const clearRes = await fb.playlist.clear(playlistIndex);
        if (clearRes && clearRes.success === false) {
            return {
                success: false,
                count: 0,
                error: '此播放清單可能已鎖定 (Locked / Autoplaylist)，無法清空覆寫',
            };
        }

        const paths = tracks.map((t) => t.path);
        const added = await addPathsToFoobarPlaylistSilent(playlistIndex, paths);

        appendBridgeLog('CLIENT_TO_HOST', 'playlist.overwrite', {
            playlist: playlistIndex,
            trackCount: tracks.length,
            added,
        });

        return {
            success: true,
            count: added || tracks.length,
        };
    } catch (err) {
        return {
            success: false,
            count: 0,
            error: String(err),
        };
    }
};

/**
 * [功能 2d] 重新命名 foobar2000 播放清單
 */
export const renameFoobarPlaylist = async (
    playlistIndex: number,
    newName: string
): Promise<{
    success: boolean;
    error?: string;
}> => {
    const cleanName = newName.trim();
    if (!cleanName) {
        return { success: false, error: '播放清單名稱不可為空白' };
    }

    if (!fb.isAvailable() && !window.fb2k) {
        const store = getOrInitMockPlaylistsStore();
        const target = store[playlistIndex];
        if (!target) {
            return { success: false, error: '找不到指定的播放清單' };
        }
        target.name = cleanName;
        return { success: true };
    }

    try {
        if (window.fb2k?.invoke) {
            const res = (await window.fb2k.invoke('playlist.rename', {
                playlist: playlistIndex,
                name: cleanName,
            })) as { success?: boolean; error?: string };
            if (res && res.success !== false) {
                appendBridgeLog('CLIENT_TO_HOST', 'playlist.rename', {
                    playlist: playlistIndex,
                    name: cleanName,
                });
                return { success: true };
            }
            return {
                success: false,
                error: res?.error || '重新命名失敗（清單可能已鎖定）',
            };
        }
        return { success: false, error: 'Bridge 尚未就緒' };
    } catch (err) {
        return { success: false, error: String(err) };
    }
};

/**
 * [功能 2d] 刪除 foobar2000 播放清單
 */
export const deleteFoobarPlaylist = async (
    playlistIndex: number
): Promise<{
    success: boolean;
    error?: string;
}> => {
    if (!fb.isAvailable() && !window.fb2k) {
        const store = getOrInitMockPlaylistsStore();
        if (playlistIndex < 0 || playlistIndex >= store.length) {
            return { success: false, error: '找不到指定的播放清單' };
        }
        store.splice(playlistIndex, 1);
        return { success: true };
    }

    try {
        cachedDjPlaylistIndex = null;
        if (window.fb2k?.invoke) {
            const res = (await window.fb2k.invoke('playlist.remove', {
                playlist: playlistIndex,
            })) as { success?: boolean; error?: string };
            if (res && res.success !== false) {
                appendBridgeLog('CLIENT_TO_HOST', 'playlist.remove', {
                    playlist: playlistIndex,
                });
                return { success: true };
            }
            return {
                success: false,
                error: res?.error || '刪除播放清單失敗（清單可能已鎖定）',
            };
        }
        return { success: false, error: 'Bridge 尚未就緒' };
    } catch (err) {
        return { success: false, error: String(err) };
    }
};

/**
 * [功能 2b] 在 WebView2 環境呼叫原生系統對話框選取多個音訊檔案或整個資料夾，並解析為真實路徑 Track 陣列
/**
 * [功能 2b] 在 WebView2 環境呼叫原生系統對話框選取多個音訊檔案或整個資料夾，並解析為真實路徑 Track 陣列
 * 支援 foobar2000 所有已註冊與可播放的音訊格式 (透過 discovery.getInputFormats 動態擴充)
 */
export const pickNativeLocalAudioTracks = async (
    mode: 'files' | 'folder'
): Promise<{
    supported: boolean;
    cancelled?: boolean;
    tracks: Track[];
}> => {
    if (!fb.isAvailable() && !window.fb2k?.invoke) {
        return { supported: false, tracks: [] };
    }

    const playableExts = await getFoobarPlayableExtensions();
    let selectedPaths: string[] = [];

    try {
        if (mode === 'files') {
            const dlgRes = (await fb.dialog.openFile({
                title: '選擇要加入智慧媒體庫的本地音訊檔案 (可多選)',
                multiple: true,
                filters: [
                    {
                        name: 'foobar2000 支援的所有音訊檔案',
                        extensions: playableExts,
                    },
                    {
                        name: '所有檔案 (*.*)',
                        extensions: ['*'],
                    },
                ],
            })) as {
                success?: boolean;
                canceled?: boolean;
                cancelled?: boolean;
                filePaths?: string[];
                paths?: string[];
                path?: string;
            };

            if (!dlgRes || dlgRes.canceled || dlgRes.cancelled) {
                return { supported: true, cancelled: true, tracks: [] };
            }
            if (
                Array.isArray(dlgRes.filePaths) &&
                dlgRes.filePaths.length > 0
            ) {
                selectedPaths = dlgRes.filePaths;
            } else if (Array.isArray(dlgRes.paths) && dlgRes.paths.length > 0) {
                selectedPaths = dlgRes.paths;
            } else if (typeof dlgRes.path === 'string' && dlgRes.path) {
                selectedPaths = [dlgRes.path];
            }
        } else {
            const folderRes = (await fb.dialog.openFolder({
                title: '選擇要追加匯入智慧媒體庫的音樂資料夾',
            })) as {
                success?: boolean;
                canceled?: boolean;
                cancelled?: boolean;
                folderPath?: string;
                path?: string;
            };

            const chosenFolder =
                folderRes?.folderPath || folderRes?.path || '';
            if (
                !folderRes ||
                folderRes.canceled ||
                folderRes.cancelled ||
                !chosenFolder
            ) {
                return { supported: true, cancelled: true, tracks: [] };
            }

            const listRes = await fb.file.list(chosenFolder, {
                recursive: true,
            });

            if (
                listRes &&
                listRes.success !== false &&
                'files' in listRes &&
                Array.isArray(listRes.files)
            ) {
                selectedPaths = listRes.files
                    .filter((f) => isPlayableAudioFileName(f, playableExts))
                    .map((f) =>
                        f.includes(':\\') ||
                        f.startsWith('\\\\') ||
                        f.startsWith('/')
                            ? f
                            : `${chosenFolder.replace(/[\\/]$/, '')}\\${f.replace(/^[\\/]/, '')}`
                    );
            }
        }

        if (selectedPaths.length === 0) {
            return { supported: true, tracks: [] };
        }

        // 建立初始曲目結構，並透過 metadata.readBatch 與 enrichAndMapSdkTracks 讀取真實標籤、秒數與真實封面
        const rawSdkItems: Array<Partial<FbSdkTrack>> = selectedPaths.map(
            (p) => ({
                handle: p,
                path: p,
                absolutePath: p,
            })
        );

        try {
            const metaBatch = await fb.metadata.readBatch(selectedPaths);
            if (
                metaBatch &&
                metaBatch.success !== false &&
                'results' in metaBatch &&
                Array.isArray(metaBatch.results)
            ) {
                metaBatch.results.forEach((row, idx) => {
                    if (!row || !row.success || !row.tags) return;
                    const tags = row.tags;
                    const getStr = (k: string): string | undefined => {
                        const val = tags[k] ?? tags[k.toLowerCase()];
                        if (typeof val === 'string' && val.trim()) {
                            return val.trim();
                        }
                        if (
                            Array.isArray(val) &&
                            typeof val[0] === 'string' &&
                            val[0].trim()
                        ) {
                            return val[0].trim();
                        }
                        return undefined;
                    };
                    const getNum = (k: string): number | undefined => {
                        const val = tags[k] ?? tags[k.toLowerCase()];
                        const num = Number(val);
                        return Number.isFinite(num) && num > 0
                            ? num
                            : undefined;
                    };

                    rawSdkItems[idx] = {
                        ...rawSdkItems[idx],
                        title: getStr('TITLE'),
                        artist:
                            getStr('ARTIST') || getStr('ALBUM ARTIST'),
                        album: getStr('ALBUM'),
                        genre: getStr('GENRE'),
                        codec: getStr('CODEC'),
                        duration:
                            getNum('DURATION') || getNum('LENGTH_SECONDS'),
                        sampleRate: getNum('SAMPLERATE'),
                    };
                });
            }
        } catch {
            // 若 metadata.readBatch 發生例外，交由 enrichAndMapSdkTracks 的 titleformat.evalFieldsBatch 處理
        }

        const tracks = await enrichAndMapSdkTracks(rawSdkItems);
        appendBridgeLog('HOST_TO_CLIENT', 'LOCAL_IMPORT_SUCCESS', {
            mode,
            count: tracks.length,
        });
        return {
            supported: true,
            tracks,
        };
    } catch (err) {
        appendBridgeLog('HOST_TO_CLIENT', 'LOCAL_IMPORT_ERR', String(err));
        return { supported: false, tracks: [] };
    }
};

/**
 * 尋找或建立專屬的可寫入「DJ Workflow Set」播放清單，並快取其內部曲目索引
 * 使用 library.addToPlaylist / playlist.addHandles 直接建立 metadb_handle，完全不觸發 foobar2000 左上角的「Processing files」視窗！
 */
const ensureEditableDjPlaylist = async (): Promise<number> => {
    if (cachedDjPlaylistIndex !== null) {
        return cachedDjPlaylistIndex;
    }

    const allRes = await fb.playlist.getAll();
    if (
        allRes &&
        allRes.success !== false &&
        'playlists' in allRes &&
        Array.isArray(allRes.playlists)
    ) {
        const existing = allRes.playlists.find(
            (p) => p.name === 'DJ Workflow Set' && !p.isLocked
        );
        if (existing && typeof existing.index === 'number') {
            cachedDjPlaylistIndex = existing.index;
            return existing.index;
        }
    }

    const created = await fb.playlist.create('DJ Workflow Set');
    if (
        created &&
        created.success !== false &&
        'index' in created &&
        typeof created.index === 'number'
    ) {
        cachedDjPlaylistIndex = created.index;
        djPlaylistRowByPath.clear();
        djPlaylistRowCount = 0;
        lastSyncedQueueSignature = '';
        return created.index;
    }
    return 0;
};

/**
 * [修復問題 3：最小化後背景播放時，防止播完當前曲目跳至播放殘留曲目]
 * 造成錯誤的原因：
 * 1. 當視窗最小化時，Windows Edge WebView2 會對背景計時器節流，單曲播放結束時由 foobar2000 底層 C++ 引擎自動跳往當前播放清單（DJ Workflow Set）的下一列 (`rowIndex + 1`)。
 * 2. 先前僅在單曲播放時按需追加曲目 (`ensureTrackRowInDjPlaylist`)，且啟動時因 `queryHostPlaybackSnapshot` 已設定 `currentHostPlayingPath`，導致 `DJ Workflow Set` 從未被清空，也未按 `flatQueue` 完整順序寫入。
 * 修改的目的：
 * 將畫布計算出的完整 `flatQueue` 曲目順序 (`latestOrderedQueuePaths`) 完整同步覆寫至 `DJ Workflow Set`（先 `clear` 清除所有殘留曲目，再按 `0, 1, 2...` 順序一次性寫入），
 * 確保即使視窗最小化、前端 JS 處於背景節流狀態，foobar2000 C++ 引擎自然推進至 `rowIndex + 1` 時也 100% 精準播放 `flatQueue` 中的下一首曲目。
 */
const syncOrderedQueueToDjPlaylistOnHost = async (
    forceResync = false
): Promise<number> => {
    const djPlIndex = await ensureEditableDjPlaylist();
    const validPaths = latestOrderedQueuePaths.filter(
        (p) =>
            Boolean(p) &&
            !p.startsWith('foobar://') &&
            !p.startsWith('C:\\Music\\DJ_Set\\') &&
            !p.startsWith('local-file-')
    );
    const targetSignature = validPaths
        .map((p) => normalizeAudioPathForMatch(p))
        .join('||');

    if (
        !forceResync &&
        lastSyncedQueueSignature === targetSignature &&
        djPlaylistRowCount === validPaths.length
    ) {
        return djPlIndex;
    }

    try {
        await fb.playlist.clear(djPlIndex);
    } catch {
        // ignore clear error
    }

    // 清空播放清單後，底層播放游標已與列索引脫鉤，標記需透過 playlist.playTrack 重新綁定列索引
    isCurrentTrackBoundToSyncedDjPlaylist = false;
    currentHostPlayingRowIndex = null;
    djPlaylistRowByPath.clear();
    djPlaylistRowCount = 0;

    if (validPaths.length > 0) {
        await addPathsToFoobarPlaylistSilent(djPlIndex, validPaths);
        validPaths.forEach((p, idx) => {
            if (!djPlaylistRowByPath.has(p)) {
                djPlaylistRowByPath.set(p, idx);
            }
            const normP = normalizeAudioPathForMatch(p);
            if (normP && !djPlaylistRowByPath.has(normP)) {
                djPlaylistRowByPath.set(normP, idx);
            }
        });
        djPlaylistRowCount = validPaths.length;
    }

    lastSyncedQueueSignature = targetSignature;
    return djPlIndex;
};

/**
 * 將路徑透過同步 metadb_handle 方式加入 DJ Workflow Set 播放清單並回傳精確的列索引 (絕不觸發 Processing files 彈窗)
 */
const ensureTrackRowInDjPlaylist = async (
    djPlIndex: number,
    path: string,
    queueOrder?: number,
    isPreview?: boolean
): Promise<number> => {
    const normPath = normalizeAudioPathForMatch(path);

    // 若非媒體庫單曲試聽，且指定了佇列順序 (1-based)，檢查該列是否即為目標曲目（支援佇列內重複出現相同曲目的情況）
    if (
        !isPreview &&
        typeof queueOrder === 'number' &&
        queueOrder >= 1 &&
        queueOrder <= latestOrderedQueuePaths.length
    ) {
        const expectedPathAtOrder = normalizeAudioPathForMatch(
            latestOrderedQueuePaths[queueOrder - 1]
        );
        if (expectedPathAtOrder && expectedPathAtOrder === normPath) {
            return queueOrder - 1;
        }
    }

    const existingRow =
        djPlaylistRowByPath.get(path) ??
        (normPath ? djPlaylistRowByPath.get(normPath) : undefined);
    if (existingRow !== undefined) {
        return existingRow;
    }

    // 若因試聽或外部單曲而動態追加了不在 flatQueue 內的曲目，標記簽章需於下次主時間軸播放時重新校準，避免殘留曲目留在清單尾端
    lastSyncedQueueSignature = '__DIRTY_BY_APPEND__';

    if (window.fb2k?.invoke) {
        // 1. 優先使用 playlist.addHandles：直接回傳 countBefore 作為新增曲目的精確 0-based 列索引
        try {
            const handleRes = (await window.fb2k.invoke('playlist.addHandles', {
                playlist: djPlIndex,
                handles: [path],
            })) as {
                success?: boolean;
                addedCount?: number;
                countBefore?: number;
                totalCount?: number;
            };
            if (
                handleRes &&
                handleRes.success !== false &&
                (handleRes.addedCount ?? 0) > 0 &&
                typeof handleRes.countBefore === 'number'
            ) {
                const exactRow = handleRes.countBefore;
                djPlaylistRowByPath.set(path, exactRow);
                if (normPath) djPlaylistRowByPath.set(normPath, exactRow);
                djPlaylistRowCount =
                    typeof handleRes.totalCount === 'number'
                        ? handleRes.totalCount
                        : exactRow + 1;
                return exactRow;
            }
        } catch {
            // fallback
        }

        // [修復問題 2：優先使用 library.addToPlaylist 靜默建立 metadb_handle，避免觸發 Processing files 視窗]
        // 2. 使用 library.addToPlaylist 並查詢實際曲目總數以取得精確列索引
        try {
            const libAddRes = (await window.fb2k.invoke(
                'library.addToPlaylist',
                {
                    playlist: djPlIndex,
                    paths: [path],
                }
            )) as { success?: boolean; added?: number; addedCount?: number };

            if (
                libAddRes &&
                libAddRes.success !== false &&
                (libAddRes.added ?? libAddRes.addedCount ?? 0) > 0
            ) {
                const countRes = (await window.fb2k.invoke(
                    'playlist.getTrackCount',
                    { playlist: djPlIndex }
                )) as { success?: boolean; count?: number };
                if (
                    countRes &&
                    countRes.success !== false &&
                    typeof countRes.count === 'number' &&
                    countRes.count > 0
                ) {
                    const exactRow = countRes.count - 1;
                    djPlaylistRowByPath.set(path, exactRow);
                    if (normPath) djPlaylistRowByPath.set(normPath, exactRow);
                    djPlaylistRowCount = countRes.count;
                    return exactRow;
                }
            }
        } catch {
            // fallback
        }

        // 3. 最後保底（僅針對不在媒體庫之外部檔案）：使用 playlist.addPathsSequential
        try {
            const seqRes = (await window.fb2k.invoke(
                'playlist.addPathsSequential',
                {
                    playlist: djPlIndex,
                    paths: [path],
                }
            )) as { success?: boolean; addedCount?: number };
            if (
                seqRes &&
                seqRes.success !== false &&
                (seqRes.addedCount ?? 1) > 0
            ) {
                const countRes = (await window.fb2k.invoke(
                    'playlist.getTrackCount',
                    { playlist: djPlIndex }
                )) as { success?: boolean; count?: number };
                if (
                    countRes &&
                    countRes.success !== false &&
                    typeof countRes.count === 'number' &&
                    countRes.count > 0
                ) {
                    const exactRow = countRes.count - 1;
                    djPlaylistRowByPath.set(path, exactRow);
                    if (normPath) djPlaylistRowByPath.set(normPath, exactRow);
                    djPlaylistRowCount = countRes.count;
                    return exactRow;
                }
            }
        } catch {
            // 忽略後備錯誤
        }
    }

    const assignedRow = djPlaylistRowCount;
    djPlaylistRowByPath.set(path, assignedRow);
    if (normPath) djPlaylistRowByPath.set(normPath, assignedRow);
    djPlaylistRowCount += 1;
    return assignedRow;
};

let switchingGuardTimer: ReturnType<typeof setTimeout> | null = null;
// 動態紀錄宿主音訊輸出緩衝區秒數（預設 1.0s，並於握手時從 getOutputConfig 自動偵測校準）
let detectedHostBufferSec = 1.0;

export const getDetectedHostBufferSec = (): number => detectedHostBufferSec;

// [修復問題 1 & 問題 2：移除會觸發 process_locations_async (Processing files 閃窗) 及將當前曲目重排為下一首重播的 jitSession.setNext]
// 造成原錯誤的原因：
// 1. 每次點擊時間軸跳轉 (Seek) 或從暫停開始播放時呼叫 `jitSession.setNext({ location: nextPath })`，C++ 底層解析 `location` 路徑字串會觸發 foobar2000 的 `process_locations_async`，導致畫面閃現 `Processing files` 視窗。
// 2. `jitSession` 接管後會覆蓋 `DJ Workflow Set` 原生列索引推進，且 `jitSession:needNext` 與 `jitSession:stateChanged` 事件競爭時以未遞增的舊 `queueOrder` 呼叫 `setNext`，把當前正在播放的曲目自己排為下一首，造成播完後跳回該曲開頭重播。
// 本次修改的目的：
// 1. 首次啟動播放時若宿主有殘留的 jitSession 會話則予以釋放 (detach)，並確保播放順序為 `default`。
// 2. 完全依賴已透過 `library.addToPlaylist` 靜默同步的 `DJ Workflow Set` 原生播放清單列順序 (0, 1, 2...) 與 `fb.player.setStopAfterCurrent` 進行無縫推進與 Silence 結尾精準停住。
let hasCleanedStaleJitSession = false;
let jitRequestCounter = 0;

const makeJitRequestId = (prefix: string): string => {
    jitRequestCounter += 1;
    return `${prefix}-${Date.now()}-${jitRequestCounter}`;
};

const invokeHostRaw = async (
    method: string,
    params: Record<string, unknown> = {}
): Promise<Record<string, unknown> | null> => {
    if (!window.fb2k || typeof window.fb2k.invoke !== 'function') {
        return null;
    }
    try {
        const res = await window.fb2k.invoke(method, params);
        return res && typeof res === 'object'
            ? (res as Record<string, unknown>)
            : null;
    } catch {
        return null;
    }
};

const ensureNativePlaylistProgressionMode = async (): Promise<void> => {
    if (hasCleanedStaleJitSession || !window.fb2k?.invoke) return;
    hasCleanedStaleJitSession = true;
    try {
        const discRes = await invokeHostRaw('jitSession.discover', {});
        const discSession = discRes?.session as
            | Record<string, unknown>
            | null
            | undefined;
        if (
            discSession &&
            typeof discSession.sessionId === 'string' &&
            typeof discSession.ownerEpoch === 'number'
        ) {
            const canResume = Boolean(discSession.canResume);
            const claimRes = await invokeHostRaw('jitSession.claimControl', {
                sessionId: discSession.sessionId,
                mode: canResume ? 'resume' : 'handover',
                ...(canResume
                    ? {}
                    : { expectedOwnerEpoch: discSession.ownerEpoch }),
                requestId: makeJitRequestId('claim-cleanup'),
            });
            if (
                claimRes &&
                claimRes.success !== false &&
                typeof claimRes.controlToken === 'string' &&
                typeof claimRes.revision === 'number'
            ) {
                await invokeHostRaw('jitSession.release', {
                    sessionId: discSession.sessionId,
                    controlToken: claimRes.controlToken,
                    expectedRevision: claimRes.revision,
                    requestId: makeJitRequestId('rel-cleanup'),
                    nativeDisposition: 'detach',
                });
            }
        }
        await invokeHostRaw('playback.setPlaybackOrder', { name: 'default' });
    } catch {
        // 忽略舊版元件未實作之例外
    }
};

/**
 * 在 foobar2000 內精準切換至指定曲目並定位至 offsetSeconds 秒數
 * - 當 shouldPlay === false (暫停狀態下切換上下首或點擊佇列) 時，若為不同曲目則不啟動宿主解碼，徹底消除暫停切歌時的瞬間出聲與彈窗
 * - 當 shouldPlay === true 時，先確保「DJ Workflow Set」與畫布 `flatQueue` 100% 順序同步（無殘留曲目），再透過 `playlist.playTrack` 播放對應列索引！
 */
const playOrCueTrackOnFoobarHost = async (payload: {
    trackId: string;
    path: string;
    title?: string;
    offsetSeconds: number;
    shouldPlay: boolean;
    queueOrder?: number;
    isPreview?: boolean;
    isAutoTransition?: boolean;
    stopAfterCurrent?: boolean;
}): Promise<void> => {
    const {
        path,
        offsetSeconds,
        shouldPlay,
        queueOrder,
        isPreview,
        isAutoTransition,
        stopAfterCurrent,
    } = payload;
    if (
        !path ||
        path.startsWith('foobar://') ||
        path.startsWith('C:\\Music\\DJ_Set\\')
    ) {
        return;
    }

    // [修復問題 3：切換暫停/播放或點擊時間軸跳轉時偶爾往回跳 0.5~1s 的問題]
    // 造成錯誤的原因：`queryHostPlaybackSnapshot` 從 C++ `getPosition()` 回傳的 `path` 帶有 `file://` 前綴並寫入 `currentHostPlayingPath`，
    // 而前端 `track.path` 無 `file://` 前綴，導致先前 `currentHostPlayingPath === path` 永遠為 false，把同首曲目內的 Seek 或恢復播放誤判為「跨曲目切換」，
    // 重新呼叫 `playlist.playTrack`（從 0s 重頭開始）並等待 45ms 後才 Seek，造成短暫回跳。
    // 修改的目的：使用 `normalizeAudioPathForMatch` 正規化比對雙方路徑，同曲目時直接執行微秒級 `fb.player.seek` / `fb.player.play`。
    const normCurrentHostPath = normalizeAudioPathForMatch(
        currentHostPlayingPath
    );
    const normTargetPath = normalizeAudioPathForMatch(path);
    const sameTrackLoaded =
        Boolean(normCurrentHostPath) &&
        Boolean(normTargetPath) &&
        normCurrentHostPath === normTargetPath;

    // 情況 A：目前處於暫停狀態 (!shouldPlay)
    if (!shouldPlay) {
        if (sameTrackLoaded) {
            await fb.player.seek(Math.max(0, offsetSeconds));
        } else {
            // 跨曲目但處於暫停待命：僅重設宿主路徑標記，等使用者按下播放時再啟動該曲目與目標秒數
            currentHostPlayingPath = null;
        }
        return;
    }

    isHostPausedForSilence = false;

    // [修復同張卡片內未設 mix-out 的曲目以 SILENCE 過渡時，於結尾前 1 秒提早放出下一首開頭的問題]
    // 造成原錯誤的原因：foobar2000 預設硬體輸出緩衝區約 1 秒，當 `Stop After Current` 為 false 時，C++ 解碼執行緒在距離顯示結束點約 1 秒處讀到實體 EOF，
    // 會自動跨列將下一首曲目開頭 1 秒解碼塞入輸出緩衝區播出，直到前端 seekhead 到達 timelineEndSec 才呼叫 pauseForSilenceGap。
    // 本次修改的目的：當未處於 jitSession 接管時，呼叫 `fb.player.setStopAfterCurrent(Boolean(stopAfterCurrent))`；
    // 若已處於 jitSession 接管，則透過 syncJitSessionNextTrack 控制是否預排下一首。
    try {
        await fb.player.setStopAfterCurrent(Boolean(stopAfterCurrent));
    } catch {
        // 忽略舊版元件未實作 setStopAfterCurrent 之例外
    }

    // 情況 B：同一首曲目已在宿主載入且要播放，且宿主播放清單已與最新佇列同步，只需直接執行微秒級 Seek 與播放
    const currentValidQueuePaths = latestOrderedQueuePaths.filter(
        (p) =>
            Boolean(p) &&
            !p.startsWith('foobar://') &&
            !p.startsWith('C:\\Music\\DJ_Set\\') &&
            !p.startsWith('local-file-')
    );
    const expectedSignature = currentValidQueuePaths
        .map((p) => normalizeAudioPathForMatch(p))
        .join('||');
    const isQueueSynced =
        isPreview ||
        currentValidQueuePaths.length === 0 ||
        lastSyncedQueueSignature === expectedSignature;

    const expectedRowForQueueOrder =
        !isPreview && typeof queueOrder === 'number' && queueOrder >= 1
            ? queueOrder - 1
            : null;
    const isSameRowBound =
        isPreview ||
        (isCurrentTrackBoundToSyncedDjPlaylist &&
            (expectedRowForQueueOrder === null ||
                currentHostPlayingRowIndex === null ||
                currentHostPlayingRowIndex === expectedRowForQueueOrder));

    const isRepeatedSamePathTransition =
        Boolean(isAutoTransition) &&
        expectedRowForQueueOrder !== null &&
        currentHostPlayingRowIndex !== null &&
        expectedRowForQueueOrder !== currentHostPlayingRowIndex &&
        expectedRowForQueueOrder >= 0 &&
        currentHostPlayingRowIndex >= 0 &&
        normalizeAudioPathForMatch(
            latestOrderedQueuePaths[expectedRowForQueueOrder]
        ) ===
            normalizeAudioPathForMatch(
                latestOrderedQueuePaths[currentHostPlayingRowIndex]
            );

    if (
        sameTrackLoaded &&
        !isRepeatedSamePathTransition &&
        (isAutoTransition || (isQueueSynced && isSameRowBound))
    ) {
        if (expectedRowForQueueOrder !== null) {
            currentHostPlayingRowIndex = expectedRowForQueueOrder;
            isCurrentTrackBoundToSyncedDjPlaylist = !isPreview;
        }
        if (!isAutoTransition || offsetSeconds >= 0.35) {
            await fb.player.seek(Math.max(0, offsetSeconds));
        }
        await fb.player.play();
        return;
    }

    // 情況 C：跨曲目切換（或啟動播放時需先將完整佇列同步寫入 DJ Workflow Set 並綁定播放清單游標）
    if (switchingGuardTimer) {
        clearTimeout(switchingGuardTimer);
        switchingGuardTimer = null;
    }
    isSwitchingTrackOnHost = true;
    currentHostPlayingPath = path;

    try {
        await ensureNativePlaylistProgressionMode();

        // 若為主時間軸播放且有佇列，確保 DJ Workflow Set 已清除所有舊殘留曲目並按 flatQueue 順序完整寫入
        const djPlIndex =
            !isPreview && latestOrderedQueuePaths.length > 0
                ? await syncOrderedQueueToDjPlaylistOnHost()
                : await ensureEditableDjPlaylist();
        const rowIndex = await ensureTrackRowInDjPlaylist(
            djPlIndex,
            path,
            queueOrder,
            isPreview
        );

        if (window.fb2k?.invoke) {
            const playRes = (await window.fb2k.invoke('playlist.playTrack', {
                playlist: djPlIndex,
                index: rowIndex,
            })) as { success?: boolean };

            // 若播放清單索引因外部變動失效，強制重建並重試一次
            if (playRes && playRes.success === false) {
                cachedDjPlaylistIndex = null;
                djPlaylistRowByPath.clear();
                djPlaylistRowCount = 0;
                lastSyncedQueueSignature = '__UNSYNCED__';
                isCurrentTrackBoundToSyncedDjPlaylist = false;
                currentHostPlayingRowIndex = null;
                const retryPlIndex =
                    !isPreview && latestOrderedQueuePaths.length > 0
                        ? await syncOrderedQueueToDjPlaylistOnHost(true)
                        : await ensureEditableDjPlaylist();
                const retryRow = await ensureTrackRowInDjPlaylist(
                    retryPlIndex,
                    path,
                    queueOrder,
                    isPreview
                );
                await window.fb2k.invoke('playlist.playTrack', {
                    playlist: retryPlIndex,
                    index: retryRow,
                });
                currentHostPlayingRowIndex = retryRow;
                isCurrentTrackBoundToSyncedDjPlaylist = !isPreview;
            } else {
                currentHostPlayingRowIndex = rowIndex;
                isCurrentTrackBoundToSyncedDjPlaylist = !isPreview;
            }
        }

        // [修復問題 3：消除切入下首歌時開頭 45ms 後二次 Seek 造成的聲音卡頓]
        if (offsetSeconds >= 0.35) {
            await new Promise((resolve) => setTimeout(resolve, 45));
            await fb.player.seek(offsetSeconds);
        }
    } finally {
        switchingGuardTimer = setTimeout(() => {
            isSwitchingTrackOnHost = false;
            switchingGuardTimer = null;
        }, 350);
    }
};

/**
 * 統一發送指令給 foobar2000 底層宿主（優先透過 foo-webview-sdk / window.fb2k.invoke 執行）
 */
export const sendCommandToHost = (
    action: string,
    payload: Record<string, unknown>
): void => {
    if (action !== 'SET_CROSSFADE_VOLUME') {
        appendBridgeLog('CLIENT_TO_HOST', action, payload);
    }

    if (fb.isAvailable() || window.fb2k) {
        void (async () => {
            try {
                if (action === 'CLIENT_HANDSHAKE_READY') {
                    const verRes = await fb.config.getVersionInfo();
                    const outRes = await fb.config.getOutputConfig();
                    if (outRes && outRes.success !== false) {
                        const outObj = outRes as unknown as Record<
                            string,
                            unknown
                        >;
                        const rawBufMs = Number(
                            outObj.bufferLengthMs ??
                                outObj.bufferMs ??
                                outObj.bufferLength
                        );
                        if (Number.isFinite(rawBufMs) && rawBufMs > 0) {
                            detectedHostBufferSec = Math.max(
                                0.2,
                                Math.min(
                                    5.0,
                                    rawBufMs > 20 ? rawBufMs / 1000 : rawBufMs
                                )
                            );
                        }
                    }
                    const fbVer =
                        verRes &&
                        verRes.success !== false &&
                        'foobar2000Version' in verRes
                            ? String(verRes.foobar2000Version)
                            : 'v2.x';
                    const compVer =
                        verRes &&
                        verRes.success !== false &&
                        'componentVersion' in verRes
                            ? String(verRes.componentVersion)
                            : 'foo_ui_webview2';
                    const devName =
                        outRes &&
                        outRes.success !== false &&
                        'deviceName' in outRes
                            ? String(outRes.deviceName)
                            : 'foobar2000 Native Output';

                    simulateHostEvent({
                        event: 'HOST_HANDSHAKE_ACK',
                        payload: {
                            foobarVersion: fbVer,
                            componentVersion: compVer,
                            audioDevice: devName,
                        },
                    });
                } else if (action === 'CUE_OR_PLAY_TRACK') {
                    await playOrCueTrackOnFoobarHost({
                        trackId: String(payload.trackId || ''),
                        path: String(payload.path || ''),
                        title: String(payload.title || ''),
                        offsetSeconds: Number(payload.offsetSeconds) || 0,
                        shouldPlay: Boolean(payload.shouldPlay),
                        queueOrder:
                            typeof payload.queueOrder === 'number'
                                ? payload.queueOrder
                                : undefined,
                        isPreview: Boolean(payload.isPreview),
                        isAutoTransition: Boolean(payload.isAutoTransition),
                        stopAfterCurrent: Boolean(payload.stopAfterCurrent),
                    });
                } else if (action === 'SET_STOP_AFTER_CURRENT') {
                    try {
                        const enabled = Boolean(payload.enabled);
                        await fb.player.setStopAfterCurrent(enabled);
                    } catch {
                        // 忽略例外
                    }
                } else if (action === 'PAUSE_FOR_SILENCE') {
                    // [修復問題 1.2：進入 Silence 靜音區間時立即清空頻譜與 VU 電平快取，消除靜音期間 VU Meter 閃爍]
                    isHostPausedForSilence = true;
                    currentHostPlayingPath = null;
                    latestSpectrumBins = Array.from({ length: 64 }, () => 0);
                    simulateHostEvent({
                        event: 'HOST_AUDIO_METERS',
                        payload: {
                            vuLevels: {
                                leftPeak: 0,
                                leftRms: 0,
                                rightPeak: 0,
                                rightRms: 0,
                            },
                            spectrumBins: latestSpectrumBins,
                        },
                    });
                    await fb.player.pause();
                } else if (action === 'SET_PLAYBACK_STATE') {
                    const wantPlay = Boolean(payload.isPlaying);
                    const path = String(payload.path || '');
                    const offsetSeconds = Number(payload.offsetSeconds) || 0;

                    if (wantPlay) {
                        isHostPausedForSilence = false;
                        const sameTrackOnHost =
                            Boolean(currentHostPlayingPath) &&
                            Boolean(path) &&
                            normalizeAudioPathForMatch(
                                currentHostPlayingPath
                            ) === normalizeAudioPathForMatch(path);
                        if (path && !sameTrackOnHost) {
                            await playOrCueTrackOnFoobarHost({
                                trackId: String(payload.trackId || ''),
                                path,
                                title: String(payload.title || ''),
                                offsetSeconds,
                                shouldPlay: true,
                                stopAfterCurrent: Boolean(
                                    payload.stopAfterCurrent
                                ),
                            });
                        } else {
                            if (typeof payload.stopAfterCurrent === 'boolean') {
                                try {
                                    await fb.player.setStopAfterCurrent(
                                        payload.stopAfterCurrent
                                    );
                                } catch {
                                    // 忽略例外
                                }
                            }
                            await fb.player.play();
                        }
                    } else {
                        isHostPausedForSilence = false;
                        await fb.player.pause();
                    }
                } else if (action === 'SEEK_TRACK') {
                    const offsetSeconds = Number(payload.offsetSeconds);
                    if (Number.isFinite(offsetSeconds)) {
                        await fb.player.seek(Math.max(0, offsetSeconds));
                    }
                } else if (
                    action === 'SET_MASTER_VOLUME' ||
                    action === 'SET_CROSSFADE_VOLUME'
                ) {
                    const volLinear = Number(payload.volume);
                    if (Number.isFinite(volLinear)) {
                        await fb.player.setVolume(
                            Math.max(0, Math.min(100, Math.round(volLinear * 100)))
                        );
                    }
                } else if (action === 'SET_MUTE') {
                    await fb.player.mute();
                } else if (action === 'WINDOW_MINIMIZE') {
                    if (window.fb2k?.invoke) {
                        await window.fb2k.invoke('window.minimize', {});
                    }
                } else if (action === 'WINDOW_TOGGLE_MAXIMIZE') {
                    if (window.fb2k?.invoke) {
                        await window.fb2k.invoke('window.toggleMaximize', {});
                    }
                } else if (action === 'WINDOW_CLOSE') {
                    if (window.fb2k?.invoke) {
                        await window.fb2k.invoke('window.close', {});
                    }
                } else if (action === 'WINDOW_START_DRAG') {
                    if (window.fb2k?.invoke) {
                        await window.fb2k.invoke('window.startDrag', {});
                    }
                } else if (action === 'WINDOW_SET_POSITION') {
                    const x = Number(payload.x);
                    const y = Number(payload.y);
                    if (
                        window.fb2k?.invoke &&
                        Number.isFinite(x) &&
                        Number.isFinite(y)
                    ) {
                        await window.fb2k.invoke('window.setPosition', {
                            x: Math.round(x),
                            y: Math.round(y),
                        });
                    }
                } else if (action === 'SYNC_PLAYLIST') {
                    // [修復問題 3：當畫布佇列 (flatQueue) 初始化或變動時，即時更新 latestOrderedQueuePaths 並同步至「DJ Workflow Set」]
                    // 造成錯誤的原因：先前畫布節點變動時從未自動呼叫 SYNC_PLAYLIST，導致「DJ Workflow Set」保留舊工作階段殘留曲目且順序與 flatQueue 不符。
                    // 修改的目的：隨時保持 latestOrderedQueuePaths 為最新佇列順序；若目前未在播放中則立即清空並重寫「DJ Workflow Set」，若正在播放則於切歌或啟動播放時無縫同步。
                    const queue = payload.queue as
                        | Array<{ trackId: string; path: string }>
                        | undefined;
                    if (Array.isArray(queue)) {
                        latestOrderedQueuePaths = queue
                            .map((q) => q.path)
                            .filter(Boolean);
                        if (!currentHostPlayingPath && window.fb2k?.invoke) {
                            await syncOrderedQueueToDjPlaylistOnHost();
                        }
                    }
                }
            } catch (err) {
                appendBridgeLog('HOST_TO_CLIENT', `${action}_ERR`, String(err));
            }
        })();
        return;
    }

    if (isFoobarWebView() && window.chrome?.webview) {
        try {
            const message = JSON.stringify({ action, payload });
            window.chrome.webview.postMessage(message);
        } catch {
            // 忽略 postMessage 例外
        }
    } else {
        console.info(`[foobar2000 Bridge Mock] 執行動作: ${action}`, payload);
    }
};

/**
 * 在瀏覽器或實機環境主動觸發一筆來自宿主的事件
 */
export const simulateHostEvent = (message: HostToClientMessage): void => {
    if (typeof window === 'undefined') return;
    window.postMessage(JSON.stringify(message), '*');
};

/**
 * 根據雙聲道波形樣本陣列計算精確的 Peak 與 RMS 電平 (0.0 ~ 1.0)
 */
const computeChannelPeakAndRms = (
    samples: number[] | undefined
): { peak: number; rms: number } => {
    if (!Array.isArray(samples) || samples.length === 0) {
        return { peak: 0, rms: 0 };
    }
    let peak = 0;
    let sumSq = 0;
    for (let i = 0; i < samples.length; i++) {
        const mag = Math.min(1, Math.abs(Number(samples[i]) || 0));
        if (mag > peak) peak = mag;
        sumSq += mag * mag;
    }
    const rms = Math.min(1, Math.sqrt(sumSq / samples.length));
    return {
        peak: Number(peak.toFixed(3)),
        rms: Number(rms.toFixed(3)),
    };
};

/**
 * [Phase 7 & 方向 A] 訂閱來自 foo-webview-sdk 的即時事件、64 軌頻譜與雙聲道立體聲 VU 電平
 */
export const subscribeToHostEvents = (
    onMessage: (msg: HostToClientMessage) => void
): (() => void) => {
    if (typeof window === 'undefined') return () => {};

    const parseAndDispatch = (rawData: unknown) => {
        try {
            const parsed = (
                typeof rawData === 'string' ? JSON.parse(rawData) : rawData
            ) as Partial<HostToClientMessage>;
            if (parsed && typeof parsed.event === 'string' && parsed.payload) {
                if (parsed.event !== 'HOST_AUDIO_METERS') {
                    appendBridgeLog(
                        'HOST_TO_CLIENT',
                        parsed.event,
                        parsed.payload
                    );
                }
                onMessage(parsed as HostToClientMessage);
            }
        } catch {
            // 忽略非宿主協定之一般訊息
        }
    };

    const webviewListener = (e: { data: unknown }) => parseAndDispatch(e.data);
    const windowListener = (e: MessageEvent) => parseAndDispatch(e.data);

    window.chrome?.webview?.addEventListener?.('message', webviewListener);
    window.addEventListener('message', windowListener);

    const sdkUnsubscribers: Array<() => void> = [];
    let vuPollingTimer: ReturnType<typeof setInterval> | null = null;
    let hostIsPlaying = false;

    if (fb.isAvailable() || window.fb2k) {
        try {
            // 1. 訂閱播放狀態變更 (playback:stateChanged)
            // 注意：切歌過渡期間 (isSwitchingTrackOnHost) 或 Silence 靜音過渡期間 (isHostPausedForSilence) 忽略暫態事件
            // [修復註記] 一併轉發宿主事件附帶的 `data.position` 秒數，避免狀態變更時漏失當前秒數
            const unsubState = fb.on('playback:stateChanged', (data) => {
                hostIsPlaying =
                    data.state === 'playing' && !isHostPausedForSilence;

                if (data.state !== 'playing') {
                    latestSpectrumBins = Array.from({ length: 64 }, () => 0);
                    onMessage({
                        event: 'HOST_AUDIO_METERS',
                        payload: {
                            vuLevels: {
                                leftPeak: 0,
                                leftRms: 0,
                                rightPeak: 0,
                                rightRms: 0,
                            },
                            spectrumBins: latestSpectrumBins,
                        },
                    });
                }

                if (
                    isSwitchingTrackOnHost ||
                    (isHostPausedForSilence && data.state !== 'playing')
                ) {
                    return;
                }
                if (data.state === 'stopped') {
                    currentHostPlayingPath = null;
                }
                const posSec =
                    typeof data.position === 'number' &&
                    Number.isFinite(data.position) &&
                    data.position >= 0
                        ? data.position
                        : undefined;
                onMessage({
                    event: 'HOST_PLAYBACK_STATE',
                    payload: {
                        isPlaying: data.state === 'playing',
                        trackTimeSeconds: posSec,
                        hostState: data.state,
                    },
                });
            });
            sdkUnsubscribers.push(unsubState);

            // 1b. [修復最小化背景自然切歌 & 修復問題 2：支援頂層與巢狀 track 結構並補齊列索引]
            // 造成錯誤的原因：
            // 1. `playback:trackChanged` 在不同觸發情境下，曲目資訊可能位於頂層 `data` 或巢狀 `data.track`，若未取到完整路徑會導致 `findMatchingQueueItemFromHost` 誤判。
            // 2. 當 C++ 在背景自然推進至下一列時，需同步更新 `currentHostPlayingRowIndex` 與 `currentHostPlayingPath`，避免前端計時器喚醒時重複呼叫 `playTrack`。
            // 修改的目的：同時解析頂層與巢狀 `track` 屬性，若事件缺少路徑則主動查詢 `getCurrentTrackIndex(true)` 補齊後再派發 `HOST_TRACK_CHANGED`。
            const unsubTrackChanged = fb.on('playback:trackChanged', (data) => {
                hostIsPlaying = true;
                const rawObj = (data ?? {}) as unknown as Record<
                    string,
                    unknown
                >;
                const nestedTrack =
                    rawObj.track && typeof rawObj.track === 'object'
                        ? (rawObj.track as Record<string, unknown>)
                        : null;

                const pickStr = (key: string): string | undefined => {
                    const topVal = rawObj[key];
                    if (typeof topVal === 'string' && topVal.trim()) {
                        return topVal.trim();
                    }
                    const nestedVal = nestedTrack?.[key];
                    if (typeof nestedVal === 'string' && nestedVal.trim()) {
                        return nestedVal.trim();
                    }
                    return undefined;
                };

                const pickNum = (key: string): number | undefined => {
                    const topVal = Number(rawObj[key]);
                    if (Number.isFinite(topVal)) return topVal;
                    const nestedVal = Number(nestedTrack?.[key]);
                    if (Number.isFinite(nestedVal)) return nestedVal;
                    return undefined;
                };

                const absPath = pickStr('absolutePath');
                const rawPath = pickStr('path');
                const handleStr = pickStr('handle');
                const bestPath = absPath || rawPath || handleStr || '';
                const explicitIndex =
                    pickNum('index') ?? pickNum('trackIndex') ?? null;

                // [修復問題 1：當佇列包含連續相同曲目 (如 A -> B -> B') 時，自然切歌至下一列應優先匹配 currentHostPlayingRowIndex + 1]
                // 造成原錯誤的原因：`djPlaylistRowByPath` 針對相同檔案路徑僅保留第一個列索引，當 B 播完自然推進至下一列 B' 時，
                // 若只查 `djPlaylistRowByPath.get(normBest)` 會誤回傳前一列索引，導致列索引停留在前一首 B。
                // 本次修改的目的：當未附帶 explicitIndex 時，優先檢查 `currentHostPlayingRowIndex + 1` 是否即為該曲目路徑，若是則精準遞增至下一列索引。
                const inferCurrentOrNextRowIndex = (
                    rawP: string,
                    normP: string
                ): number | null => {
                    if (explicitIndex !== null && explicitIndex >= 0) {
                        return explicitIndex;
                    }
                    if (
                        currentHostPlayingRowIndex !== null &&
                        currentHostPlayingRowIndex + 1 <
                            latestOrderedQueuePaths.length
                    ) {
                        const nextCandidateNorm = normalizeAudioPathForMatch(
                            latestOrderedQueuePaths[
                                currentHostPlayingRowIndex + 1
                            ]
                        );
                        if (
                            nextCandidateNorm &&
                            normP &&
                            nextCandidateNorm === normP
                        ) {
                            return currentHostPlayingRowIndex + 1;
                        }
                    }
                    return (
                        djPlaylistRowByPath.get(rawP) ??
                        (normP ? djPlaylistRowByPath.get(normP) : undefined) ??
                        null
                    );
                };

                if (bestPath) {
                    currentHostPlayingPath = bestPath;
                    const normBest = normalizeAudioPathForMatch(bestPath);
                    const mappedRow = inferCurrentOrNextRowIndex(
                        bestPath,
                        normBest
                    );
                    if (mappedRow !== null) {
                        currentHostPlayingRowIndex = mappedRow;
                        isCurrentTrackBoundToSyncedDjPlaylist = true;
                    }
                }

                if (isSwitchingTrackOnHost) {
                    return;
                }

                if (bestPath) {
                    const normBest = normalizeAudioPathForMatch(bestPath);
                    const resolvedRowIndex =
                        currentHostPlayingRowIndex ??
                        inferCurrentOrNextRowIndex(bestPath, normBest);
                    const durVal = pickNum('duration');
                    const posVal = pickNum('position');

                    // 造成原錯誤的原因：根據 foo_ui_webview2 官方文件，`playback:trackChanged` 事件 payload 為 `Track` 結構，不包含 `position` 欄位；
                    // 先前當 `posVal === undefined` 時直接預設填 `0`，導致背景切歌或延遲收到事件時把已播放中的曲目誤判為 0.0s（甚至觸發 seekTrack 跳回開頭）。
                    // 本次修改的目的：當事件未帶 `position` 時，立即呼叫 `fb.player.getPosition()` 並加上官方 `hostTime` IPC 延遲補償取得真實播放秒數。
                    if (posVal !== undefined && posVal >= 0) {
                        onMessage({
                            event: 'HOST_TRACK_CHANGED',
                            payload: {
                                path: bestPath,
                                absolutePath: absPath,
                                handle: handleStr,
                                title: pickStr('title'),
                                artist: pickStr('artist'),
                                album: pickStr('album'),
                                duration:
                                    durVal !== undefined && durVal > 0
                                        ? durVal
                                        : undefined,
                                position: posVal,
                                playlistRowIndex: resolvedRowIndex,
                            },
                        });
                    } else {
                        void fb.player
                            .getPosition()
                            .then((posRes) => {
                                if (isSwitchingTrackOnHost) return;
                                let livePos = 0;
                                if (posRes && posRes.success !== false) {
                                    const rawPos = Number(
                                        (
                                            posRes as unknown as Record<
                                                string,
                                                unknown
                                            >
                                        ).position
                                    );
                                    const hostTime = Number(
                                        (
                                            posRes as unknown as Record<
                                                string,
                                                unknown
                                            >
                                        ).hostTime
                                    );
                                    if (Number.isFinite(rawPos) && rawPos >= 0) {
                                        const ipcLatencySec =
                                            Number.isFinite(hostTime) &&
                                            hostTime > 0
                                                ? Math.max(
                                                      0,
                                                      Math.min(
                                                          1.5,
                                                          (Date.now() -
                                                              hostTime) /
                                                              1000
                                                      )
                                                  )
                                                : 0;
                                        livePos = rawPos + ipcLatencySec;
                                    }
                                }
                                onMessage({
                                    event: 'HOST_TRACK_CHANGED',
                                    payload: {
                                        path: bestPath,
                                        absolutePath: absPath,
                                        handle: handleStr,
                                        title: pickStr('title'),
                                        artist: pickStr('artist'),
                                        album: pickStr('album'),
                                        duration:
                                            durVal !== undefined && durVal > 0
                                                ? durVal
                                                : undefined,
                                        position: livePos,
                                        playlistRowIndex: resolvedRowIndex,
                                    },
                                });
                            })
                            .catch(() => {
                                if (isSwitchingTrackOnHost) return;
                                onMessage({
                                    event: 'HOST_TRACK_CHANGED',
                                    payload: {
                                        path: bestPath,
                                        absolutePath: absPath,
                                        handle: handleStr,
                                        title: pickStr('title'),
                                        artist: pickStr('artist'),
                                        album: pickStr('album'),
                                        duration:
                                            durVal !== undefined && durVal > 0
                                                ? durVal
                                                : undefined,
                                        position: 0,
                                        playlistRowIndex: resolvedRowIndex,
                                    },
                                });
                            });
                    }
                } else {
                    // 若事件當下 payload 未附帶路徑，立即查詢宿主當前播放曲目快照再派發，絕不傳遞空路徑造成跳回第一首
                    void bridgeApi.queryHostPlaybackSnapshot().then((snap) => {
                        if (isSwitchingTrackOnHost || !snap.supported) return;
                        const snapBestPath =
                            snap.absolutePath ||
                            snap.path ||
                            snap.handle ||
                            '';
                        if (!snapBestPath) return;
                        onMessage({
                            event: 'HOST_TRACK_CHANGED',
                            payload: {
                                path: snapBestPath,
                                absolutePath: snap.absolutePath ?? undefined,
                                handle: snap.handle ?? undefined,
                                title: snap.title ?? undefined,
                                artist: snap.artist ?? undefined,
                                album: snap.album ?? undefined,
                                duration: snap.duration ?? undefined,
                                position: snap.playbackTime ?? 0,
                                playlistRowIndex: snap.playlistRowIndex,
                            },
                        });
                    });
                }
            });
            sdkUnsubscribers.push(unsubTrackChanged);

            // 1c. 訂閱官方 window:stateChanged 與 jitSession:stateChanged 事件
            const unsubWindowState = fb.on('window:stateChanged', (data) => {
                const rawObj = (data ?? {}) as unknown as Record<
                    string,
                    unknown
                >;
                onMessage({
                    event: 'HOST_WINDOW_STATE_CHANGED',
                    payload: {
                        isMinimized: Boolean(rawObj.isMinimized),
                        isActive: Boolean(rawObj.isActive),
                    },
                });
            });
            sdkUnsubscribers.push(unsubWindowState);

            // 2. 訂閱媒體庫變更事件
            const unsubLibInit = fb.on('library:initialized', () => {
                void fetchTracksFromNativeFoobarHost().then((tracks) => {
                    if (tracks && tracks.length > 0) {
                        onMessage({
                            event: 'HOST_LIBRARY_UPDATED',
                            payload: { tracks },
                        });
                    }
                });
            });
            sdkUnsubscribers.push(unsubLibInit);

            // 3. 訂閱 64 軌即時頻譜數據 (fb.audio.subscribeSpectrum)
            // [修復問題 1.2：在 Silence 靜音暫停期間 (isHostPausedForSilence) 忽略殘留頻譜事件，避免把 hostIsPlaying 重新設回 true]
            const unsubSpectrum = fb.audio.subscribeSpectrum(
                (data) => {
                    if (isHostPausedForSilence) {
                        return;
                    }
                    hostIsPlaying = true;
                    if (
                        Array.isArray(data.spectrum) &&
                        data.spectrum.length > 0
                    ) {
                        latestSpectrumBins = data.spectrum
                            .slice(0, 64)
                            .map((v) =>
                                Math.max(0, Math.min(1, Number(v) || 0))
                            );
                    }
                },
                {
                    fftSize: 2048,
                    bands: 64,
                    fps: 30,
                    scale: 'weighted',
                    backgroundThrottle: false,
                }
            );
            sdkUnsubscribers.push(unsubSpectrum);

            // 4. 啟動 30FPS 雙聲道立體聲波形與頻譜輪詢器 (透過 audio.getWaveform 取得真實 Left/Right Peak & RMS 電平)
            // [修復問題 1.2：解決在 Silence 靜音區間期間 VU Meter 不正常閃爍並顯示 mix-out 點瞬間音量的問題]
            // 造成錯誤的原因：
            // 1. 先前 vuPollingTimer 未檢查 `isHostPausedForSilence`，而 foo_ui_webview2 的 `audio.getWaveform` 在暫停狀態下仍會讀取暫停游標位置（即 mix-out 點瞬間）的 40ms 波形樣本。
            // 2. 導致每 40ms 就會發送一次帶有 mix-out 瞬間音量的 `HOST_AUDIO_METERS`，與前端每 100ms 歸零的 `advancePlaybackTick` 互相拉鋸造成閃爍。
            // 修改的目的：只要處於 `isHostPausedForSilence` 或 `!hostIsPlaying`，完全停止輪詢與派發 `HOST_AUDIO_METERS`，保持靜音區間 VU Meter 穩定為 0。
            vuPollingTimer = setInterval(() => {
                if (
                    !hostIsPlaying ||
                    isHostPausedForSilence ||
                    !window.fb2k?.invoke
                ) {
                    return;
                }

                void (async () => {
                    try {
                        const wfRes = (await window.fb2k!.invoke(
                            'audio.getWaveform',
                            {
                                duration: 0.04,
                                signed: false,
                                channels: 'stereo',
                                points: 64,
                            }
                        )) as {
                            success?: boolean;
                            left?: number[];
                            right?: number[];
                            waveform?: number[];
                        };

                        if (!hostIsPlaying || isHostPausedForSilence) {
                            return;
                        }

                        let vuLevels: StereoVULevels;
                        if (
                            wfRes?.success &&
                            (Array.isArray(wfRes.left) ||
                                Array.isArray(wfRes.waveform))
                        ) {
                            const leftStats = computeChannelPeakAndRms(
                                wfRes.left ?? wfRes.waveform
                            );
                            const rightStats = computeChannelPeakAndRms(
                                wfRes.right ?? wfRes.left ?? wfRes.waveform
                            );
                            vuLevels = {
                                leftPeak: leftStats.peak,
                                leftRms: leftStats.rms,
                                rightPeak: rightStats.peak,
                                rightRms: rightStats.rms,
                            };
                        } else {
                            // 若無雙聲道波形，則由 64 軌頻譜能量推算 L/R 電平
                            const avg =
                                latestSpectrumBins.reduce(
                                    (acc, v) => acc + v,
                                    0
                                ) / Math.max(1, latestSpectrumBins.length);
                            const peak = Math.min(1, avg * 1.55);
                            vuLevels = {
                                leftPeak: Number(peak.toFixed(3)),
                                leftRms: Number((avg * 0.88).toFixed(3)),
                                rightPeak: Number(
                                    Math.min(1, peak * 0.97).toFixed(3)
                                ),
                                rightRms: Number((avg * 0.85).toFixed(3)),
                            };
                        }

                        // 若 subscribeSpectrum 事件尚未抵達，主動拉取一次 audio.getSpectrum
                        const hasSpectrumEnergy = latestSpectrumBins.some(
                            (v) => v > 0.001
                        );
                        if (!hasSpectrumEnergy) {
                            const specRes = await fb.audio.getSpectrum();
                            if (
                                specRes &&
                                specRes.success !== false &&
                                'spectrum' in specRes &&
                                Array.isArray(specRes.spectrum)
                            ) {
                                latestSpectrumBins = specRes.spectrum
                                    .slice(0, 64)
                                    .map((v) =>
                                        Math.max(0, Math.min(1, Number(v) || 0))
                                    );
                            }
                        }

                        if (!hostIsPlaying || isHostPausedForSilence) {
                            return;
                        }

                        onMessage({
                            event: 'HOST_AUDIO_METERS',
                            payload: {
                                vuLevels,
                                spectrumBins: latestSpectrumBins,
                            },
                        });
                    } catch {
                        // 忽略單幀輪詢例外
                    }
                })();
            }, 40);
        } catch (err) {
            appendBridgeLog('HOST_TO_CLIENT', 'SDK_EVENT_SUB_ERR', String(err));
        }
    }

    return () => {
        if (vuPollingTimer) {
            clearInterval(vuPollingTimer);
        }
        window.chrome?.webview?.removeEventListener?.(
            'message',
            webviewListener
        );
        window.removeEventListener('message', windowListener);
        for (const unsub of sdkUnsubscribers) {
            try {
                unsub();
            } catch {
                // 忽略退訂例外
            }
        }
    };
};

/**
 * 將使用者從本地資料夾選取的音訊檔案清單 (FileList / File[]) 轉換為標準 Track 陣列
 */
export const parseLocalAudioFilesToTracks = (files: File[]): Track[] => {
    const validFiles = files.filter(
        (f) => f.type.startsWith('audio/') || isPlayableAudioFileName(f.name)
    );

    return validFiles.map((file, idx) => {
        const nameWithoutExt = file.name.replace(/\.[^/.]+$/, '');
        const parts = nameWithoutExt
            .replace(/^\d+[\s._-]+/, '')
            .split(/\s+-\s+/);
        const artist = parts.length >= 2 ? parts[0].trim() : 'Local Artist';
        const title =
            parts.length >= 2
                ? parts.slice(1).join(' - ').trim()
                : nameWithoutExt;

        const relPath =
            (file as File & { webkitRelativePath?: string })
                .webkitRelativePath || '';
        const pathSegments = relPath.split('/').filter(Boolean);
        const album =
            pathSegments.length >= 2
                ? pathSegments[pathSegments.length - 2]
                : 'Local Folder Import';
        const ext = file.name.split('.').pop()?.toUpperCase() || 'AUDIO';

        return mapSdkTrackToAppTrack(
            {
                handle: `local-file-${idx + 1}`,
                path: relPath || file.name,
                absolutePath: relPath || file.name,
                title,
                artist,
                album,
                duration: 215,
                genre: 'Local Library',
                rating: 5,
                codec: ext,
                sampleRate: 44100,
            },
            idx
        );
    });
};

/**
 * 開發模式與離線預覽專用的模擬 DJ 媒體庫曲目清單
 */
export const MOCK_LIBRARY_TRACKS: Track[] = [
    {
        id: 'track-101',
        albumId: 'album-neon-odyssey',
        title: 'Midnight Horizon',
        artist: 'Aero Pulse',
        album: 'Neon Odyssey',
        duration: 215,
        bpm: 126,
        key: '8A',
        genre: 'Melodic Techno',
        rating: 5,
        path: 'C:\\Music\\DJ_Set\\01_Midnight_Horizon.flac',
        coverUrl: neonOdysseyCover,
        format: 'FLAC / 24-bit / 96kHz',
        lrc: '[00:00.00] 🎵 Intro: Synth Arpeggio Rising (126 BPM)\n[00:04.50] ⚡ Mix-In: Deep Sub-Bass Drop & Neon Pads\n[00:12.00] Drifting across the midnight cyber horizon\n[00:20.00] Pulse of the city lights echoing in 8A\n[00:30.00] Filter sweep opening into main melodic lead\n[01:00.00] Peak Breakdown: Crystalline synth harmony',
        waveform: [0.2, 0.5, 0.8, 0.9, 0.6, 0.4, 0.85, 0.95, 0.7, 0.3],
        cuePoints: { mixIn: 4.5, mixOut: 202.0 },
    },
    {
        id: 'track-102',
        albumId: 'album-neon-odyssey',
        title: 'Cybernetic Dreams',
        artist: 'Aero Pulse',
        album: 'Neon Odyssey',
        duration: 242,
        bpm: 128,
        key: '8A',
        genre: 'Progressive House',
        rating: 4,
        path: 'C:\\Music\\DJ_Set\\02_Cybernetic_Dreams.flac',
        coverUrl: neonOdysseyCover,
        format: 'FLAC / 24-bit / 96kHz',
        lrc: '[00:00.00] 🎵 Progressive Four-on-the-Floor Kick\n[00:02.00] ⚡ Electric dreams wired in neon circuits\n[00:14.00] Chasing the horizon through digital rain\n[00:28.00] Rolling bassline locked in harmonic sync',
        waveform: [0.3, 0.6, 0.75, 0.8, 0.9, 0.5, 0.7, 0.95, 0.8, 0.4],
        cuePoints: { mixIn: 2.0, mixOut: 230.0 },
    },
    {
        id: 'track-103',
        albumId: 'album-neon-odyssey',
        title: 'Solar Flare',
        artist: 'Aero Pulse',
        album: 'Neon Odyssey',
        duration: 198,
        bpm: 128,
        key: '9A',
        genre: 'Tech House',
        rating: 5,
        path: 'C:\\Music\\DJ_Set\\03_Solar_Flare.flac',
        coverUrl: neonOdysseyCover,
        format: 'FLAC / 24-bit / 96kHz',
        lrc: '[00:00.00] 🎵 Crisp Tech Percussion & Hi-Hat Groove\n[00:06.00] ⚡ Solar flare igniting the mainstage floor\n[00:18.00] Magnetic rhythm rising into 9A harmonic lift',
        waveform: [0.4, 0.7, 0.9, 0.85, 0.5, 0.6, 0.9, 0.8, 0.6, 0.2],
        cuePoints: { mixIn: 6.0, mixOut: 188.0 },
    },
    {
        id: 'track-104',
        albumId: 'album-underground',
        title: 'Velvet Shadows',
        artist: 'Deep Mode',
        album: 'Underground Vol. 2',
        duration: 260,
        bpm: 124,
        key: '7A',
        genre: 'Deep House',
        rating: 4,
        path: 'C:\\Music\\DJ_Set\\04_Velvet_Shadows.flac',
        coverUrl: undergroundVol2Cover,
        format: 'FLAC / 16-bit / 44.1kHz',
        lrc: '[00:00.00] 🎵 Subterranean Warm Analog Chords\n[00:08.00] ⚡ Moving through velvet shadows in the vault\n[00:22.00] Late night warehouse echo & deep sub groove',
        waveform: [0.15, 0.4, 0.6, 0.7, 0.65, 0.5, 0.75, 0.8, 0.55, 0.25],
        cuePoints: { mixIn: 8.0, mixOut: 245.0 },
    },
    {
        id: 'track-105',
        albumId: 'album-prism',
        title: 'Electric Mirage',
        artist: 'Kinetix',
        album: 'Prism',
        duration: 230,
        bpm: 130,
        key: '8B',
        genre: 'Trance',
        rating: 5,
        path: 'C:\\Music\\DJ_Set\\05_Electric_Mirage.flac',
        coverUrl: prismKinetixCover,
        format: 'FLAC / 24-bit / 96kHz',
        lrc: '[00:00.00] 🎵 Euphoric Trance Pluck & Supersaw Swell\n[00:01.50] ⚡ Light refracting through the crystal prism\n[00:15.00] Soaring into an electric mirage of sound',
        waveform: [0.25, 0.55, 0.85, 1.0, 0.4, 0.3, 0.9, 1.0, 0.75, 0.35],
        cuePoints: { mixIn: 1.5, mixOut: 220.0 },
    },
    {
        id: 'track-106',
        albumId: 'album-frostbite',
        title: 'Subzero Bass',
        artist: 'Kryo',
        album: 'Frostbite',
        duration: 185,
        bpm: 140,
        key: '2A',
        genre: 'Bass / Dubstep',
        rating: 3,
        path: 'C:\\Music\\DJ_Set\\06_Subzero_Bass.flac',
        coverUrl: frostbiteKryoCover,
        format: 'FLAC / 24-bit / 48kHz',
        lrc: '[00:00.00] ⚡ Subzero Siren & Half-Time Heavy Snare\n[00:07.00] Shattering the ice with 140 BPM bass shockwaves\n[00:18.00] Arctic wobble synthesis & sub-frequency pressure',
        waveform: [0.5, 0.9, 0.95, 0.3, 0.8, 1.0, 0.9, 0.4, 0.85, 0.5],
        cuePoints: { mixIn: 0.0, mixOut: 175.0 },
    },
];

/**
 * 橋接通訊 API 服務
 */
export const bridgeApi = {
    sendHandshakePing(): void {
        sendCommandToHost('CLIENT_HANDSHAKE_READY', {
            clientVersion: '1.0.0-phase7',
            protocol: 'foo-webview-sdk-v2.2',
            timestamp: Date.now(),
        });
    },

    async getLibraryTracks(): Promise<Track[]> {
        if (isFoobarWebView()) {
            const nativeTracks = await fetchTracksFromNativeFoobarHost();
            if (nativeTracks && nativeTracks.length > 0) {
                return nativeTracks;
            }
            // [2d 情境 A] 若 Media Library 未設定 (0 首)，但存在可用 Playlist，則載入第一個/活動中 Playlist 的曲目
            const playlists = await fetchFoobarPlaylists();
            if (playlists.length > 0) {
                const targetPl =
                    playlists.find((p) => p.isActive) ?? playlists[0];
                const plTracks = await fetchTracksFromFoobarPlaylist(
                    targetPl.index
                );
                return plTracks ?? [];
            }
            // [2d 情境 B] 既無 Media Library 亦無任何 Playlist：回傳空陣列 []，絕不退回模擬測試曲目
            return [];
        }
        return new Promise((resolve) => {
            setTimeout(() => {
                resolve(MOCK_LIBRARY_TRACKS);
            }, 150);
        });
    },

    syncPlaylistToFoobar(
        flatQueue: Array<{ trackId: string; path: string }>
    ): void {
        sendCommandToHost('SYNC_PLAYLIST', { queue: flatQueue });
    },

    /**
     * 在宿主切換至指定曲目並 Seek 至指定秒數（支援跨曲目零彈窗切換與同曲目內微秒級 Seek）
     */
    cueOrPlayTrack(
        track: Track,
        offsetSeconds: number,
        shouldPlay: boolean,
        options?: {
            queueOrder?: number;
            isPreview?: boolean;
            isAutoTransition?: boolean;
            stopAfterCurrent?: boolean;
        }
    ): void {
        sendCommandToHost('CUE_OR_PLAY_TRACK', {
            trackId: track.id,
            path: track.path,
            title: track.title,
            offsetSeconds,
            shouldPlay,
            queueOrder: options?.queueOrder,
            isPreview: options?.isPreview,
            isAutoTransition: options?.isAutoTransition,
            stopAfterCurrent: options?.stopAfterCurrent,
        });
    },

    /**
     * 動態設定 foobar2000 宿主是否在當前曲目播放至實體 EOF 時自動停止（防止 SILENCE 過渡前 1 秒預解碼下一首）
     */
    setStopAfterCurrent(enabled: boolean): void {
        sendCommandToHost('SET_STOP_AFTER_CURRENT', { enabled });
    },

    /**
     * [新增功能 4] 彈出原生「另存新檔」對話框讓使用者選擇儲存位置並寫入檔案 (.json / .m3u8)
     * - 在 foobar2000 WebView2 環境中透過 `dialog.saveFile` 與 `file.write` 執行原生儲存
     * - 回傳 `{ handled: true, saved: boolean, filePath?: string }`；若非 WebView2 環境則回傳 `{ handled: false, saved: false }` 交由瀏覽器 File System Access API 處理
     */
    async saveFileWithDialog(options: {
        title: string;
        defaultName: string;
        content: string;
        filters: Array<{ name: string; extensions: string[] }>;
    }): Promise<{
        handled: boolean;
        saved: boolean;
        canceled?: boolean;
        filePath?: string;
        error?: string;
    }> {
        if (window.fb2k?.invoke) {
            try {
                const dlgRes = (await window.fb2k.invoke('dialog.saveFile', {
                    title: options.title,
                    defaultName: options.defaultName,
                    filters: options.filters,
                })) as {
                    success?: boolean;
                    canceled?: boolean;
                    filePath?: string;
                    error?: string;
                };

                if (dlgRes?.canceled) {
                    return { handled: true, saved: false, canceled: true };
                }
                if (dlgRes?.success && dlgRes.filePath) {
                    const writeRes = (await window.fb2k.invoke('file.write', {
                        path: dlgRes.filePath,
                        content: options.content,
                        encoding: 'utf-8',
                        atomic: true,
                        createDirs: true,
                    })) as { success?: boolean; error?: string };

                    if (writeRes?.success !== false) {
                        return {
                            handled: true,
                            saved: true,
                            filePath: dlgRes.filePath,
                        };
                    }
                    return {
                        handled: true,
                        saved: false,
                        error: writeRes?.error || '寫入檔案失敗',
                    };
                }
            } catch {
                // 若宿主未開放 dialog.saveFile，交由前端 showSaveFilePicker / 瀏覽器下載備援處理
            }
        }
        return { handled: false, saved: false };
    },

    /**
     * 當進入兩首曲目之間的 SILENCE 靜音過渡區間時，暫停 foobar2000 音訊輸出但保持 Master Timeline 繼續推進
     */
    pauseForSilenceGap(): void {
        sendCommandToHost('PAUSE_FOR_SILENCE', {});
    },

    /**
     * 當處於 CROSSFADE 交叉淡化過渡區間時，動態調整 foobar2000 輸出音量 (0.0 ~ 1.0)
     */
    setCrossfadeOutputVolume(effectiveVolume: number): void {
        sendCommandToHost('SET_CROSSFADE_VOLUME', { volume: effectiveVolume });
    },

    /**
     * 視窗控制：最小化、最大化/還原、關閉視窗、原生視窗拖移與座標持久化
     */
    minimizeWindow(): void {
        sendCommandToHost('WINDOW_MINIMIZE', {});
    },

    toggleMaximizeWindow(): void {
        sendCommandToHost('WINDOW_TOGGLE_MAXIMIZE', {});
    },

    closeWindow(): void {
        sendCommandToHost('WINDOW_CLOSE', {});
    },

    startWindowDrag(): void {
        if (!isFoobarWebView()) return;
        sendCommandToHost('WINDOW_START_DRAG', {});
    },

    setWindowPosition(x: number, y: number): void {
        if (!isFoobarWebView()) return;
        sendCommandToHost('WINDOW_SET_POSITION', { x, y });
    },

    async getWindowBounds(): Promise<{
        x: number;
        y: number;
        width: number;
        height: number;
    } | null> {
        if (!isFoobarWebView() || !window.fb2k?.invoke) return null;
        try {
            const res = (await window.fb2k.invoke('window.getBounds', {})) as {
                x?: number;
                y?: number;
                width?: number;
                height?: number;
            };
            if (
                res &&
                typeof res.x === 'number' &&
                typeof res.y === 'number' &&
                Number.isFinite(res.x) &&
                Number.isFinite(res.y)
            ) {
                return {
                    x: Math.round(res.x),
                    y: Math.round(res.y),
                    width: Math.round(res.width ?? 0),
                    height: Math.round(res.height ?? 0),
                };
            }
        } catch {
            // 忽略面板模式或無原生視窗例外
        }
        return null;
    },

    seekTrack(trackId: string, offsetSeconds: number): void {
        sendCommandToHost('SEEK_TRACK', { trackId, offsetSeconds });
    },

    /**
     * 主動查詢 foobar2000 C++ 宿主的即時播放狀態（供視窗從最小化還原或重掛載時，精準對齊背景持續播放的秒數與曲目）
     * [修復最小化後開啟視窗回溯至前一首歌尾部的問題]
     * 造成錯誤的原因：
     * 1. 在 `foo-webview-sdk v2.2` 中，`fb.player.getState()`（對應 C++ `playback.getState`）只回傳 `{ state, canSeek, canPause }`，
     *    完全不包含播放秒數 (`position`) 與當前曲目 (`track` / `path`)，導致先前 `playbackTime` 永遠為 `null` 且 `path` 永遠是舊曲目。
     * 修改的目的：
     * 並行呼叫 `fb.player.getState()`、`fb.player.getPosition()`、`fb.player.getCurrentTrackIndex(true)` 與 `fb.player.getCurrentTrack()`，
     * 同時取得真實播放秒數（含 `hostTime` 毫秒級延遲補償）、當前播放曲目的完整路徑 (`absolutePath` / `path` / `handle`) 與播放清單列索引 (`playlistRowIndex`)。
     */
    async queryHostPlaybackSnapshot(): Promise<{
        supported: boolean;
        isPlaying: boolean;
        isPaused: boolean;
        isStopped: boolean;
        playbackTime: number | null;
        duration: number | null;
        path: string | null;
        absolutePath: string | null;
        handle: string | null;
        title: string | null;
        artist: string | null;
        album: string | null;
        playlistRowIndex: number | null;
    }> {
        if (!fb.isAvailable() && !window.fb2k) {
            return {
                supported: false,
                isPlaying: false,
                isPaused: false,
                isStopped: false,
                playbackTime: null,
                duration: null,
                path: null,
                absolutePath: null,
                handle: null,
                title: null,
                artist: null,
                album: null,
                playlistRowIndex: null,
            };
        }

        try {
            // 造成原錯誤的原因：先前每次對時皆同時發起 4 個 IPC 請求（包含重複的 getCurrentTrackIndex(true) 與 getCurrentTrack()），增加主執行緒佇列延遲。
            // 本次修改的目的：精簡為 3 個核心 IPC 請求，僅當 getCurrentTrackIndex(true) 未附帶 track 時才補查 getCurrentTrack()，降低對時延遲。
            const [stateSettled, posSettled, idxSettled] =
                await Promise.allSettled([
                    fb.player.getState(),
                    fb.player.getPosition(),
                    fb.player.getCurrentTrackIndex(true),
                ]);

            const stateRes =
                stateSettled.status === 'fulfilled' &&
                stateSettled.value &&
                stateSettled.value.success !== false
                    ? (stateSettled.value as unknown as Record<string, unknown>)
                    : null;

            const posRes =
                posSettled.status === 'fulfilled' &&
                posSettled.value &&
                posSettled.value.success !== false
                    ? (posSettled.value as unknown as Record<string, unknown>)
                    : null;

            const idxRes =
                idxSettled.status === 'fulfilled' &&
                idxSettled.value &&
                idxSettled.value.success !== false
                    ? (idxSettled.value as unknown as Record<string, unknown>)
                    : null;

            let curTrackRes: Record<string, unknown> | null = null;
            if (
                !(idxRes?.found && idxRes?.track) &&
                !(posRes && typeof posRes.path === 'string' && posRes.path)
            ) {
                try {
                    const fallbackTrack = await fb.player.getCurrentTrack();
                    if (fallbackTrack && fallbackTrack.success !== false) {
                        curTrackRes = fallbackTrack as unknown as Record<
                            string,
                            unknown
                        >;
                    }
                } catch {
                    // ignore fallback error
                }
            }

            if (!stateRes && !posRes && !idxRes && !curTrackRes) {
                return {
                    supported: false,
                    isPlaying: false,
                    isPaused: false,
                    isStopped: false,
                    playbackTime: null,
                    duration: null,
                    path: currentHostPlayingPath,
                    absolutePath: currentHostPlayingPath,
                    handle: null,
                    title: null,
                    artist: null,
                    album: null,
                    playlistRowIndex: null,
                };
            }

            const stateStr = String(
                stateRes?.state ?? (fb.state?.isPlaying ? 'playing' : '')
            ).toLowerCase();
            const isPlaying =
                Boolean(stateRes?.isPlaying) || stateStr === 'playing';
            const isPaused =
                Boolean(stateRes?.isPaused) || stateStr === 'paused';
            const isStopped = stateStr === 'stopped';

            // 解析 `playback.getPosition` 的精準秒數與 hostTime 補償
            const rawPosNum = Number(
                posRes?.position ?? stateRes?.position ?? fb.state?.position
            );
            const rawDurNum = Number(posRes?.duration);
            const duration =
                Number.isFinite(rawDurNum) && rawDurNum > 0 ? rawDurNum : null;

            let playbackTime: number | null =
                Number.isFinite(rawPosNum) && rawPosNum >= 0 ? rawPosNum : null;

            if (
                isPlaying &&
                playbackTime !== null &&
                typeof posRes?.hostTime === 'number' &&
                Number.isFinite(posRes.hostTime)
            ) {
                const ipcDelaySec = (Date.now() - posRes.hostTime) / 1000;
                if (ipcDelaySec > 0 && ipcDelaySec < 1.5) {
                    playbackTime =
                        duration !== null
                            ? Math.min(duration, playbackTime + ipcDelaySec)
                            : playbackTime + ipcDelaySec;
                }
            }

            // 解析當前播放曲目資訊（優先取 getCurrentTrackIndex.track -> getCurrentTrack.track -> getPosition.path -> fb.state.currentTrack）
            const idxTrackObj =
                idxRes?.found && idxRes?.track && typeof idxRes.track === 'object'
                    ? (idxRes.track as Record<string, unknown>)
                    : null;
            const curTrackObj =
                curTrackRes?.found &&
                curTrackRes?.track &&
                typeof curTrackRes.track === 'object'
                    ? (curTrackRes.track as Record<string, unknown>)
                    : null;
            const fbStateTrackObj =
                fb.state?.currentTrack &&
                typeof fb.state.currentTrack === 'object'
                    ? (fb.state.currentTrack as unknown as Record<
                          string,
                          unknown
                      >)
                    : null;

            const trackObj = idxTrackObj ?? curTrackObj ?? fbStateTrackObj;

            const absolutePathCandidate =
                (trackObj && typeof trackObj.absolutePath === 'string'
                    ? trackObj.absolutePath
                    : null) || null;
            const handleCandidate =
                (trackObj && typeof trackObj.handle === 'string'
                    ? trackObj.handle
                    : null) || null;
            const pathCandidate =
                (trackObj && typeof trackObj.path === 'string'
                    ? trackObj.path
                    : null) ||
                (posRes && typeof posRes.path === 'string'
                    ? posRes.path
                    : null) ||
                null;

            const bestPath =
                (absolutePathCandidate && absolutePathCandidate.trim()) ||
                (pathCandidate && pathCandidate.trim()) ||
                (handleCandidate && handleCandidate.trim()) ||
                currentHostPlayingPath;

            if ((isPlaying || isPaused) && bestPath) {
                currentHostPlayingPath = bestPath;
            } else if (isStopped) {
                currentHostPlayingPath = null;
            }

            const title =
                trackObj && typeof trackObj.title === 'string'
                    ? trackObj.title
                    : null;
            const artist =
                trackObj && typeof trackObj.artist === 'string'
                    ? trackObj.artist
                    : null;
            const album =
                trackObj && typeof trackObj.album === 'string'
                    ? trackObj.album
                    : null;
            const playlistRowIndex =
                idxRes?.found &&
                typeof idxRes.index === 'number' &&
                idxRes.index >= 0
                    ? idxRes.index
                    : null;

            if ((isPlaying || isPaused) && playlistRowIndex !== null) {
                currentHostPlayingRowIndex = playlistRowIndex;
                isCurrentTrackBoundToSyncedDjPlaylist = true;
            }

            return {
                supported: true,
                isPlaying,
                isPaused,
                isStopped,
                playbackTime,
                duration,
                path: bestPath,
                absolutePath: absolutePathCandidate ?? bestPath,
                handle: handleCandidate,
                title,
                artist,
                album,
                playlistRowIndex,
            };
        } catch {
            return {
                supported: false,
                isPlaying: false,
                isPaused: false,
                isStopped: false,
                playbackTime: null,
                duration: null,
                path: currentHostPlayingPath,
                absolutePath: currentHostPlayingPath,
                handle: null,
                title: null,
                artist: null,
                album: null,
                playlistRowIndex: null,
            };
        }
    },
};