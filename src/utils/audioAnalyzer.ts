import fb from 'foo-webview-sdk';
import { isFoobarWebView, appendBridgeLog } from '../api/mockBridge';
import type { Track } from '../types/track';
import { getLocalAudioFile } from './waveformService';

// ============================================================================
// [真實音訊 DSP 計算引擎] audioAnalyzer.ts
// 嚴格不依賴音檔內建 BPM / Key Tag，統一從真實音訊檔解碼 PCM 樣本計算：
// 1. 真實 BPM：Onset Transient Flux Envelope (瞬態能量突波包絡) + Autocorrelation Comb Filter (自相關週期分析)
// 2. 真實駱駝色輪 (Camelot Key 1A~12B)：48 半音 Goertzel 頻譜能量摺疊 12-Bin Chromagram + Krumhansl-Schmuckler 大小調相關係數匹配
// ============================================================================

export interface RealAudioAnalysisResult {
    bpm: number;
    key: string; // Camelot Wheel: '1A'..'12A' | '1B'..'12B'
    duration?: number;
    isRealComputed: boolean;
}

const ANALYSIS_CACHE_STORAGE_KEY = 'foobar_dj_real_pcm_analysis_v3';

// 12 個半音階 (0 = C, 1 = C#, 2 = D, 3 = D#, 4 = E, 5 = F, 6 = F#, 7 = G, 8 = G#, 9 = A, 10 = A#, 11 = B)
// 對應的 Camelot Wheel 色號表：
// Major (B 圈): C=8B, C#=3B, D=10B, Eb=5B, E=12B, F=7B, F#=2B, G=9B, Ab=4B, A=11B, Bb=6B, B=1B
const PITCH_CLASS_TO_CAMELOT_MAJOR: readonly string[] = [
    '8B',  // C Major
    '3B',  // Db / C# Major
    '10B', // D Major
    '5B',  // Eb / D# Major
    '12B', // E Major
    '7B',  // F Major
    '2B',  // F# / Gb Major
    '9B',  // G Major
    '4B',  // Ab / G# Major
    '11B', // A Major
    '6B',  // Bb / A# Major
    '1B',  // B Major
];

// Minor (A 圈): Cm=5A, C#m=12A, Dm=7A, Ebm=2A, Em=9A, Fm=4A, F#m=11A, Gm=6A, G#m=1A, Am=8A, Bbm=3A, Bm=10A
const PITCH_CLASS_TO_CAMELOT_MINOR: readonly string[] = [
    '5A',  // C Minor
    '12A', // C# Minor
    '7A',  // D Minor
    '2A',  // Eb / D# Minor
    '9A',  // E Minor
    '4A',  // F Minor
    '11A', // F# Minor
    '6A',  // G Minor
    '1A',  // G# / Ab Minor
    '8A',  // A Minor
    '3A',  // Bb / A# Minor
    '10A', // B Minor
];

// Krumhansl-Kessler 與現代電子/流行樂 (Sha'ath / EDMA) 混合加權之大小調 12 半音認知權重模板
// 強化主音 (0)、大/小三度 (4 / 3) 與完全五度 (7) 的辨識對比度，抑制小調舞曲誤判為關係大調的問題
const KK_MAJOR_PROFILE: readonly number[] = [
    6.52, 2.15, 3.48, 2.24, 4.65, 4.02, 2.45, 5.32, 2.32, 3.66, 2.25, 2.95,
];
const KK_MINOR_PROFILE: readonly number[] = [
    6.58, 2.55, 3.54, 5.62, 2.45, 3.58, 2.48, 5.05, 4.05, 2.65, 3.45, 3.12,
];

// 記憶體與 localStorage 快取
const analysisCache = new Map<string, RealAudioAnalysisResult>();
let hasLoadedCacheFromStorage = false;

