import fb from 'foo-webview-sdk';
import { isFoobarWebView, appendBridgeLog } from '../api/mockBridge';
import type { Track } from '../types/track';

// ============================================================================
// [真實波形解碼與快取服務] 支援 512 點 C++ 原生全曲峰值解碼 (fb.audio.generateFullWaveform)
// 與瀏覽器 Web Audio API (AudioContext.decodeAudioData) 雙通道真實音訊波形擷取
// ============================================================================

export const REAL_WAVEFORM_RESOLUTION = 512;

export interface DecodedWaveformData {
    points: number[]; // 長度為 512 的正規化振幅陣列 (0.04 ~ 0.98)
    isReal: boolean;  // true 代表來自真實音檔解碼，false 代表退避合成包絡線
    duration?: number;
}

// 記憶體快取：避免同一首曲目重複解碼
const waveform512Cache = new Map<string, DecodedWaveformData>();
const inFlightTasks = new Map<string, Promise<DecodedWaveformData>>();

// 儲存透過瀏覽器 <input type="file"> 匯入的本地音訊 File 實體，供 Web Audio API 解碼真實波形
const localAudioFileMap = new Map<string, File>();

let sharedDecodeAudioCtx: AudioContext | null = null;

function getCacheKey(track: Pick<Track, 'id' | 'path'>): string {
    // 造成原錯誤的原因：舊版快取以 method: 'peak' 解碼，導致動態壓縮後的現代音樂每根柱子皆頂滿方塊。
    // 本次修改的目的：升級快取鍵前綴為 v2-rms::，確保切換為 RMS 能量波形後自動重新計算高動態對比波形。
    return `v2-rms::${(track.path || track.id).trim()}`;
}

/**
 * 註冊透過瀏覽器 <input type="file"> 選取的本地音訊 File 物件
 */
export function registerLocalAudioFile(
    pathKey: string,
    trackId: string,
    file: File
): void {
    if (pathKey) {
        localAudioFileMap.set(pathKey.trim(), file);
    }
    if (trackId) {
        localAudioFileMap.set(trackId.trim(), file);
    }
}

export function getLocalAudioFile(key: string): File | undefined {
    if (!key) return undefined;
    return localAudioFileMap.get(key.trim());
}

/**
 * 從瀏覽器 <input type="file"> 匯入的本地音訊檔前 1.5MB 標頭區塊掃描內嵌 JPEG / PNG 專輯封面並轉為 Data URL
 */
export async function extractEmbeddedCoverFromLocalAudioFile(
    file: File
): Promise<string | undefined> {
    try {
        const headerSlice = file.slice(0, Math.min(file.size, 1536 * 1024));
        const buf = await headerSlice.arrayBuffer();
        const bytes = new Uint8Array(buf);

        // 1. 搜尋內嵌 JPEG 區塊 (FFD8FF ... FFD9)
        for (let i = 0; i < bytes.length - 16; i++) {
            if (
                bytes[i] === 0xff &&
                bytes[i + 1] === 0xd8 &&
                bytes[i + 2] === 0xff &&
                (bytes[i + 3] === 0xe0 ||
                    bytes[i + 3] === 0xe1 ||
                    bytes[i + 3] === 0xdb)
            ) {
                for (let j = i + 256; j < bytes.length - 1; j++) {
                    if (bytes[j] === 0xff && bytes[j + 1] === 0xd9) {
                        const imgBytes = bytes.subarray(i, j + 2);
                        const blob = new Blob([imgBytes], {
                            type: 'image/jpeg',
                        });
                        return await new Promise<string>((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onload = () =>
                                resolve(String(reader.result));
                            reader.onerror = () => reject(reader.error);
                            reader.readAsDataURL(blob);
                        });
                    }
                }
                break;
            }
        }

        // 2. 搜尋內嵌 PNG 區塊 (89 50 4E 47 0D 0A 1A 0A ... IEND)
        for (let i = 0; i < bytes.length - 16; i++) {
            if (
                bytes[i] === 0x89 &&
                bytes[i + 1] === 0x50 &&
                bytes[i + 2] === 0x4e &&
                bytes[i + 3] === 0x47 &&
                bytes[i + 4] === 0x0d &&
                bytes[i + 5] === 0x0a &&
                bytes[i + 6] === 0x1a &&
                bytes[i + 7] === 0x0a
            ) {
                for (let j = i + 128; j < bytes.length - 8; j++) {
                    if (
                        bytes[j] === 0x49 &&
                        bytes[j + 1] === 0x45 &&
                        bytes[j + 2] === 0x4e &&
                        bytes[j + 3] === 0x44
                    ) {
                        const imgBytes = bytes.subarray(i, j + 8);
                        const blob = new Blob([imgBytes], {
                            type: 'image/png',
                        });
                        return await new Promise<string>((resolve, reject) => {
                            const reader = new FileReader();
                            reader.onload = () =>
                                resolve(String(reader.result));
                            reader.onerror = () => reject(reader.error);
                            reader.readAsDataURL(blob);
                        });
                    }
                }
                break;
            }
        }
    } catch {
        // ignore extraction errors
    }
    return undefined;
}

