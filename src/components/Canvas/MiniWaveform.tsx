import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CuePoints, Track } from '../../types/track';
import { useThemeStore } from '../../store/useThemeStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import {
    buildFallbackWaveform512,
    downsampleMaxPool,
    fetchTrackRealWaveform512,
    getCachedWaveform512,
    REAL_WAVEFORM_RESOLUTION,
} from '../../utils/waveformService';
import {
    floorDurationToTenth,
    formatSmartDuration,
} from '../../utils/formatTime';

// ============================================================================
// [組件] MiniWaveformSeekEditor：
// 1. 底層 512 點真實音訊 RMS 能量解碼 (fb.audio.generateFullWaveform + Web Audio API)
// 2. HiDPI <canvas> 高動態對比對稱式條碼繪製 (160 根銳利聲波柱，零 DOM 負擔)
// 3. 拖曳 IN / OUT 豎線時自動浮現「512 點 1:1 局部放大鏡 (Zoom Loupe, ±8 秒視窗)」並即時發聲預聽
// ============================================================================
export interface MiniWaveformProps {
    track: Track;
    disabled: boolean;
    onChangeCue: (nextCue: CuePoints) => void;
    onCalibrateDuration?: (realFloorDuration: number) => void;
}

const LOUPE_WINDOW_RADIUS_SEC = 8.0; // 局部放大鏡顯示游標前後 ±8 秒 (共 16 秒區間)
const MIX_OUT_PREROLL_SEC = 1.8; // 拉動 MIX-OUT 時從 mixOut 前 1.8 秒開始播放至 mixOut 自動停住