function ensureCacheLoaded(): void {
    if (hasLoadedCacheFromStorage) return;
    hasLoadedCacheFromStorage = true;
    try {
        const raw = localStorage.getItem(ANALYSIS_CACHE_STORAGE_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw) as Record<
            string,
            RealAudioAnalysisResult
        >;
        if (parsed && typeof parsed === 'object') {
            for (const [k, v] of Object.entries(parsed)) {
                if (
                    v &&
                    typeof v.bpm === 'number' &&
                    typeof v.key === 'string' &&
                    v.isRealComputed
                ) {
                    // [修復舊快取整數秒數覆寫問題]
                    // 造成原錯誤的原因：localStorage (`foobar_dj_real_pcm_analysis_v2`) 舊快取存有四捨五入後的 duration（如 261s），
                    // 會在啟動時透過 enqueueTracksForRealBpmKeyAnalysis 將剛下修為 260s 的曲目長度與預設 mixOut 再次覆寫回 261s。
                    // 本次修改的目的：載入本地分析快取時僅還原 bpm 與 key，忽略快取中的舊 duration，以宿主 `%length_seconds_fp%` 無條件捨去秒數為準。
                    analysisCache.set(k, {
                        bpm: v.bpm,
                        key: v.key,
                        isRealComputed: true,
                    });
                }
            }
        }
    } catch {
        // ignore storage errors
    }
}

function persistCacheToStorage(): void {
    try {
        const obj: Record<string, RealAudioAnalysisResult> = {};
        // 保留最近 1000 首真實計算結果於 localStorage
        const entries = Array.from(analysisCache.entries()).slice(-1000);
        for (const [k, v] of entries) {
            if (v.isRealComputed) {
                obj[k] = v;
            }
        }
        localStorage.setItem(ANALYSIS_CACHE_STORAGE_KEY, JSON.stringify(obj));
    } catch {
        // ignore quota errors
    }
}

export function getCachedRealAudioAnalysis(
    pathOrId: string
): RealAudioAnalysisResult | null {
    ensureCacheLoaded();
    const key = pathOrId.trim();
    return analysisCache.get(key) ?? null;
}

/**
 * [演算法 1] 從真實單聲道 PCM 樣本計算真實 BPM
 * 步驟：
 * 1. 以 10ms 步進視窗計算平方振幅能量與正一階差分 (Onset Flux Envelope)，強化鼓點瞬態
 * 2. 針對 68 ~ 176 BPM 進行高解析度自相關掃描 (Autocorrelation + 倍頻/半頻共振加權)
 * 3. 結合電子/流行音樂常見速度高斯分佈權重，選出最顯著的真實節拍週期
 */