/**
 * 將任意長度的原始振幅陣列正規化並重採樣至 512 點 (0.04 ~ 0.98)
 */
export function normalizeTo512Points(rawPoints: number[]): number[] {
    if (!rawPoints || rawPoints.length === 0) {
        return Array.from({ length: REAL_WAVEFORM_RESOLUTION }, () => 0.1);
    }

    // 造成原錯誤的原因：
    // 1. 先前在每个 bucket 內只取最大值 (bucketPeak)，並使用 Math.pow(x, 0.88) 膨脹曲線，導致經過母帶壓縮的音樂所有柱子全部貼頂（0.85~0.98），看不出段落起伏。
    // 本次修改的目的：
    // 1. 每個 bucket 取均方根能量 (RMS) 為主、峰值為輔，並以全曲 98% 分位高能量基準進行正規化後，施加 Math.pow(ratio, 1.38) 動態對比擴展曲線，讓前奏、主歌、Breakdown 與副歌的高低落差一目了然。
    const bucketValues: number[] = new Array(REAL_WAVEFORM_RESOLUTION);
    const srcLen = rawPoints.length;

    for (let i = 0; i < REAL_WAVEFORM_RESOLUTION; i++) {
        const startRatio = i / REAL_WAVEFORM_RESOLUTION;
        const endRatio = (i + 1) / REAL_WAVEFORM_RESOLUTION;
        const startIdx = Math.floor(startRatio * srcLen);
        const endIdx = Math.max(startIdx + 1, Math.ceil(endRatio * srcLen));

        let sumSq = 0;
        let count = 0;
        let bucketPeak = 0;
        for (let j = startIdx; j < endIdx && j < srcLen; j++) {
            const v = Math.abs(rawPoints[j] || 0);
            sumSq += v * v;
            count += 1;
            if (v > bucketPeak) bucketPeak = v;
        }
        const bucketRms = count > 0 ? Math.sqrt(sumSq / count) : 0;
        bucketValues[i] = bucketRms * 0.82 + bucketPeak * 0.18;
    }

    const sorted = [...bucketValues].sort((a, b) => a - b);
    const p98Idx = Math.min(
        sorted.length - 1,
        Math.floor(sorted.length * 0.98)
    );
    const refMax = Math.max(
        0.0001,
        sorted[p98Idx] || sorted[sorted.length - 1] || 0.0001
    );

    const result: number[] = new Array(REAL_WAVEFORM_RESOLUTION);
    for (let i = 0; i < REAL_WAVEFORM_RESOLUTION; i++) {
        const ratio = Math.min(1, bucketValues[i] / refMax);
        const contrasted = Math.pow(ratio, 1.38);
        result[i] = Number(
            Math.max(0.04, Math.min(0.98, contrasted)).toFixed(4)
        );
    }

    return result;
}

