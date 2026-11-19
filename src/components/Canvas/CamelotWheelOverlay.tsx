import { useMemo } from 'react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useWorkflowStore } from '../../store/useWorkflowStore';
import { usePlaylistStore } from '../../store/usePlaylistStore';
import { isM3LayoutTheme, useThemeStore } from '../../store/useThemeStore';
import { getCachedRealAudioAnalysis } from '../../utils/audioAnalyzer';

// ============================================================================
// [組件] CamelotWheelOverlay：Workflow Canvas 右上角可開關的 24 格視覺化駱駝色輪圖層（加大清晰版）
// 即時高亮顯示「當前播放中曲目 (NOW)」與「下一首排程曲目 (NEXT)」在色輪上的位置與諧波動線
// ============================================================================

interface CamelotHourSpec {
    hour: number; // 1 ~ 12 (對應鐘面 1 點鐘 ~ 12 點鐘方向)
    majorKey: string; // 外圈 B (Major)
    minorKey: string; // 內圈 A (Minor)
    majorNote: string;
    minorNote: string;
    color: string; // 標準駱駝色輪代表色碼
}

const CAMELOT_WHEEL_SPECS: readonly CamelotHourSpec[] = [
    { hour: 12, majorKey: '12B', minorKey: '12A', majorNote: 'E', minorNote: 'C#m', color: '#06b6d4' },
    { hour: 1, majorKey: '1B', minorKey: '1A', majorNote: 'B', minorNote: 'G#m', color: '#14b8a6' },
    { hour: 2, majorKey: '2B', minorKey: '2A', majorNote: 'F#', minorNote: 'Ebm', color: '#10b981' },
    { hour: 3, majorKey: '3B', minorKey: '3A', majorNote: 'Db', minorNote: 'Bbm', color: '#22c55e' },
    { hour: 4, majorKey: '4B', minorKey: '4A', majorNote: 'Ab', minorNote: 'Fm', color: '#84cc16' },
    { hour: 5, majorKey: '5B', minorKey: '5A', majorNote: 'Eb', minorNote: 'Cm', color: '#eab308' },
    { hour: 6, majorKey: '6B', minorKey: '6A', majorNote: 'Bb', minorNote: 'Gm', color: '#f59e0b' },
    { hour: 7, majorKey: '7B', minorKey: '7A', majorNote: 'F', minorNote: 'Dm', color: '#f97316' },
    { hour: 8, majorKey: '8B', minorKey: '8A', majorNote: 'C', minorNote: 'Am', color: '#ef4444' },
    { hour: 9, majorKey: '9B', minorKey: '9A', majorNote: 'G', minorNote: 'Em', color: '#ec4899' },
    { hour: 10, majorKey: '10B', minorKey: '10A', majorNote: 'D', minorNote: 'Bm', color: '#a855f7' },
    { hour: 11, majorKey: '11B', minorKey: '11A', majorNote: 'A', minorNote: 'F#m', color: '#6366f1' },
];

/**
 * 計算 SVG 環狀扇形路徑 (Donut Sector Path)
 */
function buildAnnularSectorPath(
    cx: number,
    cy: number,
    rInner: number,
    rOuter: number,
    startDeg: number,
    endDeg: number
): string {
    const toRad = (deg: number) => (deg * Math.PI) / 180;
    const rStart = toRad(startDeg);
    const rEnd = toRad(endDeg);

    const x1Out = cx + rOuter * Math.cos(rStart);
    const y1Out = cy + rOuter * Math.sin(rStart);
    const x2Out = cx + rOuter * Math.cos(rEnd);
    const y2Out = cy + rOuter * Math.sin(rEnd);

    const x1In = cx + rInner * Math.cos(rEnd);
    const y1In = cy + rInner * Math.sin(rEnd);
    const x2In = cx + rInner * Math.cos(rStart);
    const y2In = cy + rInner * Math.sin(rStart);

    return [
        `M ${x1Out.toFixed(2)} ${y1Out.toFixed(2)}`,
        `A ${rOuter} ${rOuter} 0 0 1 ${x2Out.toFixed(2)} ${y2Out.toFixed(2)}`,
        `L ${x1In.toFixed(2)} ${y1In.toFixed(2)}`,
        `A ${rInner} ${rInner} 0 0 0 ${x2In.toFixed(2)} ${y2In.toFixed(2)}`,
        'Z',
    ].join(' ');
}