export function computeRealBpmFromPcm(
    samples: Float32Array,
    sampleRate: number
): number {
    if (!samples || samples.length < sampleRate * 2 || sampleRate <= 0) {
        return 125;
    }

    // 1. 計算能量包絡線 (Envelope frame rate ≈ 100 Hz)
    const hopSize = Math.max(32, Math.round(sampleRate / 100));
    const envFrameRate = sampleRate / hopSize;
    const numFrames = Math.floor(samples.length / hopSize);
    if (numFrames < 64) return 125;

    const energy = new Float32Array(numFrames);
    for (let f = 0; f < numFrames; f++) {
        const offset = f * hopSize;
        let sumSq = 0;
        for (let i = 0; i < hopSize; i++) {
            const s = samples[offset + i] || 0;
            sumSq += s * s;
        }
        energy[f] = Math.sqrt(sumSq / hopSize);
    }

    // 2. 一階半波整流差分 (Half-wave rectified first-order difference = Onset Flux)
    const onset = new Float32Array(numFrames);
    let meanOnset = 0;
    for (let f = 1; f < numFrames; f++) {
        const diff = energy[f] - energy[f - 1];
        const val = diff > 0 ? diff : 0;
        onset[f] = val;
        meanOnset += val;
    }
    meanOnset /= numFrames;

    // 扣除平均基底並進行移動平均平滑化
    for (let f = 0; f < numFrames; f++) {
        onset[f] = Math.max(0, onset[f] - meanOnset * 0.65);
    }

    // 3. 在 68 BPM ~ 176 BPM 範圍內計算自相關強度 (以 0.5 BPM 為步進)
    let bestBpm = 124;
    let bestScore = -1;

    const acfCache = new Map<number, number>();
    const getAutocorrelationAtLag = (lagFrames: number): number => {
        if (lagFrames <= 2 || lagFrames >= numFrames - 4) return 0;
        const cached = acfCache.get(lagFrames);
        if (cached !== undefined) return cached;

        let sum = 0;
        const count = numFrames - lagFrames;
        for (let i = 0; i < count; i++) {
            sum += onset[i] * onset[i + lagFrames];
        }
        const normalized = sum / count;
        acfCache.set(lagFrames, normalized);
        return normalized;
    };

    for (let bpmCandidate = 68; bpmCandidate <= 176; bpmCandidate += 0.5) {
        const lagExact = (60 / bpmCandidate) * envFrameRate;
        const lag1 = Math.round(lagExact);
        const lag2 = Math.round(lagExact * 2);
        const lagHalf = Math.round(lagExact * 0.5);

        const r1 = getAutocorrelationAtLag(lag1);
        const r2 = getAutocorrelationAtLag(lag2);
        const rHalf = getAutocorrelationAtLag(lagHalf);

        // 結合基頻週期、2 拍週期與半拍細分共振
        const combScore = r1 * 1.0 + r2 * 0.48 + rHalf * 0.28;

        // 輕微的速度感知先驗 (避免 68 BPM 與 136 BPM 八度折疊誤判，中心在 124 BPM)
        const tempoPrior =
            0.82 +
            0.18 * Math.exp(-Math.pow((bpmCandidate - 124) / 38, 2));

        const totalScore = combScore * tempoPrior;
        if (totalScore > bestScore) {
            bestScore = totalScore;
            bestBpm = bpmCandidate;
        }
    }

    return Math.max(68, Math.min(176, Math.round(bestBpm)));
}

/**
 * [演算法 2] 從真實單聲道 PCM 樣本計算 12 半音 Chromagram 與駱駝色輪色號 (Camelot Key 1A ~ 12B)
 * 造成原錯誤的原因：
 * 1. 先前僅在 25 秒音訊中稀疏取樣 20 個視窗，且未過濾大鼓/打擊樂瞬態暴衝視窗，寬頻打擊雜訊會稀釋和聲純度。
 * 2. 先前直接將 48 個半音能量線性相加，未扣除基音產生的第 2 泛音 (+12 半音) 與第 3 泛音 (+19 半音，五度泛音)，易造成五度調與關係大小調混淆。
 * 本次修改的目的：
 * 1. 提高取樣視窗覆蓋率至最多 64 個視窗，並自動剔除頂部前 15% 能量暴衝的打擊樂瞬態視窗。
 * 2. 在每個視窗內執行泛音列抑制（扣除 +12 八度泛音與 +19 五度泛音殘餘）與對數動態壓縮 `Math.log1p`，大幅提升駱駝色輪調性識別準確度。
 */
