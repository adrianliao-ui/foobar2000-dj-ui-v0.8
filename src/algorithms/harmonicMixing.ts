import type { AlbumGroup, Track } from '../types/track';
import type { HarmonicStatus, TransitionAnalysis } from '../types/workflow';

/**
 * 解析後的 Camelot 調性結構 (例如 "8A" -> step: 8, mode: 'A')
 */
export interface ParsedCamelotKey {
    step: number;    // 1 ~ 12
    mode: 'A' | 'B'; // A 為小調 (Minor), B 為大調 (Major)
}

/**
 * 調性關係分類
 */
export type KeyRelationType =
    | 'exact'         // 完全同調 (例如 8A -> 8A)
    | 'adjacent'      // 五度圈相鄰 ±1 (例如 8A -> 7A 或 9A)
    | 'relative'      // 關係大小調轉換 (例如 8A <-> 8B)
    | 'energy_boost'  // 能量提升轉調 (+2 或 +7 步)
    | 'incompatible'; // 調性衝突 (Key Clash)

/**
 * 解析 Camelot Key 字串 (例如 "8A", "12B")
 */
export const parseCamelotKey = (keyStr: string): ParsedCamelotKey | null => {
    const normalized = keyStr.trim().toUpperCase();
    const match = /^([1-9]|1[0-2])([AB])$/.exec(normalized);
    if (!match) {
        return null;
    }

    return {
        step: Number(match[1]),
        mode: match[2] as 'A' | 'B',
    };
};

export interface CamelotColorSpec {
    hex: string;           // 駱駝色輪代表主色碼 (與 CamelotWheelOverlay 完全一致)
    bgStyle: string;       // 時間軸曲目區塊漸層/半透明背景色 (CSS background)
    borderStyle: string;   // 時間軸曲目區塊邊框色 (CSS borderColor)
    badgeBgStyle: string;  // 色號膠囊背景色
}

const CAMELOT_STEP_HEX_MAP: Record<number, string> = {
    12: '#06b6d4', // Cyan (E / C#m)
    1: '#14b8a6',  // Teal (B / G#m)
    2: '#10b981',  // Emerald (F# / Ebm)
    3: '#22c55e',  // Green (Db / Bbm)
    4: '#84cc16',  // Lime (Ab / Fm)
    5: '#eab308',  // Yellow (Eb / Cm)
    6: '#f59e0b',  // Amber (Bb / Gm)
    7: '#f97316',  // Orange (F / Dm)
    8: '#ef4444',  // Red (C / Am)
    9: '#ec4899',  // Pink (G / Em)
    10: '#a855f7', // Purple (D / Bm)
    11: '#6366f1', // Indigo (A / F#m)
};

/**
 * 根據曲目的駱駝色輪色號 (1A~12B) 取得對應的標準駱駝色輪色相與時間軸區塊樣式
 */
export const getCamelotKeyColorSpec = (
    keyStr?: string | null
): CamelotColorSpec => {
    const parsed = keyStr ? parseCamelotKey(keyStr) : null;
    if (!parsed) {
        return {
            hex: '#475569',
            bgStyle: 'rgba(51, 65, 85, 0.82)',
            borderStyle: 'rgba(148, 163, 184, 0.75)',
            badgeBgStyle: 'rgba(15, 23, 42, 0.72)',
        };
    }

    const baseHex = CAMELOT_STEP_HEX_MAP[parsed.step] ?? '#06b6d4';
    // B 圈 (Major 大調) 飽和度與亮度略高，A 圈 (Minor 小調) 沉穩飽和，皆維持與駱駝色輪一致的色相
    const alphaTop = parsed.mode === 'B' ? 'd9' : 'bf';
    const alphaBottom = parsed.mode === 'B' ? '99' : '82';

    return {
        hex: baseHex,
        bgStyle: `linear-gradient(180deg, ${baseHex}${alphaTop} 0%, ${baseHex}${alphaBottom} 100%)`,
        borderStyle: baseHex,
        badgeBgStyle: 'rgba(2, 6, 23, 0.65)',
    };
};

/**
 * 計算駱駝輪圓環上的最短距離 (1 與 12 相鄰，距離為 1)
 */
const getCircularDistance = (stepA: number, stepB: number): number => {
    const diff = Math.abs(stepA - stepB);
    return Math.min(diff, 12 - diff);
};

/**
 * 評估兩個 Camelot Key 之間的樂理關係與分數 (滿分 50 分)
 */