function getSectorCenterPoint(
    cx: number,
    cy: number,
    hour: number,
    ring: 'A' | 'B'
): { x: number; y: number } {
    const angleDeg = (hour % 12) * 30 - 90;
    const rad = (angleDeg * Math.PI) / 180;
    // 外圈 B 中心半徑 117，內圈 A 中心半徑 71
    const radius = ring === 'B' ? 117 : 71;
    return {
        x: cx + radius * Math.cos(rad),
        y: cy + radius * Math.sin(rad),
    };
}

function parseCamelotCode(rawKey?: string | null): {
    hour: number;
    ring: 'A' | 'B';
    normalized: string;
} | null {
    if (!rawKey) return null;
    const match = /^(\d{1,2})([AB])$/i.exec(rawKey.trim());
    if (!match) return null;
    const hour = Number(match[1]);
    const ring = match[2].toUpperCase() as 'A' | 'B';
    if (hour < 1 || hour > 12) return null;
    return { hour, ring, normalized: `${hour}${ring}` };
}

function describeHarmonicRelation(
    nowParsed: { hour: number; ring: 'A' | 'B'; normalized: string } | null,
    nextParsed: { hour: number; ring: 'A' | 'B'; normalized: string } | null,
    isCafeMica: boolean
): { text: string; badgeClass: string } {
    if (!nowParsed || !nextParsed) {
        return {
            text: '等待排程下一首曲目以分析色輪動線',
            badgeClass: isCafeMica
                ? 'text-[#6e4f3d] border-[#c49874]/60 bg-[#f6ece0]'
                : 'text-slate-400 border-slate-700 bg-slate-900/80',
        };
    }
    const diffRaw = Math.abs(nowParsed.hour - nextParsed.hour);
    const circularDiff = Math.min(diffRaw, 12 - diffRaw);

    if (circularDiff === 0 && nowParsed.ring === nextParsed.ring) {
        return {
            text: `${nowParsed.normalized} → ${nextParsed.normalized} • 同調無縫完美鎖定`,
            badgeClass: isCafeMica
                ? 'text-[#1e5638] border-[#4e8763]/65 bg-[#dcf0e2]'
                : 'text-emerald-300 border-emerald-500/60 bg-emerald-950/70',
        };
    }
    if (circularDiff === 0 && nowParsed.ring !== nextParsed.ring) {
        return {
            text: `${nowParsed.normalized} → ${nextParsed.normalized} • 關係大小調轉換 (內外圈諧和)`,
            badgeClass: isCafeMica
                ? 'text-[#1b506b] border-[#38bdf8]/60 bg-[#dff0f8]'
                : 'text-cyan-300 border-cyan-500/60 bg-cyan-950/70',
        };
    }
    if (circularDiff === 1 && nowParsed.ring === nextParsed.ring) {
        return {
            text: `${nowParsed.normalized} → ${nextParsed.normalized} • 五度圈相鄰諧和 (±1 順暢接歌)`,
            badgeClass: isCafeMica
                ? 'text-[#1e5638] border-[#4e8763]/65 bg-[#dcf0e2]'
                : 'text-emerald-300 border-emerald-500/60 bg-emerald-950/70',
        };
    }
    if (circularDiff === 2 && nowParsed.ring === nextParsed.ring) {
        return {
            text: `${nowParsed.normalized} → ${nextParsed.normalized} • 全音能量推進 (±2 Energy Boost)`,
            badgeClass: isCafeMica
                ? 'text-[#7c3d12] border-[#c87d4b]/65 bg-[#f7e3ce]'
                : 'text-amber-300 border-amber-500/60 bg-amber-950/70',
        };
    }
    return {
        text: `${nowParsed.normalized} → ${nextParsed.normalized} • 跨度轉場 (建議搭配 Cut 或留白)`,
        badgeClass: isCafeMica
            ? 'text-[#882633] border-[#d46a76]/60 bg-[#fae0e3]'
            : 'text-rose-300 border-rose-500/60 bg-rose-950/70',
    };
}

export interface CamelotWheelOverlayProps {
    onClose: () => void;
}