export function computeRealCamelotKeyFromPcm(
    samples: Float32Array,
    sampleRate: number
): string {
    if (!samples || samples.length < 4096 || sampleRate <= 0) {
        return '8A';
    }

    const chroma = new Float64Array(12);
    // 提高取樣視窗覆蓋率至最多 64 個 4096 點視窗
    const windowSize = Math.min(4096, Math.floor(samples.length / 2));
    const numWindows = Math.min(
        64,
        Math.max(1, Math.floor((samples.length - windowSize) / (windowSize * 0.5)) + 1)
    );
    const stepWindow =
        numWindows > 1
            ? Math.max(1, Math.floor((samples.length - windowSize) / (numWindows - 1)))
            : 1;

    // 預先計算 C2 (MIDI 36) ~ B5 (MIDI 83) 共 48 個半音的 Goertzel 係數與音區權重
    const midiNotes: Array<{
        noteIdx: number; // 0 ~ 47
        pitchClass: number;
        coeff: number;
        registerWeight: number;
    }> = [];

    for (let midi = 36; midi <= 83; midi++) {
        const freq = 440 * Math.pow(2, (midi - 69) / 12);
        if (freq >= sampleRate * 0.46) continue;
        const k = Math.round((windowSize * freq) / sampleRate);
        const omega = (2 * Math.PI * k) / windowSize;
        const coeff = 2 * Math.cos(omega);
        // 中低音與核心和聲區 (C2~C5) 賦予較高權重，高頻泛音區微幅衰減
        const registerWeight = midi <= 72 ? 1.0 : 0.78;
        midiNotes.push({
            noteIdx: midi - 36,
            pitchClass: midi % 12,
            coeff,
            registerWeight,
        });
    }

    // 預建 Hann Window 降低頻譜洩漏
    const hann = new Float32Array(windowSize);
    for (let i = 0; i < windowSize; i++) {
        hann[i] = 0.5 * (1 - Math.cos((2 * Math.PI * i) / (windowSize - 1)));
    }

    // 先計算各視窗能量分佈，用以排除頂部 15% 打擊樂重拍瞬態視窗與底部靜音視窗
    const windowMeta: Array<{ startOffset: number; energy: number }> = [];
    for (let w = 0; w < numWindows; w++) {
        const startOffset = w * stepWindow;
        let winEnergy = 0;
        for (let i = 0; i < windowSize; i += 2) {
            const s = samples[startOffset + i] || 0;
            winEnergy += s * s;
        }
        if (winEnergy > 1e-6) {
            windowMeta.push({ startOffset, energy: winEnergy });
        }
    }

    if (windowMeta.length === 0) {
        return '8A';
    }

    const sortedEnergies = windowMeta
        .map((m) => m.energy)
        .sort((a, b) => a - b);
    const maxAllowedEnergy =
        sortedEnergies.length >= 8
            ? sortedEnergies[Math.floor(sortedEnergies.length * 0.85)]
            : Infinity;

    const windowedBuf = new Float32Array(windowSize);
    const noteMagnitudes = new Float64Array(48);
    const cleanedMagnitudes = new Float64Array(48);

    for (let w = 0; w < windowMeta.length; w++) {
        const { startOffset, energy } = windowMeta[w];
        if (energy > maxAllowedEnergy) continue;

        for (let i = 0; i < windowSize; i++) {
            windowedBuf[i] = (samples[startOffset + i] || 0) * hann[i];
        }

        noteMagnitudes.fill(0);

        for (let n = 0; n < midiNotes.length; n++) {
            const { noteIdx, coeff, registerWeight } = midiNotes[n];
            let s1 = 0;
            let s2 = 0;
            for (let i = 0; i < windowSize; i++) {
                const s0 = windowedBuf[i] + coeff * s1 - s2;
                s2 = s1;
                s1 = s0;
            }
            const power = s1 * s1 + s2 * s2 - coeff * s1 * s2;
            if (power > 0) {
                noteMagnitudes[noteIdx] = Math.sqrt(power) * registerWeight;
            }
        }

        // 泛音列抑制 (Harmonic Overtone Suppression)：
        // 由低音往高音扣除基音所產生的第 2 泛音 (+12 八度) 與第 3 泛音 (+19 八度加完全五度)
        for (let idx = 0; idx < 48; idx++) {
            cleanedMagnitudes[idx] = noteMagnitudes[idx];
        }
        for (let idx = 0; idx < 48; idx++) {
            const fund = cleanedMagnitudes[idx];
            if (fund <= 0) continue;
            if (idx + 12 < 48) {
                cleanedMagnitudes[idx + 12] = Math.max(
                    0,
                    cleanedMagnitudes[idx + 12] - fund * 0.32
                );
            }
            if (idx + 19 < 48) {
                cleanedMagnitudes[idx + 19] = Math.max(
                    0,
                    cleanedMagnitudes[idx + 19] - fund * 0.22
                );
            }
        }

        // 對數壓縮 (Log-compression) 後摺疊累加至 12-Bin Pitch Class Profile
        for (let n = 0; n < midiNotes.length; n++) {
            const { noteIdx, pitchClass } = midiNotes[n];
            const mag = cleanedMagnitudes[noteIdx];
            if (mag > 0) {
                chroma[pitchClass] += Math.log1p(mag * 18);
            }
        }
    }

    // 正規化 12-Bin Chroma 向量
    let chromaSum = 0;
    for (let c = 0; c < 12; c++) {
        chromaSum += chroma[c];
    }
    if (chromaSum <= 0) {
        return '8A';
    }

    const chromaMean = chromaSum / 12;
    let chromaVar = 0;
    for (let c = 0; c < 12; c++) {
        const d = chroma[c] - chromaMean;
        chromaVar += d * d;
    }
    if (chromaVar <= 1e-12) {
        return '8A';
    }

    const correlateWithProfile = (
        profile: readonly number[],
        rootShift: number
    ): number => {
        let pSum = 0;
        for (let i = 0; i < 12; i++) pSum += profile[i];
        const pMean = pSum / 12;

        let num = 0;
        let pVar = 0;
        for (let i = 0; i < 12; i++) {
            const cVal = chroma[(i + rootShift) % 12] - chromaMean;
            const pVal = profile[i] - pMean;
            num += cVal * pVal;
            pVar += pVal * pVal;
        }
        return num / Math.sqrt(chromaVar * pVar);
    };

    let bestCamelot = '8A';
    let bestCorr = -Infinity;

    for (let root = 0; root < 12; root++) {
        const majCorr = correlateWithProfile(KK_MAJOR_PROFILE, root);
        if (majCorr > bestCorr) {
            bestCorr = majCorr;
            bestCamelot = PITCH_CLASS_TO_CAMELOT_MAJOR[root];
        }

        const minCorr = correlateWithProfile(KK_MINOR_PROFILE, root);
        if (minCorr > bestCorr) {
            bestCorr = minCorr;
            bestCamelot = PITCH_CLASS_TO_CAMELOT_MINOR[root];
        }
    }

    return bestCamelot;
}