export const evaluateKeyCompatibility = (
    sourceKey: string,
    targetKey: string
): { relation: KeyRelationType; score: number; message: string } => {
    const parsedSource = parseCamelotKey(sourceKey);
    const parsedTarget = parseCamelotKey(targetKey);

    if (!parsedSource || !parsedTarget) {
        return {
            relation: 'incompatible',
            score: 10,
            message: '未標記有效 Camelot 調性',
        };
    }

    const distance = getCircularDistance(parsedSource.step, parsedTarget.step);
    const sameMode = parsedSource.mode === parsedTarget.mode;

    // 1. 完全同調 (8A -> 8A)
    if (distance === 0 && sameMode) {
        return {
            relation: 'exact',
            score: 50,
            message: `完全同調 (${sourceKey})，可無縫疊歌`,
        };
    }

    // 2. 關係大小調轉換 (8A <-> 8B)
    if (distance === 0 && !sameMode) {
        return {
            relation: 'relative',
            score: 45,
            message: `關係大小調轉換 (${sourceKey} → ${targetKey})`,
        };
    }

    // 3. 五度圈相鄰諧波 ±1 (8A -> 7A 或 9A)
    if (distance === 1 && sameMode) {
        return {
            relation: 'adjacent',
            score: 45,
            message: `五度圈相鄰諧波 (${sourceKey} → ${targetKey})`,
        };
    }

    // 4. 能量提升跳躍 (+2 全音升調 或 +7 半音升調)
    const forwardSteps = (parsedTarget.step - parsedSource.step + 12) % 12;
    if (sameMode && (forwardSteps === 2 || forwardSteps === 7)) {
        return {
            relation: 'energy_boost',
            score: 35,
            message: `能量提升轉調 (${sourceKey} → ${targetKey})`,
        };
    }

    // 5. 調性衝突 (Key Clash)
    return {
        relation: 'incompatible',
        score: 5,
        message: `調性衝突 (${sourceKey} → ${targetKey})，建議以 Cut 或 Silence 轉場`,
    };
};

/**
 * 評估兩個 BPM 之間的速度相容性與 Pitch 調整幅度 (滿分 50 分)
 * 支援計算帶正負號的 Pitch 百分比 (例如 Pitch +1.5% 或 Pitch -2.0%)
 */
export const evaluateBpmCompatibility = (
    sourceBpm: number,
    targetBpm: number
): {
    bpmDiff: number;
    pitchPercent: number;
    suggestedPitchText: string;
    score: number;
} => {
    if (sourceBpm <= 0 || targetBpm <= 0) {
        return {
            bpmDiff: 0,
            pitchPercent: 0,
            suggestedPitchText: 'Pitch 0.0%',
            score: 25,
        };
    }

    // 考量原速、兩倍速 (Double-time) 與半速 (Half-time)，找出最接近的目標等效 BPM
    const candidates = [targetBpm, targetBpm * 2, targetBpm / 2];
    let bestTargetBpm = targetBpm;
    let minAbsDiff = Math.abs(targetBpm - sourceBpm);

    for (const candidate of candidates) {
        const diff = Math.abs(candidate - sourceBpm);
        if (diff < minAbsDiff) {
            minAbsDiff = diff;
            bestTargetBpm = candidate;
        }
    }

    // 計算從 sourceBpm 同步至 targetBpm 所需的相對 Pitch 調整幅度 (%)
    const rawPitchPercent = ((bestTargetBpm - sourceBpm) / sourceBpm) * 100;
    const pitchPercent = Number(rawPitchPercent.toFixed(1));
    const absPercent = Math.abs(pitchPercent);
    const bpmDiff = Number(minAbsDiff.toFixed(1));

    const sign = pitchPercent > 0 ? '+' : '';
    const suggestedPitchText = `Pitch ${sign}${pitchPercent.toFixed(1)}%`;

    if (absPercent <= 2.0) {
        return { bpmDiff, pitchPercent, suggestedPitchText, score: 50 };
    }
    if (absPercent <= 4.0) {
        return { bpmDiff, pitchPercent, suggestedPitchText, score: 38 };
    }
    if (absPercent <= 6.0) {
        return { bpmDiff, pitchPercent, suggestedPitchText, score: 25 };
    }
    return { bpmDiff, pitchPercent, suggestedPitchText, score: 5 };
};