/**
 * 能量與瞬態兼顧降採樣：
 * 將 512 點真實波形濃縮至目標顯示柱數 (例如 140 根)
 */
export function downsampleMaxPool(
    points512: number[],
    targetBars: number
): number[] {
    if (!points512 || points512.length === 0) {
        return Array.from({ length: targetBars }, () => 0.1);
    }
    const srcLen = points512.length;
    const bars: number[] = new Array(targetBars);

    // 造成原錯誤的原因：先前單純取區間最大值 (Math.max)，把每 3~4 個取樣點中的低谷全部填平，使縮圖看起來像實心磚塊。
    // 本次修改的目的：採用 72% 區間平均能量 + 28% 區間峰值，既保留鼓點瞬態突起，又完整呈現段落間的波谷與呼吸感。
    for (let b = 0; b < targetBars; b++) {
        const startIdx = Math.floor((b / targetBars) * srcLen);
        const endIdx = Math.max(
            startIdx + 1,
            Math.floor(((b + 1) / targetBars) * srcLen)
        );
        let peak = 0.04;
        let sum = 0;
        let count = 0;
        for (let i = startIdx; i < endIdx && i < srcLen; i++) {
            const val = points512[i] ?? 0.04;
            sum += val;
            count += 1;
            if (val > peak) {
                peak = val;
            }
        }
        const avg = count > 0 ? sum / count : peak;
        bars[b] = Number((avg * 0.72 + peak * 0.28).toFixed(4));
    }

    return bars;
}

/**
 * 通道 B：使用瀏覽器 Web Audio API (AudioContext.decodeAudioData) 解碼本地 File 物件產生 512 點真實能量波形
 */
async function decodeFileViaWebAudio(
    file: File
): Promise<DecodedWaveformData | null> {
    try {
        const AudioCtx =
            window.AudioContext ||
            (window as unknown as { webkitAudioContext?: typeof AudioContext })
                .webkitAudioContext;
        if (!AudioCtx) return null;

        if (!sharedDecodeAudioCtx) {
            sharedDecodeAudioCtx = new AudioCtx();
        }

        const arrayBuffer = await file.arrayBuffer();
        const audioBuffer = await sharedDecodeAudioCtx.decodeAudioData(
            arrayBuffer.slice(0)
        );

        const totalFrames = audioBuffer.length;
        const numChannels = audioBuffer.numberOfChannels;
        if (totalFrames <= 0 || numChannels <= 0) return null;

        const ch0 = audioBuffer.getChannelData(0);
        const ch1 = numChannels > 1 ? audioBuffer.getChannelData(1) : null;

        const rawEnergies = new Array<number>(REAL_WAVEFORM_RESOLUTION);
        const samplesPerBucket = Math.max(
            1,
            Math.floor(totalFrames / REAL_WAVEFORM_RESOLUTION)
        );
        // 在每個 Bucket 內以適當步進計算 RMS 均方根能量與瞬態峰值
        const step = Math.max(1, Math.floor(samplesPerBucket / 96));

        for (let b = 0; b < REAL_WAVEFORM_RESOLUTION; b++) {
            const startSample = b * samplesPerBucket;
            const endSample =
                b === REAL_WAVEFORM_RESOLUTION - 1
                    ? totalFrames
                    : Math.min(totalFrames, startSample + samplesPerBucket);

            let maxPeak = 0;
            let sumSq = 0;
            let count = 0;
            for (let s = startSample; s < endSample; s += step) {
                const v0 = Math.abs(ch0[s] || 0);
                const v1 = ch1 ? Math.abs(ch1[s] || 0) : 0;
                const v = v0 > v1 ? v0 : v1;
                sumSq += v * v;
                count += 1;
                if (v > maxPeak) maxPeak = v;
            }
            const rms = count > 0 ? Math.sqrt(sumSq / count) : 0;
            rawEnergies[b] = rms * 0.78 + maxPeak * 0.22;
        }

        return {
            points: normalizeTo512Points(rawEnergies),
            isReal: true,
            // [修復同卡片曲目提早切歌：波形解碼回傳秒數無條件捨去]
            duration: Math.max(1, Math.floor(audioBuffer.duration)),
        };
    } catch {
        return null;
    }
}