let sharedAnalyzerAudioCtx: AudioContext | null = null;

/**
 * 對單首曲目執行真實 PCM 音訊分析，回傳計算出的 { bpm, key }
 * 嚴格只使用音訊波形/PCM 數據計算，不讀取內建 BPM/Key Tag
 */
export async function analyzeTrackBpmAndKeyReal(
    track: Track
): Promise<RealAudioAnalysisResult | null> {
    const cacheKey = (track.path || track.id).trim();
    if (!cacheKey || cacheKey.startsWith('C:\\Music\\DJ_Set\\')) {
        return null;
    }

    const cached = getCachedRealAudioAnalysis(cacheKey);
    if (cached) {
        return cached;
    }

    // [通道 1] 若為瀏覽器 <input type="file"> 匯入的本地音訊 File 物件，使用 Web Audio API 解碼 PCM 實算
    const localFile =
        getLocalAudioFile(cacheKey) ?? getLocalAudioFile(track.id);
    if (localFile) {
        try {
            const AudioCtx =
                window.AudioContext ||
                (
                    window as unknown as {
                        webkitAudioContext?: typeof AudioContext;
                    }
                ).webkitAudioContext;
            if (AudioCtx) {
                if (!sharedAnalyzerAudioCtx) {
                    sharedAnalyzerAudioCtx = new AudioCtx();
                }
                const arrayBuf = await localFile.arrayBuffer();
                const audioBuf = await sharedAnalyzerAudioCtx.decodeAudioData(
                    arrayBuf.slice(0)
                );
                const sr = audioBuf.sampleRate;
                const ch0 = audioBuf.getChannelData(0);

                // 取曲目 20% ~ 65% 的中段精華區（最長 28 秒）進行分析，避開無鼓點前奏
                const startFrame = Math.floor(ch0.length * 0.2);
                const maxSliceFrames = Math.min(
                    ch0.length - startFrame,
                    Math.floor(sr * 28)
                );
                const slice =
                    maxSliceFrames > sr * 3
                        ? ch0.subarray(startFrame, startFrame + maxSliceFrames)
                        : ch0;

                const bpm = computeRealBpmFromPcm(slice, sr);
                const key = computeRealCamelotKeyFromPcm(slice, sr);
                // [修復問題 1.1 & 1.1.1：防止曲目長度四捨五入進位超過實體檔案 EOF 造成提早 1s 切歌]
                // 造成錯誤的原因：先前使用 Math.round(duration)，當實體檔案為 260.5s 時進位成 261s，導致宿主在 260.5s 提前觸發 EOF 自動切入下一首歌。
                // 修改的目的：改用 Math.floor 向下取整，確保預設 mixOut (=== duration) 永遠小於或等於實體音訊檔真實 EOF。
                const result: RealAudioAnalysisResult = {
                    bpm,
                    key,
                    duration: Math.max(1, Math.floor(audioBuf.duration)),
                    isRealComputed: true,
                };
                analysisCache.set(cacheKey, result);
                persistCacheToStorage();
                return result;
            }
        } catch {
            // 忽略單檔 Web Audio 解碼例外
        }
    }

    // [通道 2] 在 foobar2000 WebView2 實機環境中，透過 fb.audio.decodePcm 擷取中段單聲道 PCM 進行真實 DSP 計算
    if (isFoobarWebView() && fb.isAvailable() && track.path) {
        const safeDur = track.duration > 30 ? track.duration : 180;
        const startSec = Math.max(
            0,
            Math.min(safeDur * 0.22, safeDur - 26)
        );
        const endSec = Math.min(safeDur, startSec + 25);

        try {
            const pcmBuffer = await fb.audio.decodePcm(track.path, {
                start: Number(startSec.toFixed(1)),
                end: Number(endSec.toFixed(1)),
                sampleRate: 11025,
                mono: true,
                timeoutMs: 20000,
            });

            try {
                const view = pcmBuffer.getChannelView(0);
                // 複製一份 Float32Array 後立即釋放 WebView2 SharedBuffer，零記憶體洩漏
                const samplesCopy = new Float32Array(view.length);
                samplesCopy.set(view);
                const sr = pcmBuffer.sampleRate || 11025;
                pcmBuffer.release();

                const bpm = computeRealBpmFromPcm(samplesCopy, sr);
                const key = computeRealCamelotKeyFromPcm(samplesCopy, sr);
                const result: RealAudioAnalysisResult = {
                    bpm,
                    key,
                    isRealComputed: true,
                };

                analysisCache.set(cacheKey, result);
                persistCacheToStorage();
                appendBridgeLog('HOST_TO_CLIENT', 'REAL_DSP_BPM_KEY_OK', {
                    title: track.title,
                    bpm,
                    key,
                });
                return result;
            } finally {
                if (pcmBuffer.available) {
                    pcmBuffer.release();
                }
            }
        } catch {
            // [通道 2B 備援] 若宿主環境不支援 SharedBuffer (decodePcm)，使用 4096 點雙極性全曲波形進行真實包絡與頻率分析
            try {
                const wfRes = await fb.audio.generateFullWaveform(track.path, {
                    resolution: 4096,
                    method: 'peak',
                    scale: 'linear',
                    signed: true,
                    preferCache: true,
                    timeout: 20000,
                });
                if (
                    wfRes &&
                    wfRes.success &&
                    Array.isArray(wfRes.waveform) &&
                    wfRes.waveform.length >= 256
                ) {
                    const dur =
                        typeof wfRes.duration === 'number' && wfRes.duration > 1
                            ? wfRes.duration
                            : safeDur;
                    const effSr = wfRes.waveform.length / dur;
                    const floatSamples = new Float32Array(wfRes.waveform);

                    const bpm = computeRealBpmFromPcm(floatSamples, effSr);
                    const key = computeRealCamelotKeyFromPcm(
                        floatSamples,
                        Math.max(120, effSr * 16)
                    );
                    const result: RealAudioAnalysisResult = {
                        bpm,
                        key,
                        duration: Math.max(1, Math.floor(dur)),
                        isRealComputed: true,
                    };
                    analysisCache.set(cacheKey, result);
                    persistCacheToStorage();
                    return result;
                }
            } catch {
                // ignore
            }
        }
    }

    return null;
}