export function CamelotWheelOverlay({ onClose }: CamelotWheelOverlayProps) {
    const { currentTrack, currentQueueOrder } = usePlayerStore();
    const playlist = useWorkflowStore((s) => s.playlist);
    const allTracks = usePlaylistStore((s) => s.allTracks);
    const themeId = useThemeStore((s) => s.themeId);
    const isM3Style = isM3LayoutTheme(themeId);
    const isCafeMica = themeId === 'm3-cafe-mica';

    // [修復問題 1：移除對整個 selectedTrackIds 陣列的訂閱]
    // 造成錯誤的原因：先前同時訂閱了 selectedTrack 與 selectedTrackIds，導致在左側媒體庫多選曲目時，每次點擊都會觸發 24 格 SVG 駱駝色輪重新計算。
    // 修改的目的：僅訂閱單一代表選取曲目 selectedTrack，減少多選操作時的連帶重繪負擔。
    const selectedTrack = usePlaylistStore((s) => s.selectedTrack);

    // 計算「選取中曲目 (SEL)」、「當前播放中曲目 (NOW，永遠綁定時間軸當前位置)」與「下一首曲目 (NEXT)」
    const { selectedTrackInfo, activeTrackInfo, nextTrackInfo } = useMemo(() => {
        const resolveLatestMeta = (item: {
            id?: string;
            trackId?: string;
            path?: string;
            title: string;
            artist: string;
            key: string;
            bpm: number;
        }) => {
            const targetId = item.id ?? item.trackId ?? '';
            const targetPath = item.path ?? '';
            const libMatch = allTracks.find(
                (t) =>
                    (Boolean(targetId) && t.id === targetId) ||
                    (Boolean(targetPath) && t.path === targetPath)
            );
            const cachedAnalysis = getCachedRealAudioAnalysis(
                targetPath || targetId
            );
            return {
                title: item.title,
                artist: item.artist,
                key: cachedAnalysis?.key || libMatch?.key || item.key,
                bpm: cachedAnalysis?.bpm || libMatch?.bpm || item.bpm,
            };
        };

        // 1. 選取曲目 (SEL)：讀取代表選取曲目 selectedTrack
        const selInfo = selectedTrack ? resolveLatestMeta(selectedTrack) : null;

        // 2. 當前曲目 (NOW)：永遠跟隨總時間軸上的當前位置 (currentTrack)，不受試聽影響
        let currentIdxInQueue = -1;
        if (playlist.length > 0) {
            currentIdxInQueue = playlist.findIndex(
                (item) => item.order === currentQueueOrder
            );
            if (currentIdxInQueue === -1 && currentTrack) {
                currentIdxInQueue = playlist.findIndex(
                    (item) => item.trackId === currentTrack.id
                );
            }
        }

        const currentSource =
            currentTrack ??
            (currentIdxInQueue >= 0
                ? playlist[currentIdxInQueue]
                : playlist[0] ?? null);

        const currentInfo = currentSource
            ? resolveLatestMeta(currentSource)
            : null;

        // 3. 下一首曲目 (NEXT)：根據時間軸佇列順序取得下一首
        let nextQueueItem = null;
        if (playlist.length > 0) {
            if (
                currentIdxInQueue >= 0 &&
                currentIdxInQueue + 1 < playlist.length
            ) {
                nextQueueItem = playlist[currentIdxInQueue + 1];
            } else if (currentIdxInQueue === -1 && playlist.length >= 2) {
                nextQueueItem = playlist[1];
            } else if (
                currentIdxInQueue === -1 &&
                playlist.length === 1 &&
                playlist[0].trackId !== currentTrack?.id
            ) {
                nextQueueItem = playlist[0];
            }
        }

        const nextInfo = nextQueueItem
            ? resolveLatestMeta(nextQueueItem)
            : null;

        return {
            selectedTrackInfo: selInfo,
            activeTrackInfo: currentInfo,
            nextTrackInfo: nextInfo,
        };
    }, [
        selectedTrack,
        currentTrack,
        currentQueueOrder,
        playlist,
        allTracks,
    ]);

    const selParsed = useMemo(
        () => parseCamelotCode(selectedTrackInfo?.key),
        [selectedTrackInfo?.key]
    );
    const nowParsed = useMemo(
        () => parseCamelotCode(activeTrackInfo?.key),
        [activeTrackInfo?.key]
    );
    const nextParsed = useMemo(
        () => parseCamelotCode(nextTrackInfo?.key),
        [nextTrackInfo?.key]
    );

    const cx = 152;
    const cy = 152;

    const selPoint = selParsed
        ? getSectorCenterPoint(cx, cy, selParsed.hour, selParsed.ring)
        : null;
    const nowPoint = nowParsed
        ? getSectorCenterPoint(cx, cy, nowParsed.hour, nowParsed.ring)
        : null;
    const nextPoint = nextParsed
        ? getSectorCenterPoint(cx, cy, nextParsed.hour, nextParsed.ring)
        : null;

    const relation = describeHarmonicRelation(nowParsed, nextParsed, isCafeMica);

    // 造成原錯誤的原因：面板 Material 3 化後，畫布功能列移入畫布上方內部，固定 top-3 導致駱駝色輪彈出時遮擋右上角功能列；且 z-20 與頂部工具列同級。
    // 本次修改的目的：在 M3 主題下將駱駝色輪位置下移至 top-14，並將層級提升至 z-30，確保恆位於畫布節點與連線 Transition 設定彈窗 (畫布根層級 z-10) 之上。
    return (
        <div
            className={`absolute ${
                isM3Style ? 'top-14' : 'top-3'
            } right-3 z-30 w-[332px] backdrop-blur-xl border p-3 flex flex-col gap-2.5 select-none pointer-events-auto ${
                isCafeMica
                    ? 'bg-[#fffaf4]/95 border-[#c49874]/60 rounded-2xl shadow-[0_16px_38px_rgba(92,62,42,0.22)]'
                    : isM3Style
                      ? 'bg-[#171c26]/95 border-[#a8c7fa]/25 rounded-2xl shadow-[0_16px_40px_rgba(0,0,0,0.88)]'
                      : 'bg-slate-950/95 border-slate-700/90 rounded-xl shadow-[0_16px_40px_rgba(0,0,0,0.88)]'
            }`}
        >
            {/* 頂部標題與關閉按鈕 */}
            <div
                className={`flex items-center justify-between gap-2 border-b pb-1.5 ${
                    isCafeMica ? 'border-[#c49874]/35' : 'border-slate-800/90'
                }`}
            >
                <div className="flex items-center gap-1.5">
                    <span className="text-sm">🎡</span>
                    <span
                        className={`text-xs font-bold tracking-wide ${
                            isCafeMica ? 'text-[#2b1e17]' : 'text-slate-100'
                        }`}
                    >
                        駱駝色輪 (Camelot Wheel)
                    </span>
                </div>
                <button
                    type="button"
                    onClick={onClose}
                    className={`w-6 h-6 text-xs flex items-center justify-center transition cursor-pointer ${
                        isM3Style ? 'rounded-full' : 'rounded-md'
                    } ${
                        isCafeMica
                            ? 'bg-[#efe2d3] hover:bg-[#e4d2be] text-[#5c4030] hover:text-[#2b1e17] border border-[#c49874]/50'
                            : 'bg-slate-900 hover:bg-slate-800 text-slate-400 hover:text-white'
                    }`}
                    title="隱藏右上角駱駝色輪圖層"
                >
                    ✕
                </button>
            </div>

            {/* 24 格雙同心圓 SVG 駱駝色輪 (加大至 296x296，字體加粗並加上深色描邊襯底) */}
            <div className="relative flex items-center justify-center py-0.5">
                <svg
                    viewBox="0 0 304 304"
                    className="w-[296px] h-[296px] overflow-visible"
                >
                    <defs>
                        <filter
                            id="camelot-now-glow"
                            x="-40%"
                            y="-40%"
                            width="180%"
                            height="180%"
                        >
                            <feGaussianBlur stdDeviation="4" result="blur" />
                            <feMerge>
                                <feMergeNode in="blur" />
                                <feMergeNode in="SourceGraphic" />
                            </feMerge>
                        </filter>
                    </defs>

                    {/* 繪製 12 鐘面方位的外圈 (B • Major, r=95..140) 與內圈 (A • Minor, r=49..92) */}
                    {CAMELOT_WHEEL_SPECS.map((spec) => {
                        const centerAngle = (spec.hour % 12) * 30 - 90;
                        const startDeg = centerAngle - 14.3;
                        const endDeg = centerAngle + 14.3;

                        const outerPath = buildAnnularSectorPath(
                            cx,
                            cy,
                            95,
                            140,
                            startDeg,
                            endDeg
                        );
                        const innerPath = buildAnnularSectorPath(
                            cx,
                            cy,
                            49,
                            92,
                            startDeg,
                            endDeg
                        );

                        const outerCenter = getSectorCenterPoint(
                            cx,
                            cy,
                            spec.hour,
                            'B'
                        );
                        const innerCenter = getSectorCenterPoint(
                            cx,
                            cy,
                            spec.hour,
                            'A'
                        );

                        const isOuterSel =
                            selParsed?.normalized === spec.majorKey;
                        const isOuterNow =
                            nowParsed?.normalized === spec.majorKey;
                        const isOuterNext =
                            nextParsed?.normalized === spec.majorKey;
                        const isOuterActive =
                            isOuterSel || isOuterNow || isOuterNext;

                        const isInnerSel =
                            selParsed?.normalized === spec.minorKey;
                        const isInnerNow =
                            nowParsed?.normalized === spec.minorKey;
                        const isInnerNext =
                            nextParsed?.normalized === spec.minorKey;
                        const isInnerActive =
                            isInnerSel || isInnerNow || isInnerNext;

                        return (
                            <g key={spec.hour}>
                                {/* 外圈 B (Major) 扇形 */}
                                {/* 造成原錯誤的原因：先前在淺色主題將高亮扇形外框設為深褐色 (#2b1e17) 與暗色並套用高斯模糊，導致在彩色扇形上產生髒暗混濁暈染。 */}
                                {/* 本次修改的目的：高亮扇形統一採用純淨杏仁白 (#fffdf9) 描邊，並在淺色主題下移除會造成髒污感的高斯模糊濾鏡。 */}
                                <path
                                    d={outerPath}
                                    fill={spec.color}
                                    fillOpacity={
                                        isOuterNow
                                            ? 0.96
                                            : isOuterSel
                                              ? 0.90
                                              : isOuterNext
                                                ? 0.86
                                                : isCafeMica
                                                  ? 0.58
                                                  : 0.34
                                    }
                                    stroke={
                                        isOuterActive
                                            ? '#fffdf9'
                                            : isCafeMica
                                              ? '#f2e7da'
                                              : '#0f172a'
                                    }
                                    strokeWidth={isOuterActive ? 2.6 : 1.2}
                                    filter={
                                        isOuterActive && !isCafeMica
                                            ? 'url(#camelot-now-glow)'
                                            : undefined
                                    }
                                />
                                {/* 外圈色號 (1B~12B) + 調性音名 */}
                                <text
                                    x={outerCenter.x}
                                    y={outerCenter.y - 4.5}
                                    textAnchor="middle"
                                    dominantBaseline="middle"
                                    fill={isOuterActive ? '#ffffff' : '#f8fafc'}
                                    stroke="#1e140f"
                                    strokeWidth="2.8"
                                    style={{ paintOrder: 'stroke' }}
                                    fontSize={isOuterActive ? '13.5' : '12'}
                                    fontWeight="800"
                                    className="font-mono pointer-events-none"
                                >
                                    {spec.majorKey}
                                </text>
                                <text
                                    x={outerCenter.x}
                                    y={outerCenter.y + 8.5}
                                    textAnchor="middle"
                                    dominantBaseline="middle"
                                    fill={isOuterActive ? '#fef08a' : '#f1f5f9'}
                                    stroke="#1e140f"
                                    strokeWidth="2.2"
                                    style={{ paintOrder: 'stroke' }}
                                    fontSize="9.5"
                                    fontWeight="700"
                                    className="font-mono pointer-events-none"
                                >
                                    {spec.majorNote}
                                </text>

                                {/* 內圈 A (Minor) 扇形 */}
                                <path
                                    d={innerPath}
                                    fill={spec.color}
                                    fillOpacity={
                                        isInnerNow
                                            ? 0.96
                                            : isInnerSel
                                              ? 0.90
                                              : isInnerNext
                                                ? 0.86
                                                : isCafeMica
                                                  ? 0.48
                                                  : 0.26
                                    }
                                    stroke={
                                        isInnerActive
                                            ? '#fffdf9'
                                            : isCafeMica
                                              ? '#f2e7da'
                                              : '#0f172a'
                                    }
                                    strokeWidth={isInnerActive ? 2.6 : 1.2}
                                    filter={
                                        isInnerActive && !isCafeMica
                                            ? 'url(#camelot-now-glow)'
                                            : undefined
                                    }
                                />
                                {/* 內圈色號 (1A~12A) + 小調音名 */}
                                <text
                                    x={innerCenter.x}
                                    y={innerCenter.y - 4}
                                    textAnchor="middle"
                                    dominantBaseline="middle"
                                    fill={isInnerActive ? '#ffffff' : '#f8fafc'}
                                    stroke="#1e140f"
                                    strokeWidth="2.6"
                                    style={{ paintOrder: 'stroke' }}
                                    fontSize={isInnerActive ? '12.5' : '11'}
                                    fontWeight="800"
                                    className="font-mono pointer-events-none"
                                >
                                    {spec.minorKey}
                                </text>
                                <text
                                    x={innerCenter.x}
                                    y={innerCenter.y + 7.5}
                                    textAnchor="middle"
                                    dominantBaseline="middle"
                                    fill={isInnerActive ? '#fef08a' : '#f1f5f9'}
                                    stroke="#1e140f"
                                    strokeWidth="2"
                                    style={{ paintOrder: 'stroke' }}
                                    fontSize="8.5"
                                    fontWeight="700"
                                    className="font-mono pointer-events-none"
                                >
                                    {spec.minorNote}
                                </text>
                            </g>
                        );
                    })}

                    {/* 保留「當前曲目 (NOW)」與「下一首曲目 (NEXT)」之間的轉場指向虛線（雙層描邊確保在任何扇形上皆清晰不混濁） */}
                    {nowPoint &&
                        nextPoint &&
                        nowParsed?.normalized !== nextParsed?.normalized && (
                            <g className="pointer-events-none">
                                <line
                                    x1={nowPoint.x}
                                    y1={nowPoint.y}
                                    x2={nextPoint.x}
                                    y2={nextPoint.y}
                                    stroke="#fffdf9"
                                    strokeOpacity="0.85"
                                    strokeWidth="4.6"
                                    strokeLinecap="round"
                                />
                                <line
                                    x1={nowPoint.x}
                                    y1={nowPoint.y}
                                    x2={nextPoint.x}
                                    y2={nextPoint.y}
                                    stroke={isCafeMica ? '#f59e0b' : '#fbbf24'}
                                    strokeWidth="2.6"
                                    strokeDasharray="5 3"
                                    strokeLinecap="round"
                                />
                            </g>
                        )}

                    {/* 選取曲目 (SEL) 扇區外圍：雙層高對比「柔霧杏仁白底環 + 晨光晴空藍短虛線光圈」 */}
                    {selPoint && (
                        <g className="pointer-events-none">
                            <circle
                                cx={selPoint.x}
                                cy={selPoint.y}
                                r={
                                    selParsed?.normalized ===
                                        nowParsed?.normalized ||
                                    selParsed?.normalized ===
                                        nextParsed?.normalized
                                        ? '23.5'
                                        : '18.5'
                                }
                                fill="none"
                                stroke="#fffdf9"
                                strokeOpacity="0.92"
                                strokeWidth="4.8"
                            />
                            <circle
                                cx={selPoint.x}
                                cy={selPoint.y}
                                r={
                                    selParsed?.normalized ===
                                        nowParsed?.normalized ||
                                    selParsed?.normalized ===
                                        nextParsed?.normalized
                                        ? '23.5'
                                        : '18.5'
                                }
                                fill="none"
                                stroke={isCafeMica ? '#0ea5e9' : '#38bdf8'}
                                strokeWidth="2.8"
                                strokeDasharray="4 2.5"
                                strokeLinecap="round"
                            />
                        </g>
                    )}

                    {/* 當前曲目 (NOW) 扇區外圍：雙層高對比「柔霧杏仁白底環 + 鮮翠鼠尾草綠實心光圈」 */}
                    {nowPoint && (
                        <g className="pointer-events-none">
                            <circle
                                cx={nowPoint.x}
                                cy={nowPoint.y}
                                r="18.5"
                                fill="none"
                                stroke="#fffdf9"
                                strokeOpacity="0.95"
                                strokeWidth="5"
                            />
                            <circle
                                cx={nowPoint.x}
                                cy={nowPoint.y}
                                r="18.5"
                                fill="none"
                                stroke={isCafeMica ? '#10b981' : '#34d399'}
                                strokeWidth="3"
                            />
                        </g>
                    )}

                    {/* 下一首曲目 (NEXT) 扇區外圍：雙層高對比「柔霧杏仁白底環 + 焦糖晨光金長虛線光圈」 */}
                    {nextPoint && (
                        <g className="pointer-events-none">
                            <circle
                                cx={nextPoint.x}
                                cy={nextPoint.y}
                                r={
                                    nowParsed?.normalized ===
                                    nextParsed?.normalized
                                        ? '21.5'
                                        : '18.5'
                                }
                                fill="none"
                                stroke="#fffdf9"
                                strokeOpacity="0.92"
                                strokeWidth="4.6"
                            />
                            <circle
                                cx={nextPoint.x}
                                cy={nextPoint.y}
                                r={
                                    nowParsed?.normalized ===
                                    nextParsed?.normalized
                                        ? '21.5'
                                        : '18.5'
                                }
                                fill="none"
                                stroke={isCafeMica ? '#f59e0b' : '#fbbf24'}
                                strokeWidth="2.8"
                                strokeDasharray="6 3"
                                strokeLinecap="round"
                            />
                        </g>
                    )}

                    {/* 中心圓盤：由上而下顯示 SEL / NOW / NEXT 色號對照 */}
                    <circle
                        cx={cx}
                        cy={cy}
                        r="44"
                        fill={isCafeMica ? '#fffaf4' : '#020617'}
                        stroke={isCafeMica ? '#c87d4b' : '#334155'}
                        strokeWidth="2"
                    />
                    <text
                        x={cx}
                        y={cy - 16}
                        textAnchor="middle"
                        fill={isCafeMica ? '#0284c7' : '#38bdf8'}
                        fontSize="10.5"
                        fontWeight="800"
                        className="font-mono"
                    >
                        SEL: {selParsed?.normalized ?? '--'}
                    </text>
                    <text
                        x={cx}
                        y={cy + 1}
                        textAnchor="middle"
                        fill={isCafeMica ? '#059669' : '#34d399'}
                        fontSize="11.5"
                        fontWeight="800"
                        className="font-mono"
                    >
                        NOW: {nowParsed?.normalized ?? '--'}
                    </text>
                    <text
                        x={cx}
                        y={cy + 18}
                        textAnchor="middle"
                        fill={isCafeMica ? '#d97706' : '#fbbf24'}
                        fontSize="10.5"
                        fontWeight="800"
                        className="font-mono"
                    >
                        NEXT: {nextParsed?.normalized ?? '--'}
                    </text>
                </svg>
            </div>

            {/* 色輪下方資訊區：由上到下依序排列為「選取」->「當前」->「下首」與「當前 -> 下首 調性分析」 */}
            <div className="flex flex-col gap-1.5 text-[11px]">
                {/* 1. 選取 (selectedTrack) */}
                <div
                    className={`flex items-center justify-between gap-2 border ${
                        isM3Style
                            ? 'rounded-full px-3.5 py-1.5'
                            : 'rounded-lg px-2.5 py-1.5'
                    } ${
                        isCafeMica
                            ? 'bg-[#e8f3f8] border-[#7cc2e6]/70'
                            : isM3Style
                              ? 'bg-[#1a2638]/95 border-[#7cc2e6]/45'
                              : 'bg-slate-900/90 border-sky-500/45'
                    }`}
                >
                    <div className="flex items-center gap-1.5 min-w-0">
                        <span
                            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                                isCafeMica
                                    ? 'bg-[#0284c7] shadow-[0_0_6px_rgba(2,132,199,0.45)]'
                                    : 'bg-sky-400 shadow-[0_0_8px_#38bdf8]'
                            }`}
                        />
                        <span
                            className={`font-bold shrink-0 ${
                                isCafeMica ? 'text-[#0369a1]' : 'text-sky-300'
                            }`}
                        >
                            選取:
                        </span>
                        <span
                            className={`font-semibold truncate ${
                                isCafeMica ? 'text-[#2b1e17]' : 'text-slate-100'
                            }`}
                        >
                            {selectedTrackInfo
                                ? selectedTrackInfo.title
                                : '尚未選取曲目'}
                        </span>
                    </div>
                    {selectedTrackInfo && (
                        <span
                            className={`font-mono font-bold shrink-0 ${
                                isCafeMica ? 'text-[#0369a1]' : 'text-sky-300'
                            }`}
                        >
                            {selectedTrackInfo.key} • {selectedTrackInfo.bpm}
                        </span>
                    )}
                </div>

                {/* 2. 當前 (currentTrack - 時間軸當前位置) */}
                <div
                    className={`flex items-center justify-between gap-2 border ${
                        isM3Style
                            ? 'rounded-full px-3.5 py-1.5'
                            : 'rounded-lg px-2.5 py-1.5'
                    } ${
                        isCafeMica
                            ? 'bg-[#e2f2e7] border-[#4e8763]/60'
                            : isM3Style
                              ? 'bg-[#182e28]/95 border-emerald-500/45'
                              : 'bg-slate-900/90 border-emerald-500/40'
                    }`}
                >
                    <div className="flex items-center gap-1.5 min-w-0">
                        <span
                            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                                isCafeMica
                                    ? 'bg-[#2e7d52] shadow-[0_0_6px_rgba(46,125,82,0.45)]'
                                    : 'bg-emerald-400 shadow-[0_0_8px_#34d399]'
                            }`}
                        />
                        <span
                            className={`font-bold shrink-0 ${
                                isCafeMica
                                    ? 'text-[#1e5638]'
                                    : 'text-emerald-300'
                            }`}
                        >
                            當前:
                        </span>
                        <span
                            className={`font-semibold truncate ${
                                isCafeMica ? 'text-[#2b1e17]' : 'text-slate-100'
                            }`}
                        >
                            {activeTrackInfo
                                ? activeTrackInfo.title
                                : '尚未載入曲目'}
                        </span>
                    </div>
                    {activeTrackInfo && (
                        <span
                            className={`font-mono font-bold shrink-0 ${
                                isCafeMica
                                    ? 'text-[#1e5638]'
                                    : 'text-emerald-300'
                            }`}
                        >
                            {activeTrackInfo.key} • {activeTrackInfo.bpm}
                        </span>
                    )}
                </div>

                {/* 3. 下首 (nextQueueItem - 時間軸下一首) */}
                <div
                    className={`flex items-center justify-between gap-2 border ${
                        isM3Style
                            ? 'rounded-full px-3.5 py-1.5'
                            : 'rounded-lg px-2.5 py-1.5'
                    } ${
                        isCafeMica
                            ? 'bg-[#f8ead8] border-[#c87d4b]/60'
                            : isM3Style
                              ? 'bg-[#2c2419]/95 border-amber-500/45'
                              : 'bg-slate-900/90 border-amber-500/40'
                    }`}
                >
                    <div className="flex items-center gap-1.5 min-w-0">
                        <span
                            className={`w-2.5 h-2.5 rounded-full shrink-0 ${
                                isCafeMica
                                    ? 'bg-[#d97706] shadow-[0_0_6px_rgba(217,119,6,0.45)]'
                                    : 'bg-amber-400 shadow-[0_0_8px_#fbbf24]'
                            }`}
                        />
                        <span
                            className={`font-bold shrink-0 ${
                                isCafeMica ? 'text-[#8c461c]' : 'text-amber-300'
                            }`}
                        >
                            下首:
                        </span>
                        <span
                            className={`font-semibold truncate ${
                                isCafeMica ? 'text-[#2b1e17]' : 'text-slate-200'
                            }`}
                        >
                            {nextTrackInfo
                                ? nextTrackInfo.title
                                : '佇列無下一首曲目'}
                        </span>
                    </div>
                    {nextTrackInfo && (
                        <span
                            className={`font-mono font-bold shrink-0 ${
                                isCafeMica ? 'text-[#8c461c]' : 'text-amber-300'
                            }`}
                        >
                            {nextTrackInfo.key} • {nextTrackInfo.bpm}
                        </span>
                    )}
                </div>

                {/* 4. 保留「當前 -> 下首」諧波調性分析 (M3 主題下套用 rounded-full 膠囊外框) */}
                <div
                    className={`${
                        isM3Style
                            ? 'rounded-full px-3.5 py-1.5'
                            : 'rounded-md px-2.5 py-1'
                    } border text-[11px] font-semibold text-center truncate ${relation.badgeClass}`}
                >
                    {relation.text}
                </div>
            </div>
        </div>
    );
}