/**
 * 通道 C (Fallback)：當曲目為內建虛擬 Demo 曲目且硬碟無實體音檔時，生成 512 點結構化合成波形
 */
export function buildFallbackWaveform512(track: Track): number[] {
    const seedStr = `${track.id}-${track.title}-${track.bpm}`;
    let hash = 2166136261;
    for (let i = 0; i < seedStr.length; i++) {
        hash ^= seedStr.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    const seed = Math.abs(hash % 1000) / 1000;
    const baseCoarse =
        Array.isArray(track.waveform) && track.waveform.length > 0
            ? track.waveform
            : [0.25, 0.55, 0.85, 0.9, 0.45, 0.35, 0.92, 0.98, 0.72, 0.28];

    return Array.from({ length: REAL_WAVEFORM_RESOLUTION }, (_, idx) => {
        const t = idx / (REAL_WAVEFORM_RESOLUTION - 1);
        const introFade = Math.min(1, Math.pow(t / 0.07, 0.82));
        const lobe1 = Math.exp(-Math.pow((t - 0.27) / 0.125, 2)) * 0.8;
        const breakdownDip =
            1 - 0.72 * Math.exp(-Math.pow((t - 0.43) / 0.04, 2));
        const lobe2 = Math.exp(-Math.pow((t - 0.67) / 0.175, 2)) * 0.98;
        const outroTail =
            t > 0.96
                ? 0.58 + Math.sin((t - 0.96) * 110) * 0.26
                : t > 0.88
                  ? 0.22
                  : 0.14;

        const macroEnvelope =
            Math.max(lobe1, lobe2, outroTail) * breakdownDip * introFade;

        const pos = t * (baseCoarse.length - 1);
        const lowIdx = Math.floor(pos);
        const highIdx = Math.min(baseCoarse.length - 1, lowIdx + 1);
        const frac = pos - lowIdx;
        const coarseVal =
            baseCoarse[lowIdx] * (1 - frac) + baseCoarse[highIdx] * frac;

        const transient =
            0.74 +
            0.18 *
                Math.sin(idx * 2.7 + seed * 19.3) *
                Math.cos(idx * 1.13 + seed * 11.7) +
            0.08 * Math.sin(idx * 5.3 + seed * 31.1);

        const combined = (macroEnvelope * 0.68 + coarseVal * 0.32) * transient;
        return Number(Math.max(0.05, Math.min(0.98, combined)).toFixed(4));
    });
}

/**
 * 同步讀取記憶體快取中的 512 點波形（若尚未解碼完成則回傳 null）
 */
export function getCachedWaveform512(track: Track): DecodedWaveformData | null {
    const key = getCacheKey(track);
    const cached = waveform512Cache.get(key);
    if (cached) return cached;

    if (
        Array.isArray(track.waveform) &&
        track.waveform.length >= REAL_WAVEFORM_RESOLUTION
    ) {
        const entry: DecodedWaveformData = {
            points: track.waveform.slice(0, REAL_WAVEFORM_RESOLUTION),
            isReal: true,
        };
        waveform512Cache.set(key, entry);
        return entry;
    }

    return null;
}

/**
 * 非同步取得曲目的 512 點真實波形：
 * 1. 優先查詢記憶體快取
 * 2. 若為瀏覽器本地匯入檔案，透過 Web Audio API 解碼真實 PCM
 * 3. 若在 foobar2000 WebView2 環境，呼叫 fb.audio.generateFullWaveform(path, { resolution: 512, method: 'peak' })
 * 4. 若為虛擬範例曲目或解碼失敗，平滑退回 512 點合成包絡線
 */
export async function fetchTrackRealWaveform512(
    track: Track
): Promise<DecodedWaveformData> {
    const key = getCacheKey(track);
    const existingCache = getCachedWaveform512(track);
    if (existingCache) {
        return existingCache;
    }

    const existingPromise = inFlightTasks.get(key);
    if (existingPromise) {
        return existingPromise;
    }

    const taskPromise = (async (): Promise<DecodedWaveformData> => {
        try {
            // [通道 B] 檢查是否為透過瀏覽器 <input type="file"> 匯入的本地實體檔案
            const localFile =
                localAudioFileMap.get(key) ??
                localAudioFileMap.get(track.id.trim());
            if (localFile) {
                const decodedLocal = await decodeFileViaWebAudio(localFile);
                if (decodedLocal) {
                    waveform512Cache.set(key, decodedLocal);
                    appendBridgeLog('HOST_TO_CLIENT', 'WEB_AUDIO_WAVEFORM_OK', {
                        title: track.title,
                        resolution: REAL_WAVEFORM_RESOLUTION,
                    });
                    return decodedLocal;
                }
            }

            // [通道 A] 在 foobar2000 WebView2 宿主環境中呼叫 C++ 原生全曲波形解碼 API
            if (isFoobarWebView() && fb.isAvailable() && track.path) {
                appendBridgeLog('CLIENT_TO_HOST', 'AUDIO_GEN_WAVEFORM_512', {
                    path: track.path,
                    resolution: REAL_WAVEFORM_RESOLUTION,
                    method: 'rms',
                });

                // 造成原錯誤的原因：先前指定 method: 'peak'，經過母帶壓縮/Limiter 的現代音樂每段最大峰值幾乎皆接近 0dBFS，導致整排柱子頂滿方塊。
                // 本次修改的目的：改用 foo-webview-sdk 官方預設的 method: 'rms' 擷取均方根能量，真實反映前奏、主歌、副歌與尾奏的響度起伏。
                const res = await fb.audio.generateFullWaveform(track.path, {
                    resolution: REAL_WAVEFORM_RESOLUTION,
                    method: 'rms',
                    scale: 'linear',
                    signed: false,
                    preferCache: true,
                    timeout: 30000,
                });

                if (
                    res &&
                    res.success &&
                    Array.isArray(res.waveform) &&
                    res.waveform.length > 0
                ) {
                    const points = normalizeTo512Points(res.waveform);
                    const realEntry: DecodedWaveformData = {
                        points,
                        isReal: true,
                        // [修復同卡片曲目提早切歌：C++ 波形解碼回傳之秒數無條件捨去]
                        duration:
                            typeof res.duration === 'number' && res.duration > 0
                                ? Math.max(1, Math.floor(res.duration))
                                : undefined,
                    };
                    waveform512Cache.set(key, realEntry);
                    appendBridgeLog(
                        'HOST_TO_CLIENT',
                        'AUDIO_GEN_WAVEFORM_READY',
                        {
                            path: track.path,
                            points: points.length,
                            cached: res.cached,
                        }
                    );
                    return realEntry;
                }
            }
        } catch (err) {
            appendBridgeLog(
                'HOST_TO_CLIENT',
                'AUDIO_GEN_WAVEFORM_FALLBACK',
                String(err)
            );
        }

        // [通道 C] 退避合成 512 點包絡線 (不寫入永久真實快取，以免稍後宿主就緒時無法重試，但保留於結果回傳)
        const fallbackEntry: DecodedWaveformData = {
            points: buildFallbackWaveform512(track),
            isReal: false,
        };
        return fallbackEntry;
    })();

    inFlightTasks.set(key, taskPromise);
    try {
        return await taskPromise;
    } finally {
        inFlightTasks.delete(key);
    }
}

/**
 * [新增功能：跳過靜音 (Trim / Skip Silence)]
 * 依據曲目 512 點正規化 RMS 能量波形，自動偵測：
 * 1. mixIn：前奏實際發出聲音的位置
 * 2. mixOut：尾端剛進入靜音的位置
 */
export async function detectTrackNonSilentBounds(
    track: Track
): Promise<{ mixIn: number; mixOut: number }> {
    const decoded =
        getCachedWaveform512(track) ?? (await fetchTrackRealWaveform512(track));
    const points = decoded.points;
    const safeDur = Math.max(
        1,
        typeof decoded.duration === 'number' && decoded.duration > 1
            ? Math.min(track.duration, decoded.duration)
            : track.duration
    );

    if (!points || points.length === 0) {
        return {
            mixIn: 0,
            mixOut: Number((Math.floor(safeDur * 10) / 10).toFixed(1)),
        };
    }

    const totalPts = points.length;
    let minPeak = 1;
    let maxPeak = 0;
    for (let i = 0; i < totalPts; i++) {
        const v = points[i] ?? 0.04;
        if (v < minPeak) minPeak = v;
        if (v > maxPeak) maxPeak = v;
    }

    // 造成原錯誤的原因：先前門檻設為 Math.max(0.065, minPeak + (maxPeak - minPeak) * 0.055) 偏高，加上 512 點分桶邊界量化誤差，導致微弱漸入前奏與尾奏餘音被切掉約 0.2~0.3 秒。
    // 本次修改的目的：將靜音門檻下調至 Math.max(0.044, minPeak + (maxPeak - minPeak) * 0.015)（剛脫離 0.04 靜音底線即視為發聲），並於首尾加入 0.1 秒 Safety Margin 緩衝保護。
    const silenceThreshold = Math.max(
        0.044,
        minPeak + (maxPeak - minPeak) * 0.015
    );
    const SAFETY_MARGIN_SEC = 0.1;

    // 1. 從曲首往後搜尋第一個突破靜音門檻的發聲位置
    let firstSoundIdx = 0;
    for (let i = 0; i < totalPts; i++) {
        const cur = points[i] ?? 0.04;
        const next = points[Math.min(totalPts - 1, i + 1)] ?? cur;
        if (
            cur >= silenceThreshold &&
            (next >= silenceThreshold * 0.9 || cur >= silenceThreshold * 1.15)
        ) {
            firstSoundIdx = i;
            break;
        }
    }

    // 2. 從曲尾往前搜尋最後一個高於靜音門檻的發聲點，其下一個刻度即為剛進入尾端靜音的位置
    let lastSoundIdx = totalPts - 1;
    for (let i = totalPts - 1; i >= firstSoundIdx; i--) {
        const cur = points[i] ?? 0.04;
        const prev = points[Math.max(0, i - 1)] ?? cur;
        if (
            cur >= silenceThreshold &&
            (prev >= silenceThreshold * 0.9 || cur >= silenceThreshold * 1.15)
        ) {
            lastSoundIdx = i;
            break;
        }
    }

    const maxFloorOut = Number((Math.floor(safeDur * 10) / 10).toFixed(1));
    const rawMixIn =
        firstSoundIdx <= 0
            ? 0
            : Math.max(0, (firstSoundIdx / totalPts) * safeDur - SAFETY_MARGIN_SEC);
    const rawMixOut =
        lastSoundIdx >= totalPts - 1
            ? maxFloorOut
            : Math.min(
                  maxFloorOut,
                  ((lastSoundIdx + 1) / totalPts) * safeDur + SAFETY_MARGIN_SEC
              );

    const mixIn = Number(Math.max(0, rawMixIn).toFixed(1));
    const mixOut = Number(
        Math.min(
            maxFloorOut,
            Math.max(Math.min(maxFloorOut, mixIn + 2.0), rawMixOut)
        ).toFixed(1)
    );

    return { mixIn, mixOut };
}

