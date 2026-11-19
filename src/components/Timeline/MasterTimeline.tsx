import { useEffect, useMemo, useRef, useState } from 'react';
import {
    getLiveInterpolatedMasterTime,
    usePlayerStore,
} from '../../store/usePlayerStore';
import { useWorkflowStore } from '../../store/useWorkflowStore';
import { usePlaylistStore } from '../../store/usePlaylistStore';
import { isM3LayoutTheme, useThemeStore } from '../../store/useThemeStore';
import { getCamelotKeyColorSpec } from '../../algorithms/harmonicMixing';
import { formatSmartDuration } from '../../utils/formatTime';

// ============================================================================
// [區塊 5] MasterTimeline：底部駱駝色輪色相曲目區塊總時間軸、循環播放開關、段落跳轉控制與主音量控制
// 升級為 60FPS 零延遲 Pointer Events 拖曳引擎，支援 seekhead 專屬抓取游標 (cursor-grab / cursor-grabbing)
// ============================================================================
export function MasterTimeline() {
    const {
        isPlaying,
        masterTimeSeconds,
        isTimelineLoopEnabled,
        volume,
        setVolume,
        togglePlay,
        toggleTimelineLoop,
        seekMasterTimeline,
        skipToPreviousTrack,
        skipToNextTrack,
    } = usePlayerStore();
    const { playlist, totalTimelineDuration } = useWorkflowStore();
    const allTracks = usePlaylistStore((s) => s.allTracks);
    const themeId = useThemeStore((s) => s.themeId);
    const isM3Dark = isM3LayoutTheme(themeId);

    const trackBarRef = useRef<HTMLDivElement | null>(null);
    const seekheadRef = useRef<HTMLDivElement | null>(null);
    const lastHostSeekMsRef = useRef<number>(0);
    const [isDraggingSeekhead, setIsDraggingSeekhead] =
        useState<boolean>(false);
    const [isHoveringSeekhead, setIsHoveringSeekhead] =
        useState<boolean>(false);
    const [scrubTimeSeconds, setScrubTimeSeconds] = useState<number | null>(
        null
    );

    // 拖曳期間優先顯示本地 60FPS 無量化浮點秒數，確保 seekhead 100% 緊貼滑鼠零延遲
    const effectiveMasterTime =
        isDraggingSeekhead && scrubTimeSeconds !== null
            ? scrubTimeSeconds
            : masterTimeSeconds;

    // 造成原錯誤的原因：先前僅依賴 100ms (10FPS) 計時器更新 seekhead 的 left%，導致時間軸較短時肉眼可見每秒 10 次微頓挫，且每次 tick 都重跑 playlist.map 與 allTracks.find。
    // 本次修改的目的：播放期間透過 requestAnimationFrame 直接對 seekheadRef 進行 60FPS 零重繪平滑插值，並將軌道色塊層以 useMemo 快取。
    useEffect(() => {
        if (!isPlaying || isDraggingSeekhead || totalTimelineDuration <= 0) {
            return;
        }
        let rafId = 0;
        const step = () => {
            if (
                typeof document === 'undefined' ||
                document.visibilityState === 'visible'
            ) {
                const el = seekheadRef.current;
                if (el) {
                    const baseSec =
                        usePlayerStore.getState().masterTimeSeconds;
                    const liveSec = getLiveInterpolatedMasterTime(
                        true,
                        baseSec,
                        totalTimelineDuration
                    );
                    const pct = Math.min(
                        100,
                        Math.max(0, (liveSec / totalTimelineDuration) * 100)
                    );
                    el.style.left = `${pct}%`;
                }
            }
            rafId = window.requestAnimationFrame(step);
        };
        rafId = window.requestAnimationFrame(step);
        return () => {
            window.cancelAnimationFrame(rafId);
        };
    }, [isPlaying, isDraggingSeekhead, totalTimelineDuration]);

    const computeTimeFromPointerClientX = (clientX: number): number => {
        const el = trackBarRef.current;
        if (!el || totalTimelineDuration <= 0) return 0;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0) return 0;
        const ratio = Math.max(
            0,
            Math.min(1, (clientX - rect.left) / rect.width)
        );
        return ratio * totalTimelineDuration;
    };

    const isPointerNearSeekhead = (clientX: number): boolean => {
        const el = trackBarRef.current;
        if (!el || totalTimelineDuration <= 0) return false;
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0) return false;
        const seekheadX =
            rect.left +
            Math.min(1, Math.max(0, effectiveMasterTime / totalTimelineDuration)) *
                rect.width;
        // 在白色 seekhead 左右各 11px 熱區內視為懸停於 seekhead 把手
        return Math.abs(clientX - seekheadX) <= 11;
    };

    const handleTimelinePointerDown = (
        e: React.PointerEvent<HTMLDivElement>
    ) => {
        if (totalTimelineDuration <= 0 || playlist.length === 0) return;
        if (e.button !== 0) return;

        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);

        const targetSec = computeTimeFromPointerClientX(e.clientX);
        setIsDraggingSeekhead(true);
        setScrubTimeSeconds(targetSec);
        lastHostSeekMsRef.current = performance.now();

        seekMasterTimeline(targetSec, playlist, allTracks, {
            commitPersistence: false,
            sendHostSeek: true,
        });
    };

    const handleTimelinePointerMove = (
        e: React.PointerEvent<HTMLDivElement>
    ) => {
        if (!isDraggingSeekhead) {
            const near = isPointerNearSeekhead(e.clientX);
            if (near !== isHoveringSeekhead) {
                setIsHoveringSeekhead(near);
            }
            return;
        }

        if (totalTimelineDuration <= 0 || playlist.length === 0) return;
        const targetSec = computeTimeFromPointerClientX(e.clientX);
        setScrubTimeSeconds(targetSec);

        // 拖曳期間對 C++ 宿主 IPC Seek 進行 75ms 節流，且不寫入 localStorage，徹底消除拖曳卡頓感
        const now = performance.now();
        const shouldSendSeek = now - lastHostSeekMsRef.current >= 75;
        if (shouldSendSeek) {
            lastHostSeekMsRef.current = now;
        }

        seekMasterTimeline(targetSec, playlist, allTracks, {
            commitPersistence: false,
            sendHostSeek: shouldSendSeek,
        });
    };

    const finishTimelinePointerDrag = (
        e: React.PointerEvent<HTMLDivElement>
    ) => {
        if (!isDraggingSeekhead) return;
        try {
            if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                e.currentTarget.releasePointerCapture(e.pointerId);
            }
        } catch {
            // ignore
        }

        const finalSec = computeTimeFromPointerClientX(e.clientX);
        setIsDraggingSeekhead(false);
        setScrubTimeSeconds(null);
        setIsHoveringSeekhead(isPointerNearSeekhead(e.clientX));

        if (totalTimelineDuration > 0 && playlist.length > 0) {
            seekMasterTimeline(finalSec, playlist, allTracks, {
                commitPersistence: true,
                sendHostSeek: true,
            });
        }
        e.currentTarget.blur();
    };

    const seekheadPercent =
        totalTimelineDuration > 0
            ? Math.min(
                  100,
                  Math.max(0, (effectiveMasterTime / totalTimelineDuration) * 100)
              )
            : 0;

    const memoizedTrackAndTransitionLayers = useMemo(() => {
        if (totalTimelineDuration <= 0) return null;
        return (
            <>
                {playlist.map((item, idx) => {
                    const itemSpan = Math.max(
                        0.5,
                        item.timelineEndSec - item.timelineStartSec
                    );
                    const leftPercent =
                        (item.timelineStartSec / totalTimelineDuration) * 100;
                    const widthPercent =
                        (itemSpan / totalTimelineDuration) * 100;
                    const latestLibTrack = allTracks.find(
                        (t) =>
                            t.id === item.trackId ||
                            (Boolean(item.path) && t.path === item.path)
                    );
                    const trackKey =
                        latestLibTrack?.key || item.key || '8A';
                    const camelotColor = getCamelotKeyColorSpec(trackKey);
                    const loops = item.cuePoints.loopCount ?? 1;

                    const prevItem = idx > 0 ? playlist[idx - 1] : null;
                    const hasNextItem = idx + 1 < playlist.length;

                    const prevCrossfadeDur =
                        prevItem &&
                        prevItem.transitionToNext.type === 'CROSSFADE'
                            ? Math.max(
                                  0,
                                  prevItem.transitionToNext.duration ?? 0
                              )
                            : 0;
                    const fadeInHalfOnLeft =
                        prevCrossfadeDur > 0
                            ? Math.min(prevCrossfadeDur * 0.5, itemSpan)
                            : 0;
                    // 造成原錯誤的原因：CSS 盒模型中子元素的百分比 padding-left / padding-right 是相對於「父容器總寬度 (totalTimelineDuration)」計算而非子色塊自身寬度 (itemSpan)；先前以 itemSpan 為分母，導致曲目多、總時間長時避讓空白被放大數倍。
                    // 本次修改的目的：改以 totalTimelineDuration 作為百分比分母（並限制不超過該曲目色塊自身寬度 widthPercent 的 42%），讓文字避讓空間 1:1 精準貼合 Crossfade 色塊實際寬度。
                    const overlapLeftPercent =
                        fadeInHalfOnLeft > 0
                            ? Math.min(
                                  widthPercent * 0.42,
                                  (fadeInHalfOnLeft / totalTimelineDuration) *
                                      100
                              )
                            : 0;

                    const nextCrossfadeDur =
                        hasNextItem &&
                        item.transitionToNext.type === 'CROSSFADE'
                            ? Math.max(
                                  0,
                                  item.transitionToNext.duration ?? 0
                              )
                            : 0;
                    const fadeOutHalfOnRight =
                        nextCrossfadeDur > 0
                            ? Math.min(nextCrossfadeDur * 0.5, itemSpan)
                            : 0;
                    const overlapRightPercent =
                        fadeOutHalfOnRight > 0
                            ? Math.min(
                                  widthPercent * 0.42,
                                  (fadeOutHalfOnRight / totalTimelineDuration) *
                                      100
                              )
                            : 0;

                    return (
                        <div
                            key={`${item.order}-${item.trackId}`}
                            style={{
                                left: `${leftPercent}%`,
                                width: `${widthPercent}%`,
                                background: camelotColor.bgStyle,
                                borderColor: camelotColor.borderStyle,
                                ...(overlapLeftPercent > 0
                                    ? {
                                          paddingLeft: `calc(${overlapLeftPercent.toFixed(3)}% + 6px)`,
                                      }
                                    : {}),
                                ...(overlapRightPercent > 0
                                    ? {
                                          paddingRight: `calc(${overlapRightPercent.toFixed(3)}% + 6px)`,
                                      }
                                    : {}),
                            }}
                            className={`absolute inset-y-1 ${
                                isM3Dark ? 'rounded-lg' : 'rounded-md'
                            } border px-2 py-0.5 flex flex-col justify-center gap-0.5 overflow-hidden pointer-events-none shadow-sm leading-none`}
                        >
                            <div className="flex items-center justify-between gap-1.5 min-w-0">
                                <span className="text-xs leading-tight font-bold text-white truncate drop-shadow-[0_1px_2px_rgba(0,0,0,0.9)]">
                                    {item.order}. {item.title}{' '}
                                    {loops > 1 ? `[x${loops}]` : ''}
                                </span>
                                <span
                                    style={{
                                        backgroundColor:
                                            camelotColor.badgeBgStyle,
                                        borderColor: camelotColor.borderStyle,
                                    }}
                                    className="px-1.5 py-0.5 rounded-full border text-[11px] font-mono font-extrabold text-white shrink-0 leading-none"
                                >
                                    {trackKey}
                                </span>
                            </div>
                            <div className="text-[11px] leading-tight font-mono text-white/95 truncate drop-shadow-[0_1px_2px_rgba(0,0,0,0.85)]">
                                {trackKey} • In:
                                {formatSmartDuration(
                                    item.cuePoints.mixIn,
                                    'auto'
                                )}{' '}
                                | Out:
                                {formatSmartDuration(
                                    item.cuePoints.mixOut,
                                    'auto'
                                )}{' '}
                                | {item.transitionToNext.type}
                            </div>
                        </div>
                    );
                })}

                {playlist.map((item, idx) => {
                    const nextItem =
                        idx + 1 < playlist.length ? playlist[idx + 1] : null;
                    if (!nextItem) return null;

                    const transType = item.transitionToNext.type;
                    const transDur = Math.max(
                        0,
                        item.transitionToNext.duration ?? 0
                    );

                    if (transType === 'CROSSFADE' && transDur > 0) {
                        const switchSec = nextItem.timelineStartSec;
                        const curTrackSpan = Math.max(
                            0.5,
                            item.timelineEndSec - item.timelineStartSec
                        );
                        const nextTrackSpan = Math.max(
                            0.5,
                            nextItem.timelineEndSec -
                                nextItem.timelineStartSec
                        );
                        const fadeOutHalf = Math.min(
                            transDur * 0.5,
                            curTrackSpan
                        );
                        const fadeInHalf = Math.min(
                            transDur * 0.5,
                            nextTrackSpan
                        );
                        const fadeStartSec = Math.max(
                            item.timelineStartSec,
                            switchSec - fadeOutHalf
                        );
                        const fadeEndSec = Math.min(
                            nextItem.timelineEndSec,
                            switchSec + fadeInHalf
                        );
                        const zoneSpan = Math.max(
                            0.1,
                            fadeEndSec - fadeStartSec
                        );

                        const leftPercent =
                            (fadeStartSec / totalTimelineDuration) * 100;
                        const widthPercent =
                            (zoneSpan / totalTimelineDuration) * 100;

                        return (
                            <div
                                key={`xfade-zone-${item.order}`}
                                style={{
                                    left: `${leftPercent}%`,
                                    width: `${widthPercent}%`,
                                    background:
                                        'linear-gradient(90deg, rgba(217, 169, 26, 0.42), rgba(132, 204, 22, 0.44))',
                                }}
                                className="absolute inset-y-1 z-10 rounded-md border border-lime-300/80 pointer-events-none"
                            />
                        );
                    }

                    if (
                        transType === 'SILENCE' &&
                        nextItem.timelineStartSec > item.timelineEndSec
                    ) {
                        const gapStartSec = item.timelineEndSec;
                        const gapSpanSec =
                            nextItem.timelineStartSec - item.timelineEndSec;
                        const leftPercent =
                            (gapStartSec / totalTimelineDuration) * 100;
                        const widthPercent =
                            (gapSpanSec / totalTimelineDuration) * 100;

                        return (
                            <div
                                key={`silence-zone-${item.order}`}
                                style={{
                                    left: `${leftPercent}%`,
                                    width: `${widthPercent}%`,
                                }}
                                className="absolute inset-y-1 z-10 rounded-md border border-dashed border-amber-500/75 bg-amber-950/25 pointer-events-none"
                            />
                        );
                    }

                    return null;
                })}
            </>
        );
    }, [playlist, totalTimelineDuration, allTracks, isM3Dark]);

    return (
        <footer
            className={`dj-surface-panel bg-slate-900 border border-slate-800 rounded-xl flex flex-col shadow-xl transition-all duration-200 ${
                isM3Dark ? 'px-3 py-2 gap-1.5' : 'p-3.5 gap-2.5'
            }`}
        >
            <div className="flex flex-wrap items-center justify-between gap-2">
                {/* 左側：上一首 / 播放暫停 / 下一首 / 整條時間軸循環播放 控制群組與全局時間軸秒數 */}
                <div className="flex flex-wrap items-center gap-1.5">
                    <button
                        type="button"
                        disabled={playlist.length === 0}
                        onClick={(e) => {
                            skipToPreviousTrack(playlist, allTracks);
                            e.currentTarget.blur();
                        }}
                        className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs rounded-lg border border-slate-700 transition disabled:opacity-40 cursor-pointer"
                        title="跳至上一首曲目起點 (快捷鍵: [ )"
                    >
                        ⏮ 上一首
                    </button>

                    <button
                        type="button"
                        onClick={(e) => {
                            togglePlay(playlist, allTracks);
                            e.currentTarget.blur();
                        }}
                        className="px-4 py-1 bg-cyan-600 hover:bg-cyan-500 text-white font-bold text-xs rounded-lg transition shadow-md cursor-pointer"
                        title="播放 / 暫停 (快捷鍵: Space)"
                    >
                        {isPlaying ? '⏸ 暫停' : '▶ 播放'}
                    </button>

                    <button
                        type="button"
                        disabled={playlist.length === 0}
                        onClick={(e) => {
                            skipToNextTrack(playlist, allTracks);
                            e.currentTarget.blur();
                        }}
                        className="px-2.5 py-1 bg-slate-800 hover:bg-slate-700 text-slate-200 font-bold text-xs rounded-lg border border-slate-700 transition disabled:opacity-40 cursor-pointer"
                        title="跳至下一首曲目起點 (快捷鍵: ] )"
                    >
                        ⏭ 下一首
                    </button>

                    <button
                        type="button"
                        onClick={(e) => {
                            toggleTimelineLoop();
                            e.currentTarget.blur();
                        }}
                        className={`px-2.5 py-1 font-bold text-xs rounded-lg border transition cursor-pointer ${
                            isTimelineLoopEnabled
                                ? 'bg-emerald-950/90 hover:bg-emerald-900 text-emerald-300 border-emerald-500/80 shadow-[0_0_10px_rgba(16,185,129,0.28)]'
                                : 'bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-slate-200 border-slate-700'
                        }`}
                        title="開啟或關閉整條 Master 總時間軸循環播放"
                    >
                        🔁{' '}
                        {isTimelineLoopEnabled
                            ? '循環: 開啟'
                            : '循環: 關閉'}
                    </button>

                    <div className="text-xs font-mono text-slate-300 ml-1">
                        Master 時間軸：
                        <span className="text-cyan-400 font-bold ml-1">
                            {formatSmartDuration(effectiveMasterTime, 'tenths')}
                        </span>{' '}
                        / {formatSmartDuration(totalTimelineDuration, 'tenths')}
                    </div>
                </div>

                {/* 右上角：快捷鍵提示與主音量控制 */}
                <div className="flex items-center gap-2.5">
                    <div className="text-[11px] font-mono text-slate-400 hidden xl:flex items-center gap-1.5 bg-slate-950/70 border border-slate-800/80 px-2.5 py-0.5 rounded-lg">
                        <span className="text-cyan-300">⌨️ 快捷鍵:</span>
                        <span>Space 播放</span>
                        <span>•</span>
                        <span>←/→ ±5s</span>
                        <span>•</span>
                        <span>[/] 切歌</span>
                        <span>•</span>
                        <span>L 鎖定</span>
                    </div>

                    <div className="flex items-center gap-2 bg-slate-950 border border-slate-800 px-2.5 py-1 rounded-lg">
                        <span className="text-xs text-slate-400">音量</span>
                        <input
                            type="range"
                            min={0}
                            max={1}
                            step={0.01}
                            value={volume}
                            onChange={(e) => setVolume(Number(e.target.value))}
                            onMouseUp={(e) => e.currentTarget.blur()}
                            onTouchEnd={(e) => e.currentTarget.blur()}
                            onKeyDown={(e) => {
                                e.preventDefault();
                                e.currentTarget.blur();
                            }}
                            className="w-20 accent-cyan-500 cursor-pointer"
                        />
                        <span className="text-xs font-mono w-8 text-right">
                            {Math.round(volume * 100)}%
                        </span>
                    </div>
                </div>
            </div>

            {/* 總時間軸軌道與 60FPS 自訂 Pointer Events 互動容器 (固定維持 h-14 確保兩行曲目與 Cue 資訊 100% 完整顯示不裁切) */}
            {/* 造成原錯誤的原因：trackBarRef 在 m3-cafe-mica 下原先設定為深焙棕 !bg-[#2b1f1a]/92，導致北歐燕麥奶淺色主題下時間軸軌道仍呈現深黑底色。 */}
            {/* 本次修改的目的：改為暖燕麥淺底色 !bg-[#eadccf]/90 並強化播放指針 (Seekhead) 在淺色背景上的對比度。 */}
            <div
                ref={trackBarRef}
                onPointerDown={handleTimelinePointerDown}
                onPointerMove={handleTimelinePointerMove}
                onPointerUp={finishTimelinePointerDrag}
                onPointerCancel={finishTimelinePointerDrag}
                onPointerLeave={() => {
                    if (!isDraggingSeekhead) {
                        setIsHoveringSeekhead(false);
                    }
                }}
                className={`relative w-full h-14 ${
                    themeId === 'm3-cafe-mica'
                        ? '!bg-[#eadccf]/90 border-[#c49874]/60 shadow-inner'
                        : 'bg-slate-950 border-slate-800'
                } rounded-xl border overflow-hidden select-none touch-none ${
                    isDraggingSeekhead
                        ? 'cursor-grabbing'
                        : isHoveringSeekhead
                          ? 'cursor-grab'
                          : 'cursor-pointer'
                }`}
            >
                {memoizedTrackAndTransitionLayers}

                {/* 播放進度指針 (Seekhead) 與上下握把指示器 */}
                {totalTimelineDuration > 0 && (
                    <div
                        ref={seekheadRef}
                        style={{
                            left: `${seekheadPercent}%`,
                        }}
                        className="absolute inset-y-0 -ml-2.5 w-5 z-20 flex flex-col items-center justify-between pointer-events-none"
                    >
                        {/* 頂部抓取握把 */}
                        <div
                            className={`w-3 h-2 rounded-b-sm transition-transform ${
                                isDraggingSeekhead
                                    ? 'bg-cyan-300 scale-125 shadow-[0_0_10px_#22d3ee]'
                                    : isHoveringSeekhead
                                      ? 'bg-cyan-200 scale-110 shadow-[0_0_8px_#fff]'
                                      : themeId === 'm3-cafe-mica'
                                        ? 'bg-white border border-[#2b1e17] shadow-[0_1px_4px_rgba(43,30,23,0.75)]'
                                        : 'bg-white shadow-[0_0_6px_#fff]'
                            }`}
                        />
                        {/* 中央高亮度指針線 */}
                        <div
                            className={`flex-1 w-0.5 transition-colors ${
                                isDraggingSeekhead
                                    ? 'bg-cyan-300 shadow-[0_0_12px_#22d3ee]'
                                    : themeId === 'm3-cafe-mica'
                                      ? 'bg-white shadow-[0_0_4px_rgba(43,30,23,0.9)]'
                                      : 'bg-white shadow-[0_0_8px_#fff]'
                            }`}
                        />
                        {/* 底部抓取握把 */}
                        <div
                            className={`w-3 h-2 rounded-t-sm transition-transform ${
                                isDraggingSeekhead
                                    ? 'bg-cyan-300 scale-125 shadow-[0_0_10px_#22d3ee]'
                                    : isHoveringSeekhead
                                      ? 'bg-cyan-200 scale-110 shadow-[0_0_8px_#fff]'
                                      : themeId === 'm3-cafe-mica'
                                        ? 'bg-white border border-[#2b1e17] shadow-[0_1px_4px_rgba(43,30,23,0.75)]'
                                        : 'bg-white shadow-[0_0_6px_#fff]'
                            }`}
                        />
                    </div>
                )}
            </div>
        </footer>
    );
}