export function MiniWaveformSeekEditor({
    track,
    disabled,
    onChangeCue,
    onCalibrateDuration,
}: MiniWaveformProps) {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const overviewCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const loupeCanvasRef = useRef<HTMLCanvasElement | null>(null);
    const themeId = useThemeStore((s) => s.themeId);
    const isCafeMica = themeId === 'm3-cafe-mica';

    const startCueScrubPreview = usePlayerStore((s) => s.startCueScrubPreview);
    const stopCueScrubPreview = usePlayerStore((s) => s.stopCueScrubPreview);

    const [draggingHandle, setDraggingHandle] = useState<
        'mixIn' | 'mixOut' | null
    >(null);
    const [isFineScrubbing, setIsFineScrubbing] = useState<boolean>(false);
    const [canvasCssWidth, setCanvasCssWidth] = useState<number>(288);

    // 造成原錯誤的原因：先前在 updateTimeFromClientX 中直接將 (clientX - rect.left) / rect.width 乘以整首歌長度 (例如 240s)，
    // 在 276px 寬的方塊內滑鼠每動 1px 就跳 0.87s，導致無法精準控制 0.1s 移動距離；且拉動時沒有即時音訊預聽回饋。
    // 本次修改的目的：
    // 1. 改用增量位移錨點 (dragAnchorRef)：一般拖曳為全曲比例，按住 Shift 拖曳時自動切換為 1/10 局部放大鏡精細比例（每 2~3px 精準移動 0.1s），並支援滑鼠滾輪 ±0.1s 微調。
    // 2. 拉動 MIX-IN / MIX-OUT 時以 120ms 節流即時觸發 startCueScrubPreview（MIX-OUT 從前 1.8s 播至 mixOut 自動停住），放開滑鼠 (onPointerUp) 立即呼叫 stopCueScrubPreview 停止。
    const dragAnchorRef = useRef<{
        lastClientX: number;
        accumulatedSec: number;
    } | null>(null);
    const lastPreviewSentAtMsRef = useRef<number>(0);
    const trailingPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
        null
    );
    const autoStopPreviewTimerRef = useRef<ReturnType<typeof setTimeout> | null>(
        null
    );

    const clearPreviewTimers = useCallback(() => {
        if (trailingPreviewTimerRef.current !== null) {
            clearTimeout(trailingPreviewTimerRef.current);
            trailingPreviewTimerRef.current = null;
        }
        if (autoStopPreviewTimerRef.current !== null) {
            clearTimeout(autoStopPreviewTimerRef.current);
            autoStopPreviewTimerRef.current = null;
        }
    }, []);

    // 組件卸載時確保清除預聽計時器
    useEffect(() => {
        return () => {
            clearPreviewTimers();
        };
    }, [clearPreviewTimers]);

    const triggerAuditionForCue = useCallback(
        (
            targetSec: number,
            handleType: 'mixIn' | 'mixOut',
            options?: { immediate?: boolean; wheelAutoStopMs?: number }
        ) => {
            if (disabled) return;

            const fire = () => {
                lastPreviewSentAtMsRef.current = Date.now();
                startCueScrubPreview(track, targetSec, handleType);

                if (autoStopPreviewTimerRef.current !== null) {
                    clearTimeout(autoStopPreviewTimerRef.current);
                    autoStopPreviewTimerRef.current = null;
                }

                // 造成原錯誤的原因：先前拉動 MIX-IN 時未限制 1.8s 循環，且拉動 MIX-OUT 播完一次 1.8s 後就直接呼叫 stopCueScrubPreview 停止，按住不放時無法反覆確認落點。
                // 本次修改的目的：
                // 1. 拉動/按住 MIX-IN 時：播放 [mixIn, mixIn + 1.8s]，滿 1.8s 後自動跳回 mixIn 重複循環播放，直到放開滑鼠。
                // 2. 拉動/按住 MIX-OUT 時：播放 [mixOut - 1.8s, mixOut]，到達 mixOut 後自動跳回 mixOut - 1.8s 重複循環播放，直到放開滑鼠。
                const mixInFloor = Math.max(0, track.cuePoints?.mixIn ?? 0);
                const mixOutCeil = Math.max(
                    mixInFloor + 0.5,
                    track.cuePoints?.mixOut ?? track.duration
                );
                const playSpanSec =
                    handleType === 'mixOut'
                        ? Math.max(
                              0.25,
                              targetSec -
                                  Math.max(
                                      mixInFloor,
                                      Math.max(
                                          0,
                                          targetSec - MIX_OUT_PREROLL_SEC
                                      )
                                  )
                          )
                        : Math.max(
                              0.25,
                              Math.min(
                                  MIX_OUT_PREROLL_SEC,
                                  Math.max(0.25, mixOutCeil - targetSec)
                              )
                          );
                const playSpanMs = Math.max(
                    250,
                    Math.round(playSpanSec * 1000)
                );

                if (options?.wheelAutoStopMs && options.wheelAutoStopMs > 0) {
                    const stopDelayMs = Math.min(
                        options.wheelAutoStopMs,
                        playSpanMs
                    );
                    autoStopPreviewTimerRef.current = setTimeout(() => {
                        autoStopPreviewTimerRef.current = null;
                        stopCueScrubPreview();
                    }, stopDelayMs);
                } else {
                    autoStopPreviewTimerRef.current = setTimeout(() => {
                        autoStopPreviewTimerRef.current = null;
                        fire();
                    }, playSpanMs);
                }
            };

            const now = Date.now();
            const elapsed = now - lastPreviewSentAtMsRef.current;
            if (options?.immediate || elapsed >= 120) {
                if (trailingPreviewTimerRef.current !== null) {
                    clearTimeout(trailingPreviewTimerRef.current);
                    trailingPreviewTimerRef.current = null;
                }
                fire();
            } else {
                if (trailingPreviewTimerRef.current !== null) {
                    clearTimeout(trailingPreviewTimerRef.current);
                }
                trailingPreviewTimerRef.current = setTimeout(() => {
                    trailingPreviewTimerRef.current = null;
                    fire();
                }, 120 - elapsed);
            }
        },
        [disabled, startCueScrubPreview, stopCueScrubPreview, track]
    );

    const endHandleDrag = useCallback(() => {
        setDraggingHandle(null);
        setIsFineScrubbing(false);
        dragAnchorRef.current = null;
        clearPreviewTimers();
        stopCueScrubPreview();
    }, [clearPreviewTimers, stopCueScrubPreview]);

    // 監聽容器實際像素寬度變化，確保 <canvas> 1:1 對齊物理像素網格
    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const updateSize = () => {
            const w = Math.round(el.clientWidth);
            if (w > 20) {
                setCanvasCssWidth(w);
            }
        };
        updateSize();
        const ro = new ResizeObserver(updateSize);
        ro.observe(el);
        return () => ro.disconnect();
    }, []);

    // 儲存非同步解碼完成後的結果（搭配同步快取讀取，避免於 useEffect 內同步呼叫 setState）
    const [asyncResult, setAsyncResult] = useState<{
        key: string;
        points: number[];
        isReal: boolean;
        settled: boolean;
    } | null>(null);

    const trackKey = `${track.path || track.id}`;
    const cachedEntry = useMemo(() => getCachedWaveform512(track), [track]);

    const activeData = useMemo(() => {
        if (cachedEntry) {
            return {
                points: cachedEntry.points,
                isReal: cachedEntry.isReal,
                isDecoding: false,
            };
        }
        if (asyncResult && asyncResult.key === trackKey && asyncResult.settled) {
            return {
                points: asyncResult.points,
                isReal: asyncResult.isReal,
                isDecoding: false,
            };
        }
        return {
            points: buildFallbackWaveform512(track),
            isReal: false,
            isDecoding: true,
        };
    }, [cachedEntry, asyncResult, trackKey, track]);

    const { points: points512, isReal: isRealAudio, isDecoding } = activeData;

    // 非同步觸發 512 點真實音訊波形解碼，並於取得真實長度時以 0.1s 精度回寫校準
    useEffect(() => {
        const cached = getCachedWaveform512(track);
        if (cached) {
            if (
                typeof cached.duration === 'number' &&
                cached.duration > 1 &&
                Math.abs(floorDurationToTenth(cached.duration) - track.duration) >=
                    0.05
            ) {
                onCalibrateDuration?.(floorDurationToTenth(cached.duration));
            }
            return;
        }
        let isMounted = true;
        void fetchTrackRealWaveform512(track).then((res) => {
            if (!isMounted) return;
            setAsyncResult({
                key: trackKey,
                points: res.points,
                isReal: res.isReal,
                settled: true,
            });
            if (
                typeof res.duration === 'number' &&
                res.duration > 1 &&
                Math.abs(floorDurationToTenth(res.duration) - track.duration) >=
                    0.05
            ) {
                onCalibrateDuration?.(floorDurationToTenth(res.duration));
            }
        });

        return () => {
            isMounted = false;
        };
    }, [track, trackKey, onCalibrateDuration]);

    const { mixIn, mixOut } = track.cuePoints;
    const safeDuration = Math.max(1, track.duration);

    // 依據容器實際整數寬度計算「1px 柱寬 + 1px 間距 = 每 2px 一根」的最佳整數根數，徹底消除次像素抗鋸齒模糊
    const padX = 6;
    const usableCssWidth = Math.max(40, canvasCssWidth - padX * 2);
    const overviewBarCount = Math.max(60, Math.floor(usableCssWidth / 2));

    // 將 512 點能量波形濃縮為整數像素對齊的聲波柱數
    const overviewBars = useMemo(
        () => downsampleMaxPool(points512, overviewBarCount),
        [points512, overviewBarCount]
    );

    const inPercent = Math.max(0, Math.min(100, (mixIn / safeDuration) * 100));
    const outPercent = Math.max(0, Math.min(100, (mixOut / safeDuration) * 100));

    // ========================================================================
    // [繪圖 1] 物理像素整數對齊 (Pixel-Grid Snapped) <canvas> 渲染，徹底消除次像素模糊
    // ========================================================================
    useEffect(() => {
        const canvas = overviewCanvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        // 採用整數倍率物理像素 (支援 React Flow 畫布放大檢視依然銳利)
        const dpr = Math.max(2, Math.ceil(window.devicePixelRatio || 1));
        const cssWidth = canvasCssWidth || canvas.clientWidth || 288;
        const cssHeight = canvas.clientHeight || 64;

        const physW = Math.round(cssWidth * dpr);
        const physH = Math.round(cssHeight * dpr);

        if (canvas.width !== physW || canvas.height !== physH) {
            canvas.width = physW;
            canvas.height = physH;
        }

        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, physW, physH);

        const physPadX = Math.round(padX * dpr);
        const centerY = Math.round(physH / 2);
        const maxHalfHeight = Math.floor((physH - 8 * dpr) / 2);

        // 1. 中心基準細線 (整數物理像素高度 1px)
        ctx.fillStyle = isCafeMica
            ? 'rgba(180, 145, 118, 0.55)'
            : 'rgba(30, 41, 59, 0.9)';
        ctx.fillRect(physPadX, centerY, physW - physPadX * 2, Math.max(1, Math.round(dpr * 0.5)));

        // 2. 嚴格以整數物理像素座標 (Math.round) 與 fillRect 繪製每根聲波柱，杜絕浮點數座標抗鋸齒糊化
        const barPhysWidth = Math.max(1, Math.round(1 * dpr));
        const stepPhysX = Math.max(barPhysWidth + 1, Math.round(2 * dpr));
        const totalBarsWidth = overviewBarCount * stepPhysX - (stepPhysX - barPhysWidth);
        const startPhysX = Math.round((physW - totalBarsWidth) / 2);

        for (let i = 0; i < overviewBarCount; i++) {
            const peak = overviewBars[i] ?? 0.08;
            const barRatio = (i + 0.5) / overviewBarCount;
            const barPercent = barRatio * 100;
            const isInsideCue =
                barPercent >= inPercent && barPercent <= outPercent;

            const halfH = Math.max(
                Math.round(1.5 * dpr),
                Math.round(peak * maxHalfHeight)
            );
            const x = startPhysX + i * stepPhysX;
            const y = centerY - halfH;
            const h = halfH * 2;

            if (!isInsideCue) {
                ctx.fillStyle = isCafeMica
                    ? 'rgba(168, 142, 122, 0.38)'
                    : 'rgba(71, 85, 105, 0.48)';
            } else if (peak > 0.72) {
                ctx.fillStyle = isCafeMica ? '#b85d28' : '#67e8f9'; // 高能量副歌波峰
            } else if (peak > 0.38) {
                ctx.fillStyle = isCafeMica ? '#c87d4b' : '#a5b4fc'; // 中段主體能量
            } else {
                ctx.fillStyle = isCafeMica ? '#4e8763' : '#818cf8'; // 低電平細節
            }

            ctx.fillRect(x, y, barPhysWidth, h);
        }
    }, [overviewBars, overviewBarCount, inPercent, outPercent, canvasCssWidth, isCafeMica]);

    // ========================================================================
    // [繪圖 2] 拖曳 IN / OUT 時的「512 點 1:1 局部放大鏡 (Zoom Loupe)」整數像素銳利渲染
    // ========================================================================
    const activeTargetSec =
        draggingHandle === 'mixIn'
            ? mixIn
            : draggingHandle === 'mixOut'
              ? mixOut
              : null;

    const currentPointPeak = useMemo(() => {
        if (activeTargetSec === null) return 0;
        const idx = Math.min(
            REAL_WAVEFORM_RESOLUTION - 1,
            Math.max(
                0,
                Math.round(
                    (activeTargetSec / safeDuration) *
                        (REAL_WAVEFORM_RESOLUTION - 1)
                )
            )
        );
        return points512[idx] ?? 0;
    }, [activeTargetSec, safeDuration, points512]);

    useEffect(() => {
        if (activeTargetSec === null || !loupeCanvasRef.current) return;
        const canvas = loupeCanvasRef.current;
        const ctx = canvas.getContext('2d');
        if (!ctx) return;

        const dpr = Math.max(2, Math.ceil(window.devicePixelRatio || 1));
        const cssWidth = canvas.clientWidth || 280;
        const cssHeight = canvas.clientHeight || 54;

        const physW = Math.round(cssWidth * dpr);
        const physH = Math.round(cssHeight * dpr);

        if (canvas.width !== physW || canvas.height !== physH) {
            canvas.width = physW;
            canvas.height = physH;
        }

        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, physW, physH);

        const centerY = Math.round(physH / 2);
        const maxHalfH = Math.floor((physH - 6 * dpr) / 2);
        const startSec = activeTargetSec - LOUPE_WINDOW_RADIUS_SEC;
        const endSec = activeTargetSec + LOUPE_WINDOW_RADIUS_SEC;
        const totalWindowSec = LOUPE_WINDOW_RADIUS_SEC * 2;

        // 1. 背景秒數格線 (每 2 秒一條垂直輔助線，對齊整數像素)
        ctx.fillStyle = 'rgba(51, 65, 85, 0.45)';
        const firstGridSec = Math.ceil(startSec / 2) * 2;
        for (let s = firstGridSec; s <= endSec; s += 2) {
            if (s < 0 || s > safeDuration) continue;
            const gx = Math.round(((s - startSec) / totalWindowSec) * physW);
            ctx.fillRect(gx, 0, Math.max(1, Math.round(dpr * 0.5)), physH);
        }

        // 2. 水平中心軸線
        ctx.fillStyle = 'rgba(71, 85, 105, 0.6)';
        ctx.fillRect(0, centerY, physW, Math.max(1, Math.round(dpr * 0.5)));

        // 3. 標示出當前循環預聽的 1.8 秒區間高亮底色（MIX-IN 為 [mixIn, mixIn + 1.8s] 青色；MIX-OUT 為 [mixOut - 1.8s, mixOut] 玫瑰紅）
        if (draggingHandle === 'mixIn') {
            const postRollEnd = Math.min(
                mixOut,
                Math.min(safeDuration, activeTargetSec + MIX_OUT_PREROLL_SEC)
            );
            const x0 = Math.round(
                ((activeTargetSec - startSec) / totalWindowSec) * physW
            );
            const x1 = Math.round(
                ((postRollEnd - startSec) / totalWindowSec) * physW
            );
            if (x1 > x0) {
                ctx.fillStyle = 'rgba(34, 211, 238, 0.14)';
                ctx.fillRect(x0, 0, x1 - x0, physH);
            }
        } else if (draggingHandle === 'mixOut') {
            const preRollStart = Math.max(
                mixIn,
                Math.max(0, activeTargetSec - MIX_OUT_PREROLL_SEC)
            );
            const x0 = Math.round(
                ((preRollStart - startSec) / totalWindowSec) * physW
            );
            const x1 = Math.round(
                ((activeTargetSec - startSec) / totalWindowSec) * physW
            );
            if (x1 > x0) {
                ctx.fillStyle = 'rgba(251, 113, 133, 0.14)';
                ctx.fillRect(x0, 0, x1 - x0, physH);
            }
        }

        // 4. 1:1 繪製落在 [startSec, endSec] 視窗內的原始 512 點高解析度能量柱 (整數像素對齊)
        const secPerPoint = safeDuration / REAL_WAVEFORM_RESOLUTION;
        const physPxPerPoint = Math.max(
            2 * dpr,
            (secPerPoint / totalWindowSec) * physW
        );
        const barPhysW = Math.max(
            Math.round(1.5 * dpr),
            Math.round(physPxPerPoint * 0.65)
        );

        for (let i = 0; i < REAL_WAVEFORM_RESOLUTION; i++) {
            const ptSec = ((i + 0.5) / REAL_WAVEFORM_RESOLUTION) * safeDuration;
            if (ptSec < startSec - secPerPoint || ptSec > endSec + secPerPoint) {
                continue;
            }

            const xCenter = ((ptSec - startSec) / totalWindowSec) * physW;
            const x = Math.round(xCenter - barPhysW / 2);
            const peak = points512[i] ?? 0.05;
            const halfH = Math.max(
                Math.round(1.5 * dpr),
                Math.round(peak * maxHalfH)
            );

            // 判斷此取樣點是否位於有效播放區間 [mixIn, mixOut] 內
            const isInsidePlayable =
                draggingHandle === 'mixIn'
                    ? ptSec >= activeTargetSec && ptSec <= mixOut
                    : ptSec >= mixIn && ptSec <= activeTargetSec;

            const isAtCrosshair =
                Math.abs(ptSec - activeTargetSec) <= secPerPoint * 0.75;

            if (isAtCrosshair) {
                ctx.fillStyle =
                    draggingHandle === 'mixIn' ? '#22d3ee' : '#fb7185';
            } else if (!isInsidePlayable) {
                ctx.fillStyle = 'rgba(71, 85, 105, 0.45)';
            } else if (peak > 0.72) {
                ctx.fillStyle = '#67e8f9';
            } else {
                ctx.fillStyle = '#a5b4fc';
            }

            ctx.fillRect(x, centerY - halfH, barPhysW, halfH * 2);
        }

        // 5. 繪製中央準星線 (Crosshair)
        const centerX = Math.round(physW / 2);
        const crosshairW = Math.max(2, Math.round(1.5 * dpr));
        ctx.fillStyle =
            draggingHandle === 'mixIn' ? '#22d3ee' : '#fb7185';
        ctx.fillRect(
            Math.round(centerX - crosshairW / 2),
            0,
            crosshairW,
            physH
        );
    }, [activeTargetSec, draggingHandle, mixIn, mixOut, points512, safeDuration]);

    // [功能段落] 增量式滑鼠拖曳計算：支援一般拖曳與按住 Shift 的 0.1s 精細微調模式，並即時觸發聲音預聽
    const updateTimeFromPointerMove = (
        clientX: number,
        shiftKey: boolean,
        handleType: 'mixIn' | 'mixOut'
    ) => {
        if (!containerRef.current || disabled) return;
        const rect = containerRef.current.getBoundingClientRect();
        if (rect.width <= 0) return;

        setIsFineScrubbing(shiftKey);

        const anchor = dragAnchorRef.current;
        if (!anchor) {
            const ratio = Math.max(
                0,
                Math.min(1, (clientX - rect.left) / rect.width)
            );
            const initSec = Number((ratio * safeDuration).toFixed(1));
            dragAnchorRef.current = {
                lastClientX: clientX,
                accumulatedSec: initSec,
            };
            return;
        }

        const deltaPx = clientX - anchor.lastClientX;
        if (Math.abs(deltaPx) < 0.25) return;
        anchor.lastClientX = clientX;

        // 一般模式：橫跨整個寬度 = 整首歌長度 (safeDuration)
        // Shift 精細模式：橫跨整個寬度 = 局部放大鏡視窗 (16 秒，且最高不超過每 2.5px 改變 0.1s)，讓手微動即可精準控制 0.1s
        const fullScaleSecPerPx = safeDuration / rect.width;
        const fineScaleSecPerPx = Math.min(
            fullScaleSecPerPx * 0.15,
            (LOUPE_WINDOW_RADIUS_SEC * 2) / rect.width,
            0.045
        );
        const secPerPx = shiftKey ? fineScaleSecPerPx : fullScaleSecPerPx;

        const nextRaw = anchor.accumulatedSec + deltaPx * secPerPx;

        if (handleType === 'mixIn') {
            const clampedraw = Math.max(0, Math.min(nextRaw, mixOut - 2));
            anchor.accumulatedSec = clampedraw;
            const roundedIn = Number(clampedraw.toFixed(1));
            if (Math.abs(roundedIn - mixIn) >= 0.05) {
                onChangeCue({ ...track.cuePoints, mixIn: roundedIn });
                triggerAuditionForCue(roundedIn, 'mixIn');
            }
        } else {
            const clampedRaw = Math.min(
                safeDuration,
                Math.max(nextRaw, mixIn + 2)
            );
            anchor.accumulatedSec = clampedRaw;
            const roundedOut = Number(clampedRaw.toFixed(1));
            if (Math.abs(roundedOut - mixOut) >= 0.05) {
                onChangeCue({ ...track.cuePoints, mixOut: roundedOut });
                triggerAuditionForCue(roundedOut, 'mixOut');
            }
        }
    };

    // [功能段落] 滑鼠滾輪或微調按鈕 ±0.1s 步進調整並自動預聽 1.1 秒後停止
    const nudgeCueByStep = (
        handleType: 'mixIn' | 'mixOut',
        stepSec: number
    ) => {
        if (disabled) return;
        if (handleType === 'mixIn') {
            const nextIn = Number(
                Math.max(0, Math.min(mixOut - 2, mixIn + stepSec)).toFixed(1)
            );
            if (Math.abs(nextIn - mixIn) >= 0.05) {
                onChangeCue({ ...track.cuePoints, mixIn: nextIn });
                triggerAuditionForCue(nextIn, 'mixIn', {
                    immediate: true,
                    wheelAutoStopMs: 1100,
                });
            }
        } else {
            const nextOut = Number(
                Math.min(
                    safeDuration,
                    Math.max(mixIn + 2, mixOut + stepSec)
                ).toFixed(1)
            );
            if (Math.abs(nextOut - mixOut) >= 0.05) {
                onChangeCue({ ...track.cuePoints, mixOut: nextOut });
                triggerAuditionForCue(nextOut, 'mixOut', {
                    immediate: true,
                    wheelAutoStopMs: 1800,
                });
            }
        }
    };

    return (
        <div className="relative select-none">
            {/* ================================================================ */}
            {/* [殺手級輔助] 拖曳 IN / OUT 豎線時自動浮現的「512 點 1:1 局部放大鏡 (Zoom Loupe)」 */}
            {/* ================================================================ */}
            {draggingHandle !== null && activeTargetSec !== null && (
                <div className="absolute bottom-full left-0 right-0 mb-1.5 z-40 bg-slate-950/95 backdrop-blur-md border border-cyan-500/60 rounded-lg p-1.5 shadow-[0_10px_28px_rgba(0,0,0,0.85)] pointer-events-none">
                    <div className="flex items-center justify-between text-[9px] font-mono mb-1 px-1">
                        <span
                            className={
                                draggingHandle === 'mixIn'
                                    ? 'text-cyan-300 font-bold'
                                    : 'text-rose-300 font-bold'
                            }
                        >
                            🔊{' '}
                            {draggingHandle === 'mixIn'
                                ? 'MIX-IN 即時預聽'
                                : `MIX-OUT 收尾預聽 (-${MIX_OUT_PREROLL_SEC}s)`}{' '}
                            {isFineScrubbing
                                ? '• 🎯 Shift 0.1s 精細微調中'
                                : '• (按住 Shift 0.1s 精細微調)'}
                        </span>
                        <span className="text-slate-200 font-semibold">
                            {formatSmartDuration(activeTargetSec, 'tenths')} • 能量{' '}
                            {Math.round(currentPointPeak * 100)}%
                        </span>
                    </div>
                    <div className="relative h-[54px] w-full bg-slate-900/90 rounded border border-slate-800 overflow-hidden">
                        <canvas
                            ref={loupeCanvasRef}
                            className="w-full h-full block"
                        />
                        {/* 頂部中央準星倒三角標記 */}
                        <div
                            className={`absolute top-0 left-1/2 -translate-x-1/2 text-[8px] leading-none ${
                                draggingHandle === 'mixIn'
                                    ? 'text-cyan-400'
                                    : 'text-rose-400'
                            }`}
                        >
                            ▼
                        </div>
                    </div>
                </div>
            )}

            {/* ================================================================ */}
            {/* [全景波形框] HiDPI <canvas> 高動態對比對稱波形與 IN/OUT 拖曳器 */}
            {/* ================================================================ */}
            <div
                ref={containerRef}
                draggable={false}
                onDragStart={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                }}
                onMouseDown={(e) => e.stopPropagation()}
                className={`nodrag nowheel relative h-16 rounded-lg border overflow-hidden ${
                    isCafeMica
                        ? 'bg-[#efe4d6] border-[#c49874]/60'
                        : 'bg-slate-950 border-slate-800'
                }`}
            >
                {/* [視覺層] 有效播放區間 [Mix-In ~ Mix-Out] 微光背景 */}
                <div
                    style={{
                        left: `${inPercent}%`,
                        width: `${Math.max(0, outPercent - inPercent)}%`,
                    }}
                    className={`absolute inset-y-0 pointer-events-none ${
                        isCafeMica ? 'bg-[#c87d4b]/10' : 'bg-cyan-500/8'
                    }`}
                />

                {/* [視覺層] HiDPI <canvas> 繪製 160 根對稱聲波柱 */}
                <canvas
                    ref={overviewCanvasRef}
                    className="w-full h-full block pointer-events-none relative z-10"
                />

                {/* [視覺層] Mix-In 左側未播放區域半透明遮罩 */}
                <div
                    style={{ width: `${inPercent}%` }}
                    className={`absolute inset-y-0 left-0 pointer-events-none z-10 ${
                        isCafeMica ? 'bg-[#d8c7b6]/55' : 'bg-slate-950/60'
                    }`}
                />
                {/* [視覺層] Mix-Out 右側已切出區域半透明遮罩 */}
                <div
                    style={{ width: `${Math.max(0, 100 - outPercent)}%` }}
                    className={`absolute inset-y-0 right-0 pointer-events-none z-10 ${
                        isCafeMica ? 'bg-[#d8c7b6]/55' : 'bg-slate-950/60'
                    }`}
                />

                {/* [狀態微徽章] 右上角顯示 512 點真實音訊解碼狀態 */}
                <div className="absolute top-0.5 right-1.5 pointer-events-none z-20 flex items-center gap-1">
                    {isDecoding ? (
                        <span
                            className={`text-[8px] font-mono px-1 rounded animate-pulse ${
                                isCafeMica
                                    ? 'text-[#8c461c] bg-[#fffaf4]/90 border border-[#c49874]/40'
                                    : 'text-amber-300/90 bg-slate-950/80'
                            }`}
                        >
                            DECODING 512pt...
                        </span>
                    ) : isRealAudio ? (
                        <span
                            className={`text-[8px] font-mono px-1 rounded ${
                                isCafeMica
                                    ? 'text-[#1e5638] bg-[#fffaf4]/90 border border-[#4e8763]/40'
                                    : 'text-emerald-400/90 bg-slate-950/75'
                            }`}
                        >
                            RMS 512pt
                        </span>
                    ) : null}
                </div>

                {/* [互動控制] Mix-In 可拖曳豎線 (Seekhead) - 綁定獨立 Pointer Capture 與滾輪 ±0.1s 微調 */}
                <div
                    style={{ left: `${inPercent}%` }}
                    draggable={false}
                    onDragStart={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                    }}
                    onWheel={(e) => {
                        if (disabled) return;
                        e.preventDefault();
                        e.stopPropagation();
                        const step = (e.shiftKey ? 1.0 : 0.1) * (e.deltaY < 0 ? 1 : -1);
                        nudgeCueByStep('mixIn', step);
                    }}
                    onPointerDown={(e) => {
                        if (disabled) return;
                        e.stopPropagation();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        dragAnchorRef.current = {
                            lastClientX: e.clientX,
                            accumulatedSec: mixIn,
                        };
                        setIsFineScrubbing(e.shiftKey);
                        setDraggingHandle('mixIn');
                        triggerAuditionForCue(mixIn, 'mixIn', { immediate: true });
                    }}
                    onPointerMove={(e) => {
                        if (draggingHandle !== 'mixIn') return;
                        e.stopPropagation();
                        updateTimeFromPointerMove(e.clientX, e.shiftKey, 'mixIn');
                    }}
                    onPointerUp={(e) => {
                        if (draggingHandle !== 'mixIn') return;
                        e.stopPropagation();
                        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                            e.currentTarget.releasePointerCapture(e.pointerId);
                        }
                        endHandleDrag();
                    }}
                    onPointerCancel={() => endHandleDrag()}
                    className="nodrag nowheel absolute inset-y-0 -ml-2 w-4 flex flex-col items-center cursor-ew-resize z-20 group touch-none"
                    title="左右拖動設定 Mix-In 進歌點（按住自動預聽，按住 Shift 可 0.1s 精細微調，滾動滑鼠滾輪 ±0.1s）"
                >
                    <div className="px-1 py-0.2 bg-cyan-400 text-slate-950 font-mono font-bold text-[8px] rounded-b shadow pointer-events-none">
                        IN
                    </div>
                    <div className="w-0.5 flex-1 bg-cyan-400 group-hover:w-1 transition-all shadow-[0_0_6px_#22d3ee] pointer-events-none" />
                </div>

                {/* [互動控制] Mix-Out 可拖曳豎線 (Seekhead) - 綁定獨立 Pointer Capture 與滾輪 ±0.1s 微調 */}
                <div
                    style={{ left: `${outPercent}%` }}
                    draggable={false}
                    onDragStart={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                    }}
                    onWheel={(e) => {
                        if (disabled) return;
                        e.preventDefault();
                        e.stopPropagation();
                        const step = (e.shiftKey ? 1.0 : 0.1) * (e.deltaY < 0 ? 1 : -1);
                        nudgeCueByStep('mixOut', step);
                    }}
                    onPointerDown={(e) => {
                        if (disabled) return;
                        e.stopPropagation();
                        e.currentTarget.setPointerCapture(e.pointerId);
                        dragAnchorRef.current = {
                            lastClientX: e.clientX,
                            accumulatedSec: mixOut,
                        };
                        setIsFineScrubbing(e.shiftKey);
                        setDraggingHandle('mixOut');
                        triggerAuditionForCue(mixOut, 'mixOut', { immediate: true });
                    }}
                    onPointerMove={(e) => {
                        if (draggingHandle !== 'mixOut') return;
                        e.stopPropagation();
                        updateTimeFromPointerMove(e.clientX, e.shiftKey, 'mixOut');
                    }}
                    onPointerUp={(e) => {
                        if (draggingHandle !== 'mixOut') return;
                        e.stopPropagation();
                        if (e.currentTarget.hasPointerCapture(e.pointerId)) {
                            e.currentTarget.releasePointerCapture(e.pointerId);
                        }
                        endHandleDrag();
                    }}
                    onPointerCancel={() => endHandleDrag()}
                    className="nodrag nowheel absolute inset-y-0 -ml-2 w-4 flex flex-col items-center cursor-ew-resize z-20 group touch-none"
                    title="左右拖動設定 Mix-Out 切歌點（按住自動預聽前 1.8 秒至切點，按住 Shift 可 0.1s 精細微調，滾動滑鼠滾輪 ±0.1s）"
                >
                    <div className="px-1 py-0.2 bg-rose-400 text-slate-950 font-mono font-bold text-[8px] rounded-b shadow pointer-events-none">
                        OUT
                    </div>
                    <div className="w-0.5 flex-1 bg-rose-400 group-hover:w-1 transition-all shadow-[0_0_6px_#fb7185] pointer-events-none" />
                </div>

                {/* [資訊顯示與滾輪微調區] 左右角落顯示目前秒數（支援滑鼠滾輪 ±0.1s 微調與預聽） */}
                <span
                    onWheel={(e) => {
                        if (disabled) return;
                        e.preventDefault();
                        e.stopPropagation();
                        const step = (e.shiftKey ? 1.0 : 0.1) * (e.deltaY < 0 ? 1 : -1);
                        nudgeCueByStep('mixIn', step);
                    }}
                    title="在此處滾動滑鼠滾輪可 ±0.1s 微調 Mix-In 並即時預聽"
                    className={`nodrag nowheel absolute bottom-0.5 left-1.5 text-[9px] font-mono px-1.5 rounded z-20 cursor-ns-resize ${
                        isCafeMica
                            ? 'text-[#0369a1] font-bold bg-[#fffaf4]/92 border border-[#7cc2e6]/60'
                            : 'text-cyan-300 bg-slate-950/75'
                    }`}
                >
                    In: {formatSmartDuration(mixIn, 'tenths')}
                </span>
                <span
                    onWheel={(e) => {
                        if (disabled) return;
                        e.preventDefault();
                        e.stopPropagation();
                        const step = (e.shiftKey ? 1.0 : 0.1) * (e.deltaY < 0 ? 1 : -1);
                        nudgeCueByStep('mixOut', step);
                    }}
                    title="在此處滾動滑鼠滾輪可 ±0.1s 微調 Mix-Out 並即時預聽"
                    className={`nodrag nowheel absolute bottom-0.5 right-1.5 text-[9px] font-mono px-1.5 rounded z-20 cursor-ns-resize ${
                        isCafeMica
                            ? 'text-[#9f1239] font-bold bg-[#fffaf4]/92 border border-[#f43f5e]/45'
                            : 'text-rose-300 bg-slate-950/75'
                    }`}
                >
                    Out: {formatSmartDuration(mixOut, 'tenths')}
                </span>
            </div>
        </div>
    );
}