/**
 * 綜合評估由來源節點過渡至目標節點的樂理與拍速狀態 (規格書 4.3)
 * - harmonic (綠色 #10b981): 調性諧和且 BPM 差距在極佳範圍內
 * - noticeable (黃色 #f59e0b): 調性或速度有明顯落差，提示建議 Pitch 調整幅度
 * - clash (紅色 #ef4444): 嚴重撞調或速度差距過大
 */
export const analyzeTransition = (
    sourceBpm: number,
    sourceKey: string,
    targetBpm: number,
    targetKey: string
): TransitionAnalysis => {
    const keyEval = evaluateKeyCompatibility(sourceKey, targetKey);
    const bpmEval = evaluateBpmCompatibility(sourceBpm, targetBpm);

    const totalScore = keyEval.score + bpmEval.score;
    const absPitch = Math.abs(bpmEval.pitchPercent);

    let status: HarmonicStatus = 'clash';
    let suggestedEdgeColor = '#ef4444'; // 紅色警示 (Key Clash / Severe BPM mismatch)

    if (keyEval.relation !== 'incompatible' && totalScore >= 80 && absPitch <= 3.5) {
        status = 'harmonic';
        suggestedEdgeColor = '#10b981'; // 綠色諧和 (Harmonic)
    } else if (keyEval.relation !== 'incompatible' && absPitch <= 6.5) {
        status = 'noticeable';
        suggestedEdgeColor = '#f59e0b'; // 黃色強行相銜 (Noticeable Difference)
    } else if (keyEval.relation === 'incompatible' && absPitch <= 2.0) {
        // 雖然跨調，但拍速極度吻合，列為黃色強行相銜並提示注意調性
        status = 'noticeable';
        suggestedEdgeColor = '#f59e0b';
    }

    return {
        score: totalScore,
        status,
        keyRelationMessage: keyEval.message,
        bpmDiff: bpmEval.bpmDiff,
        pitchPercent: bpmEval.pitchPercent,
        suggestedPitchText: bpmEval.suggestedPitchText,
        suggestedEdgeColor,
    };
};

/**
 * 評估兩首單曲 (Track -> Track) 之間的混音契合度
 */
export const analyzeTrackTransition = (
    sourceTrack: Track,
    targetTrack: Track
): TransitionAnalysis => {
    return analyzeTransition(
        sourceTrack.bpm,
        sourceTrack.key,
        targetTrack.bpm,
        targetTrack.key
    );
};

/**
 * 評估畫布上兩張專輯卡片 (AlbumGroup -> AlbumGroup) 之間的連線契合度
 * 自動比對來源卡片「最後一首歌 (exitBpm / entryKey)」與目標卡片「第一首歌 (entryBpm / entryKey)」
 */
export const analyzeAlbumGroupTransition = (
    sourceGroup: AlbumGroup,
    targetGroup: AlbumGroup
): TransitionAnalysis => {
    return analyzeTransition(
        sourceGroup.exitBpm,
        sourceGroup.exitKey,
        targetGroup.entryBpm,
        targetGroup.entryKey
    );
};

/**
 * 推薦下一首混音曲目的回傳結構
 */
export interface SuggestedNextTrack {
    track: Track;
    analysis: TransitionAnalysis;
}

/**
 * 推薦下一首曲目的篩選選項
 */
export interface GetSuggestedNextTracksOptions {
    limit?: number;            // 最多回傳筆數（預設 5）
    includeNoticeable?: boolean; // 是否包含黃燈 noticeable 曲目（預設 true，排除紅燈 clash）
    excludeTrackIds?: string[];  // 額外欲排除的曲目 ID 清單
}

/**
 * 根據當前播放曲目的 BPM 與 Camelot Key，從 allTracks 中篩選並排序出最適合混音的下一首曲目建議
 * - 自動排除當前播放曲目本身（同時比對 id 與正規化路徑）與調性完全不相容的曲目
 * - 依「諧和狀態 (harmonic 優先) -> 綜合樂理評分 (高至低) -> Pitch 調整幅度絕對值 (小至大)」排序
 * - [修復問題 5：部分曲目雖已計算出駱駝色號，卻沒有顯示推薦混音曲目的問題]
 *   造成錯誤的原因：先前 `analyzeTransition` 規定當兩首歌的 BPM 差距（考慮原速/倍速/半速後）超過 `6.5%` 時，即便駱駝色號 100% 諧和（如同調 `8A -> 8A`、相鄰 `7A/9A`、關係大小調 `8B`），
 *   也會將 `status` 設為 `'clash'` 並在 `if (analysis.status === 'clash') continue;` 中全數丟棄，導致當媒體庫內同調曲目的 BPM 與當前曲目差距超過 6.5% 時，推薦列表變成空白（0 首）。
 *   修改的目的：第一階段優先篩選調性與 BPM 皆在標準範圍內的曲目；若不足 `limit` 筆且當前曲目具有有效駱駝色號，第二階段自動納入所有「駱駝調性諧和（同調、相鄰 ±1、關係大小調、+2/+7 能量轉調）」的曲目（標記為黃燈 `noticeable` 並提示所需 Pitch / 轉場方式），確保任何有駱駝色號的曲目都能穩定顯示推薦混音清單！
 */
