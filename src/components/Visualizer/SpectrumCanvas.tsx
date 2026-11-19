import { useEffect, useRef, useState } from 'react';
import type React from 'react';
import { usePlayerStore } from '../../store/usePlayerStore';
import { useThemeStore } from '../../store/useThemeStore';
import type { VisualizerMode } from '../../types/player';

const CANVAS_HEIGHT_STORAGE_KEY = 'foobar_dj_canvas_height_v2';
const DEFAULT_CANVAS_HEIGHT = 112;

function loadSavedCanvasHeight(): number {
    try {
        const raw = localStorage.getItem(CANVAS_HEIGHT_STORAGE_KEY);
        if (raw) {
            const parsed = Number(raw);
            if (!Number.isNaN(parsed) && parsed >= 48 && parsed <= 280) {
                return parsed;
            }
        }
    } catch {
        // ignore storage errors
    }
    return DEFAULT_CANVAS_HEIGHT;
}

// ============================================================================
// [組件] SpectrumCanvas：60 FPS 高幀率 HTML5 Canvas 多模式音訊視覺化分析儀 (規格書 2.3 & Phase 7)
// 支援單獨拖曳調整 60FPS 視覺化引擎 Canvas Y 軸高度，絕不影響上方專輯封面與播放中曲目資訊區塊
// ============================================================================
export function SpectrumCanvas() {
    const containerRef = useRef<HTMLDivElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const phaseRef = useRef<number>(0);

    const [canvasHeightPx, setCanvasHeightPx] = useState<number>(() =>
        loadSavedCanvasHeight()
    );
    const [isResizingCanvas, setIsResizingCanvas] = useState(false);
    const dragStartRef = useRef<{ startY: number; startHeight: number } | null>(
        null
    );

    const { visualizerMode, setVisualizerMode } = usePlayerStore();
    const themeId = useThemeStore((s) => s.themeId);
    const isCafeMica = themeId === 'm3-cafe-mica';

    const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragStartRef.current = {
            startY: e.clientY,
            startHeight: canvasHeightPx,
        };
        setIsResizingCanvas(true);
    };

    const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragStartRef.current) return;
        // 向下拖曳拉高 60FPS 視覺化引擎 Canvas 的 Y 軸高度；向上拖曳縮減高度，絕不影響上方專輯封面與曲目資訊區塊
        const deltaY = e.clientY - dragStartRef.current.startY;
        const nextHeight = Math.max(
            48,
            Math.min(280, Math.round(dragStartRef.current.startHeight + deltaY))
        );
        setCanvasHeightPx(nextHeight);
    };

    const handleResizePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragStartRef.current) return;
        try {
            e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
            // ignore
        }
        dragStartRef.current = null;
        setIsResizingCanvas(false);
        try {
            localStorage.setItem(
                CANVAS_HEIGHT_STORAGE_KEY,
                String(canvasHeightPx)
            );
        } catch {
            // ignore
        }
    };

    // 監聽外層容器尺寸與 canvasHeightPx 變化，動態同步 Canvas 內部像素解析度
    useEffect(() => {
        const container = containerRef.current;
        const canvas = canvasRef.current;
        if (!container || !canvas) return;

        const updateSize = () => {
            const rect = container.getBoundingClientRect();
            const nextW = Math.max(160, Math.floor(rect.width));
            const nextH = Math.max(40, Math.floor(rect.height));
            if (canvas.width !== nextW || canvas.height !== nextH) {
                canvas.width = nextW;
                canvas.height = nextH;
            }
        };

        updateSize();
        const observer = new ResizeObserver(updateSize);
        observer.observe(container);
        return () => observer.disconnect();
    }, [canvasHeightPx]);

    // 啟動 60FPS requestAnimationFrame Canvas 繪圖迴圈
    useEffect(() => {
        let animationFrameId = 0;

        const renderFrame = () => {
            const canvas = canvasRef.current;
            if (!canvas) return;
            const ctx = canvas.getContext('2d');
            if (!ctx) return;

            const {
                spectrumBins,
                vuLevels,
                isPlaying,
                isPreviewPlaying,
                dominantColor,
                visualizerMode: mode,
            } = usePlayerStore.getState();
            const currentThemeId = useThemeStore.getState().themeId;
            const cafeMicaActive = currentThemeId === 'm3-cafe-mica';

            const activeAudio = isPlaying || isPreviewPlaying;
            const width = canvas.width;
            const height = canvas.height;
            ctx.clearRect(0, 0, width, height);

            const bassEnergy =
                (vuLevels.leftPeak + vuLevels.rightPeak) * 0.5;

            if (mode === 'spectrum') {
                // [模式 1] 64 軌柱狀頻譜分析儀 (X 軸嚴格由左至右：0Hz -> 20kHz)
                const binCount = Math.min(64, spectrumBins.length || 64);
                const barWidth = width / binCount;
                const scaleBarHeight = height >= 64 ? 13 : 0;
                const plotHeight = Math.max(16, height - scaleBarHeight);

                // 繪製背景水平參考微網格線
                ctx.strokeStyle = cafeMicaActive
                    ? 'rgba(180, 145, 118, 0.22)'
                    : 'rgba(148, 163, 184, 0.08)';
                ctx.lineWidth = 1;
                for (let g = 1; g <= 3; g++) {
                    const gy = Math.floor((plotHeight / 4) * g) + 0.5;
                    ctx.beginPath();
                    ctx.moveTo(0, gy);
                    ctx.lineTo(width, gy);
                    ctx.stroke();
                }

                // 由左 (i = 0, 0Hz 低頻) 至右 (i = binCount - 1, 20kHz 高頻) 依序繪製頻譜柱
                for (let i = 0; i < binCount; i++) {
                    const val = spectrumBins[i] ?? 0;
                    const barHeight = Math.max(
                        3,
                        val * Math.max(4, plotHeight - 6)
                    );
                    const x = i * barWidth;
                    const y = plotHeight - barHeight;

                    const grad = ctx.createLinearGradient(0, plotHeight, 0, 0);
                    if (cafeMicaActive) {
                        grad.addColorStop(0, dominantColor || '#c87d4b');
                        grad.addColorStop(0.6, '#d97706');
                        grad.addColorStop(1, '#4e8763');
                    } else {
                        grad.addColorStop(0, dominantColor || '#06b6d4');
                        grad.addColorStop(0.6, '#38bdf8');
                        grad.addColorStop(1, '#f43f5e');
                    }

                    ctx.fillStyle = grad;
                    ctx.fillRect(
                        x + 0.6,
                        y,
                        Math.max(1.2, barWidth - 1.2),
                        barHeight
                    );
                }

                // 繪製底部 X 軸頻率刻度列 (由左至右：0Hz -> 250Hz -> 1kHz -> 4kHz -> 20kHz)
                if (scaleBarHeight > 0) {
                    // 造成原錯誤的原因：刻度底條原先寫死為 rgba(2, 6, 23, 0.78) 深黑底色，導致在北歐晨光燕麥奶淺色主題下底部殘留一條黑帶。
                    // 本次修改的目的：當 cafeMicaActive 為真時改用暖燕麥底色與深焙咖啡色刻度字。
                    ctx.fillStyle = cafeMicaActive
                        ? 'rgba(235, 221, 205, 0.92)'
                        : 'rgba(2, 6, 23, 0.78)';
                    ctx.fillRect(0, plotHeight, width, scaleBarHeight);

                    ctx.strokeStyle = cafeMicaActive
                        ? 'rgba(196, 152, 116, 0.55)'
                        : 'rgba(51, 65, 85, 0.6)';
                    ctx.beginPath();
                    ctx.moveTo(0, plotHeight + 0.5);
                    ctx.lineTo(width, plotHeight + 0.5);
                    ctx.stroke();

                    ctx.fillStyle = cafeMicaActive
                        ? '#5c4030'
                        : 'rgba(148, 163, 184, 0.85)';
                    ctx.font = '9px ui-monospace, SFMono-Regular, Menlo, monospace';
                    ctx.textBaseline = 'middle';
                    const labelY = plotHeight + scaleBarHeight / 2 + 0.5;

                    ctx.textAlign = 'left';
                    ctx.fillText('0Hz', 4, labelY);

                    ctx.textAlign = 'center';
                    ctx.fillText('250Hz', width * 0.25, labelY);
                    ctx.fillText('1kHz', width * 0.5, labelY);
                    ctx.fillText('4kHz', width * 0.75, labelY);

                    ctx.textAlign = 'right';
                    ctx.fillText('20kHz', width - 4, labelY);
                }
            } else if (mode === 'oscilloscope') {
                // [模式 2] 向量波形示波器 (使用 - phaseRef.current 讓波形由左至右自然推進)
                phaseRef.current += activeAudio
                    ? 0.14 + bassEnergy * 0.18
                    : 0.02;

                // 中心基準線
                ctx.strokeStyle = cafeMicaActive
                    ? 'rgba(180, 145, 118, 0.35)'
                    : 'rgba(148, 163, 184, 0.12)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.moveTo(0, height / 2);
                ctx.lineTo(width, height / 2);
                ctx.stroke();

                ctx.beginPath();
                ctx.lineWidth = 2.2;
                ctx.strokeStyle =
                    dominantColor || (cafeMicaActive ? '#c87d4b' : '#22d3ee');
                ctx.shadowColor =
                    dominantColor || (cafeMicaActive ? '#c87d4b' : '#22d3ee');
                ctx.shadowBlur = 10;

                const sliceWidth = width / 64;
                for (let i = 0; i <= 64; i++) {
                    const binVal = spectrumBins[i % spectrumBins.length] ?? 0;
                    const amp = activeAudio
                        ? (binVal * 0.78 + 0.08) * (height * 0.42)
                        : 2;
                    const y =
                        height / 2 +
                        Math.sin(i * 0.35 - phaseRef.current) * amp;
                    const x = i * sliceWidth;

                    if (i === 0) {
                        ctx.moveTo(x, y);
                    } else {
                        ctx.lineTo(x, y);
                    }
                }
                ctx.stroke();
                ctx.shadowBlur = 0;
            } else {
                // [模式 3] 360° 環狀示波器 (Circular Oscilloscope)
                phaseRef.current += activeAudio
                    ? 0.08 + bassEnergy * 0.15
                    : 0.015;

                const cx = width / 2;
                const cy = height / 2;
                const minDim = Math.min(width, height);
                const baseRadius = Math.max(
                    14,
                    minDim * (0.25 + bassEnergy * 0.05)
                );
                const maxExcursion = Math.max(8, minDim * 0.21);

                // 1. 背景同心圓參考網格
                ctx.strokeStyle = cafeMicaActive
                    ? 'rgba(180, 145, 118, 0.28)'
                    : 'rgba(148, 163, 184, 0.1)';
                ctx.lineWidth = 1;
                ctx.beginPath();
                ctx.arc(cx, cy, baseRadius * 0.65, 0, Math.PI * 2);
                ctx.arc(cx, cy, baseRadius, 0, Math.PI * 2);
                ctx.arc(cx, cy, baseRadius + maxExcursion * 0.65, 0, Math.PI * 2);
                ctx.stroke();

                // 2. 內圈反向諧波共振環 (副軌跡)
                const segments = 128;
                ctx.beginPath();
                ctx.lineWidth = 1.4;
                ctx.strokeStyle = cafeMicaActive
                    ? 'rgba(78, 135, 99, 0.55)'
                    : 'rgba(56, 189, 248, 0.45)';
                for (let i = 0; i <= segments; i++) {
                    const ratio = i / segments;
                    const angle = ratio * Math.PI * 2 - Math.PI / 2;
                    const mirroredRatio =
                        ratio <= 0.5 ? ratio * 2 : (1 - ratio) * 2;
                    const binIdx = Math.min(
                        spectrumBins.length - 1,
                        Math.floor(mirroredRatio * (spectrumBins.length - 1))
                    );
                    const binVal = spectrumBins[binIdx] ?? 0;
                    const wave = activeAudio
                        ? Math.cos(angle * 6 + phaseRef.current * 1.4) *
                          binVal *
                          (maxExcursion * 0.45)
                        : Math.cos(angle * 4 + phaseRef.current) * 1.2;
                    const r = baseRadius * 0.78 + wave;
                    const px = cx + Math.cos(angle) * r;
                    const py = cy + Math.sin(angle) * r;
                    if (i === 0) ctx.moveTo(px, py);
                    else ctx.lineTo(px, py);
                }
                ctx.closePath();
                ctx.stroke();

                // 3. 主環狀示波器波形
                ctx.beginPath();
                ctx.lineWidth = 2.2;
                ctx.strokeStyle =
                    dominantColor || (cafeMicaActive ? '#c87d4b' : '#22d3ee');
                ctx.shadowColor =
                    dominantColor || (cafeMicaActive ? '#c87d4b' : '#22d3ee');
                ctx.shadowBlur = 10;

                for (let i = 0; i <= segments; i++) {
                    const ratio = i / segments;
                    const angle = ratio * Math.PI * 2 - Math.PI / 2;
                    const mirroredRatio =
                        ratio <= 0.5 ? ratio * 2 : (1 - ratio) * 2;
                    const binIdx = Math.min(
                        spectrumBins.length - 1,
                        Math.floor(mirroredRatio * (spectrumBins.length - 1))
                    );
                    const binVal = spectrumBins[binIdx] ?? 0;

                    const carrier = Math.sin(
                        angle * 8 - phaseRef.current * 1.8
                    );
                    const displacement = activeAudio
                        ? (binVal * 0.65 +
                              binVal * carrier * 0.55 +
                              bassEnergy * 0.12) *
                          maxExcursion
                        : Math.sin(angle * 4 - phaseRef.current) * 1.8;

                    const r = baseRadius + displacement;
                    const px = cx + Math.cos(angle) * r;
                    const py = cy + Math.sin(angle) * r;

                    if (i === 0) {
                        ctx.moveTo(px, py);
                    } else {
                        ctx.lineTo(px, py);
                    }
                }
                ctx.closePath();
                ctx.stroke();

                ctx.fillStyle = `${
                    dominantColor || (cafeMicaActive ? '#c87d4b' : '#22d3ee')
                }18`;
                ctx.fill();
                ctx.shadowBlur = 0;
            }

            animationFrameId = window.requestAnimationFrame(renderFrame);
        };

        animationFrameId = window.requestAnimationFrame(renderFrame);
        return () => window.cancelAnimationFrame(animationFrameId);
    }, []);

    const modes: Array<{ key: VisualizerMode; label: string }> = [
        { key: 'spectrum', label: '頻譜' },
        { key: 'oscilloscope', label: '示波器' },
        { key: 'particles', label: '環狀示波器' },
    ];

    return (
        <div className="flex flex-col gap-1.5 pt-1 shrink-0">
            {/* 視覺化模式切換按鈕組 (文字縮短為「60FPS 視覺化引擎」) */}
            <div className="flex items-center justify-between shrink-0">
                <span className="text-[10px] font-mono text-slate-400">
                    60FPS 視覺化引擎
                </span>
                <div className="flex items-center gap-1">
                    {modes.map((m) => (
                        <button
                            key={m.key}
                            onClick={() => setVisualizerMode(m.key)}
                            className={`px-2 py-0.5 text-[10px] font-semibold rounded border transition cursor-pointer ${
                                visualizerMode === m.key
                                    ? 'bg-cyan-600 border-cyan-400 text-white'
                                    : 'bg-slate-900 border-slate-800 text-slate-400 hover:text-slate-200'
                            }`}
                        >
                            {m.label}
                        </button>
                    ))}
                </div>
            </div>

            {/* HTML5 60FPS 畫布獨立高度容器：僅隨下方拖曳把柄改變 Y 軸高度 */}
            <div
                ref={containerRef}
                style={{ height: `${canvasHeightPx}px` }}
                className={`w-full shrink-0 rounded-t-lg border overflow-hidden relative ${
                    isCafeMica
                        ? 'bg-[#f4ece2] border-[#c49874]/55'
                        : 'bg-slate-900/70 border-slate-800/80'
                }`}
            >
                <canvas
                    ref={canvasRef}
                    className="absolute inset-0 w-full h-full block"
                />
            </div>

            {/* 專屬 60FPS 視覺化引擎 Canvas 底部拖曳把柄：單獨調整視覺化圖形 Y 軸高度，絕不影響上方專輯封面與播放曲目資訊 */}
            <div
                onPointerDown={handleResizePointerDown}
                onPointerMove={handleResizePointerMove}
                onPointerUp={handleResizePointerUp}
                onPointerCancel={handleResizePointerUp}
                onDoubleClick={() => {
                    setCanvasHeightPx(DEFAULT_CANVAS_HEIGHT);
                    try {
                        localStorage.setItem(
                            CANVAS_HEIGHT_STORAGE_KEY,
                            String(DEFAULT_CANVAS_HEIGHT)
                        );
                    } catch {
                        // ignore
                    }
                }}
                title="上下拖曳可單獨調整 60FPS 視覺化引擎 Canvas 的 Y 軸高度（雙擊恢復預設高度，絕不影響上方專輯封面與曲目資訊）"
                className={`h-3.5 -mt-1.5 shrink-0 flex items-center justify-center gap-2 cursor-ns-resize select-none rounded-b-lg border-x border-b transition ${
                    isResizingCanvas
                        ? isCafeMica
                            ? 'bg-[#e8d4be] border-[#c87d4b] text-[#7c3d12]'
                            : 'bg-cyan-950/90 border-cyan-500/80 text-cyan-300'
                        : isCafeMica
                          ? 'bg-[#efe2d4] hover:bg-[#e5d4c2] border-[#c49874]/55 hover:border-[#c87d4b] text-[#5c4030] hover:text-[#2b1e17]'
                          : 'bg-slate-900/90 hover:bg-slate-800/90 border-slate-800/80 hover:border-cyan-500/40 text-slate-500 hover:text-cyan-300'
                }`}
            >
                <span className="w-7 h-0.5 rounded-full bg-current opacity-60" />
                <span className="text-[9px] font-mono tracking-wider">
                    ↕ 畫布高度 {canvasHeightPx}px
                </span>
                <span className="w-7 h-0.5 rounded-full bg-current opacity-60" />
            </div>
        </div>
    );
}