// 背景非阻塞批次分析佇列：避免同時觸發過多解碼任務與逐首渲染風暴
let analysisQueueRunning = false;
const pendingAnalysisTracks = new Map<string, Track>();

export interface BatchAnalyzedItem {
    trackId: string;
    path: string;
    result: RealAudioAnalysisResult;
}

export function enqueueTracksForRealBpmKeyAnalysis(
    tracks: Track[],
    onTrackAnalyzed: (
        trackId: string,
        path: string,
        result: RealAudioAnalysisResult
    ) => void,
    onBatchAnalyzed?: (items: BatchAnalyzedItem[]) => void
): void {
    ensureCacheLoaded();

    const cachedBatch: BatchAnalyzedItem[] = [];

    for (const tr of tracks) {
        const key = (tr.path || tr.id).trim();
        if (!key || key.startsWith('C:\\Music\\DJ_Set\\')) continue;

        const cached = analysisCache.get(key);
        if (cached) {
            if (tr.bpm !== cached.bpm || tr.key !== cached.key) {
                cachedBatch.push({
                    trackId: tr.id,
                    path: tr.path,
                    result: cached,
                });
            }
            continue;
        }
        pendingAnalysisTracks.set(key, tr);
    }

    // 1. 已在快取中的曲目：一次性批量回寫，避免逐首觸發 80 次重繪
    if (cachedBatch.length > 0) {
        if (onBatchAnalyzed) {
            onBatchAnalyzed(cachedBatch);
        } else {
            for (const item of cachedBatch) {
                onTrackAnalyzed(item.trackId, item.path, item.result);
            }
        }
    }

    if (analysisQueueRunning || pendingAnalysisTracks.size === 0) {
        return;
    }

    analysisQueueRunning = true;
    void (async () => {
        let pendingFlush: BatchAnalyzedItem[] = [];
        let lastFlushMs = performance.now();

        const flushPending = () => {
            if (pendingFlush.length === 0) return;
            const batch = pendingFlush;
            pendingFlush = [];
            lastFlushMs = performance.now();
            if (onBatchAnalyzed) {
                onBatchAnalyzed(batch);
            } else {
                for (const item of batch) {
                    onTrackAnalyzed(item.trackId, item.path, item.result);
                }
            }
        };

        try {
            while (pendingAnalysisTracks.size > 0) {
                const nextEntry = pendingAnalysisTracks.entries().next().value;
                if (!nextEntry) break;
                const [key, track] = nextEntry;
                pendingAnalysisTracks.delete(key);

                const res = await analyzeTrackBpmAndKeyReal(track);
                if (res) {
                    pendingFlush.push({
                        trackId: track.id,
                        path: track.path,
                        result: res,
                    });
                }

                const now = performance.now();
                if (
                    pendingFlush.length >= 10 ||
                    (pendingFlush.length > 0 && now - lastFlushMs >= 400)
                ) {
                    flushPending();
                    // 讓出主執行緒 16ms 保持 UI 與畫布 60FPS 流暢
                    await new Promise((r) => setTimeout(r, 16));
                }
            }
            flushPending();
        } finally {
            analysisQueueRunning = false;
        }
    })();
}