export const getSuggestedNextTracks = (
    currentTrack: Track | null,
    allTracks: Track[],
    options: GetSuggestedNextTracksOptions = {}
): SuggestedNextTrack[] => {
    if (!currentTrack || allTracks.length === 0) {
        return [];
    }

    const {
        limit = 5,
        includeNoticeable = true,
        excludeTrackIds = [],
    } = options;

    const normalizePathKey = (p?: string | null): string =>
        (p ?? '')
            .trim()
            .replace(/^file:\/\/\/?/i, '')
            .replace(/\//g, '\\')
            .toLowerCase();

    const currentNormPath = normalizePathKey(currentTrack.path);
    const excludedSet = new Set<string>([currentTrack.id, ...excludeTrackIds]);

    const statusRank: Record<HarmonicStatus, number> = {
        harmonic: 3,
        noticeable: 2,
        clash: 1,
    };

    const evaluated: SuggestedNextTrack[] = [];
    const harmonicKeyFallbackCandidates: SuggestedNextTrack[] = [];

    for (const candidate of allTracks) {
        if (excludedSet.has(candidate.id)) continue;
        if (
            currentNormPath &&
            normalizePathKey(candidate.path) === currentNormPath
        ) {
            continue;
        }

        const analysis = analyzeTrackTransition(currentTrack, candidate);

        if (analysis.status !== 'clash') {
            if (!includeNoticeable && analysis.status !== 'harmonic') continue;
            evaluated.push({
                track: candidate,
                analysis,
            });
            continue;
        }

        // 若因 BPM 差距 > 6.5% 被歸為 clash，但兩首歌的駱駝色號屬於樂理諧和關係 (exact / relative / adjacent / energy_boost)，納入調性諧和備援池
        if (includeNoticeable) {
            const keyEval = evaluateKeyCompatibility(
                currentTrack.key,
                candidate.key
            );
            if (keyEval.relation !== 'incompatible') {
                const bpmEval = evaluateBpmCompatibility(
                    currentTrack.bpm,
                    candidate.bpm
                );
                harmonicKeyFallbackCandidates.push({
                    track: candidate,
                    analysis: {
                        ...analysis,
                        status: 'noticeable',
                        score: keyEval.score + bpmEval.score,
                        keyRelationMessage: `${keyEval.message} (跨速混音 Δ${bpmEval.bpmDiff} BPM)`,
                        suggestedEdgeColor: '#f59e0b',
                    },
                });
            }
        }
    }

    const sortSuggestions = (list: SuggestedNextTrack[]) => {
        list.sort((a, b) => {
            // 1. 優先比較諧和等級 (harmonic > noticeable)
            const rankDiff =
                statusRank[b.analysis.status] - statusRank[a.analysis.status];
            if (rankDiff !== 0) return rankDiff;

            // 2. 綜合評分高者優先
            if (b.analysis.score !== a.analysis.score) {
                return b.analysis.score - a.analysis.score;
            }

            // 3. Pitch 調整百分比絕對值越小越優先
            const absPitchA = Math.abs(a.analysis.pitchPercent);
            const absPitchB = Math.abs(b.analysis.pitchPercent);
            if (absPitchA !== absPitchB) {
                return absPitchA - absPitchB;
            }

            // 4. 最後依 BPM 絕對差值由小到大排序
            return a.analysis.bpmDiff - b.analysis.bpmDiff;
        });
    };

    sortSuggestions(evaluated);

    const targetLimit = Math.max(1, limit);
    if (
        evaluated.length < targetLimit &&
        harmonicKeyFallbackCandidates.length > 0
    ) {
        sortSuggestions(harmonicKeyFallbackCandidates);
        const needed = targetLimit - evaluated.length;
        evaluated.push(...harmonicKeyFallbackCandidates.slice(0, needed));
    }

    return evaluated.slice(0, targetLimit);
};

/**
 * [新增功能 3] 自動替畫布上所有曲目實例按照駱駝色輪色號與 BPM 計算最佳諧波接歌順序 (純函式)
 * - 將所有曲目打散為單曲粒度，分別以每一首曲目作為候選起點執行貪婪最佳諧波接歌搜尋 + 2-opt 局部優化
 * - 選出整條播放佇列累計諧波契合度總分最高者作為最終推薦序列
 */
export const buildOptimalHarmonicTrackSequence = (
    tracks: Track[]
): Track[] => {
    const n = tracks.length;
    if (n <= 1) {
        return [...tracks];
    }

    const statusRank: Record<HarmonicStatus, number> = {
        harmonic: 3,
        noticeable: 2,
        clash: 1,
    };

    // 預先建立 n x n 兩兩轉場複合權重矩陣，確保多起點評估與 2-opt 優化在毫秒內完成
    const edgeWeightMatrix: number[][] = Array.from({ length: n }, () =>
        new Array<number>(n).fill(0)
    );

    for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) {
            if (i === j) continue;
            const analysis = analyzeTrackTransition(tracks[i], tracks[j]);
            const keyEval = evaluateKeyCompatibility(
                tracks[i].key,
                tracks[j].key
            );
            // 複合權重：優先考量諧和狀態與駱駝色輪調性分數，再依總分與 Pitch 最小差值細分
            const harmonicTierBonus = statusRank[analysis.status] * 1000;
            const keyScoreBonus = keyEval.score * 12;
            const totalScoreBonus = analysis.score * 4;
            const pitchPenalty = Math.min(
                200,
                Math.abs(analysis.pitchPercent) * 6
            );
            edgeWeightMatrix[i][j] =
                harmonicTierBonus +
                keyScoreBonus +
                totalScoreBonus -
                pitchPenalty;
        }
    }

    const computePathTotalWeight = (order: number[]): number => {
        let sum = 0;
        for (let i = 0; i < order.length - 1; i++) {
            sum += edgeWeightMatrix[order[i]][order[i + 1]];
        }
        return sum;
    };

    let bestOrder: number[] = [];
    let bestTotalWeight = -Infinity;

    // 測試每一個曲目作為起點，找出全局總分最高的起點與路徑
    for (let startIdx = 0; startIdx < n; startIdx++) {
        const visited = new Uint8Array(n);
        const path: number[] = [startIdx];
        visited[startIdx] = 1;

        while (path.length < n) {
            const lastIdx = path[path.length - 1];
            let nextBestIdx = -1;
            let nextBestWeight = -Infinity;

            for (let candidateIdx = 0; candidateIdx < n; candidateIdx++) {
                if (visited[candidateIdx]) continue;
                const w = edgeWeightMatrix[lastIdx][candidateIdx];
                if (w > nextBestWeight) {
                    nextBestWeight = w;
                    nextBestIdx = candidateIdx;
                }
            }

            if (nextBestIdx === -1) break;
            visited[nextBestIdx] = 1;
            path.push(nextBestIdx);
        }

        // 對當前起點的貪婪路徑執行輕量 2-opt 局部區間反轉優化（上限 2 輪，確保大型畫布亦 0 延遲）
        for (let pass = 0; pass < 2; pass++) {
            let improved = false;
            for (let i = 0; i < n - 2; i++) {
                for (let k = i + 1; k < Math.min(n - 1, i + 10); k++) {
                    const currentWeight = computePathTotalWeight(path);
                    const candidatePath = [
                        ...path.slice(0, i),
                        ...path.slice(i, k + 1).reverse(),
                        ...path.slice(k + 1),
                    ];
                    const candidateWeight =
                        computePathTotalWeight(candidatePath);
                    if (candidateWeight > currentWeight + 0.01) {
                        for (let m = 0; m < n; m++) {
                            path[m] = candidatePath[m];
                        }
                        improved = true;
                    }
                }
            }
            if (!improved) break;
        }

        const totalWeight = computePathTotalWeight(path);
        if (totalWeight > bestTotalWeight) {
            bestTotalWeight = totalWeight;
            bestOrder = path;
        }
    }

    return bestOrder.map((idx) => tracks[idx]);
};