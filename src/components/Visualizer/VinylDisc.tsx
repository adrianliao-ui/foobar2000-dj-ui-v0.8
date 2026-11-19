import { useEffect, useMemo, useRef, useState } from 'react';
import type React from 'react';
import {
    fetchSingleTrackRealCover,
    normalizeAudioPathForMatch,
} from '../../api/mockBridge';
import { usePlayerStore } from '../../store/usePlayerStore';
import { usePlaylistStore } from '../../store/usePlaylistStore';
import { useThemeStore } from '../../store/useThemeStore';
import { useWorkflowStore } from '../../store/useWorkflowStore';
import {
    ensureArtworkCacheLoaded,
    getCachedCoverSync,
} from '../../utils/artworkCache';
import { extractDominantColorFromUrl } from '../../utils/colorExtractor';

const VINYL_HEIGHT_STORAGE_KEY = 'foobar_dj_vinyl_height_v1';
const DEFAULT_VINYL_HEIGHT = 192;
const MIN_VINYL_HEIGHT = 120;

function loadSavedVinylHeight(): number {
    try {
        const raw = localStorage.getItem(VINYL_HEIGHT_STORAGE_KEY);
        if (raw) {
            const parsed = Number(raw);
            if (!Number.isNaN(parsed) && parsed >= MIN_VINYL_HEIGHT && parsed <= 420) {
                return parsed;
            }
        }
    } catch {
        // ignore storage errors
    }
    return DEFAULT_VINYL_HEIGHT;
}

// ============================================================================
// [組件] VinylDisc：獨立專輯封面 Artwork 展示區塊（支援底部高度調整拉桿，高度上限為外框長寬比 1:1，專輯圖片跟著等比例放大縮小）
// 當處於媒體庫「試聽」時自動切換顯示試聽曲目封面，停止試聽後自動回復顯示總時間軸 currentTrack 封面
// ============================================================================
export function VinylDisc() {
    const outerBoxRef = useRef<HTMLDivElement | null>(null);
    const [boxHeightPx, setBoxHeightPx] = useState<number>(() =>
        loadSavedVinylHeight()
    );
    const [maxSquareHeightPx, setMaxSquareHeightPx] = useState<number>(280);
    const [isResizingVinyl, setIsResizingVinyl] = useState(false);
    const dragStartRef = useRef<{ startY: number; startHeight: number } | null>(
        null
    );

    const currentTrack = usePlayerStore((s) => s.currentTrack);
    const previewTrack = usePlayerStore((s) => s.previewTrack);
    const isPlaying = usePlayerStore((s) => s.isPlaying);
    const isPreviewPlaying = usePlayerStore((s) => s.isPreviewPlaying);
    const dominantColor = usePlayerStore((s) => s.dominantColor);
    const setDominantColor = usePlayerStore((s) => s.setDominantColor);
    const updateCurrentTrackComputedMeta = usePlayerStore(
        (s) => s.updateCurrentTrackComputedMeta
    );
    const allTracks = usePlaylistStore((s) => s.allTracks);
    const updateTrackComputedMeta = usePlaylistStore(
        (s) => s.updateTrackComputedMeta
    );
    const workflowNodes = useWorkflowStore((s) => s.nodes);
    const updateTrackComputedMetaInWorkflow = useWorkflowStore(
        (s) => s.updateTrackComputedMetaInWorkflow
    );
    const themeId = useThemeStore((s) => s.themeId);
    const isCafeMica = themeId === 'm3-cafe-mica';

    const activeAudio = isPlaying || isPreviewPlaying;
    const displayTrack =
        isPreviewPlaying && previewTrack ? previewTrack : currentTrack;

    // 偵測專輯封面區塊外框寬度，將高度上限鎖定為長寬比 1:1 (即最大高度 = 容器寬度)
    useEffect(() => {
        const el = outerBoxRef.current;
        if (!el) return;

        const updateMaxSquare = () => {
            const rect = el.getBoundingClientRect();
            const width = Math.floor(rect.width);
            if (width >= MIN_VINYL_HEIGHT) {
                setMaxSquareHeightPx(width);
                setBoxHeightPx((prev) => Math.min(prev, width));
            }
        };

        updateMaxSquare();
        const observer = new ResizeObserver(updateMaxSquare);
        observer.observe(el);
        return () => observer.disconnect();
    }, []);

    const effectiveHeightPx = Math.max(
        MIN_VINYL_HEIGHT,
        Math.min(maxSquareHeightPx, boxHeightPx)
    );
    // 專輯封面正方形主圖隨外框高度等比例放大縮小（扣除上下內距 24px）
    const artworkSizePx = Math.max(92, effectiveHeightPx - 24);
    // 造成原錯誤的原因：原本外圍光暈 w-44 (176px) 擴散距離過大且透明度偏低，呼吸幅度僅有靜態 scale-110。
    // 本次修改的目的：將光暈擴散距離縮小至原來的 70%（並隨專輯圖片等比例縮放），可見度提升 20%，且播放中套用大幅度呼吸效果。
    const haloSizePx = Math.round(artworkSizePx * 0.78);

    const handleResizePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        e.preventDefault();
        e.currentTarget.setPointerCapture(e.pointerId);
        dragStartRef.current = {
            startY: e.clientY,
            startHeight: effectiveHeightPx,
        };
        setIsResizingVinyl(true);
    };

    const handleResizePointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragStartRef.current) return;
        const deltaY = e.clientY - dragStartRef.current.startY;
        const nextHeight = Math.max(
            MIN_VINYL_HEIGHT,
            Math.min(
                maxSquareHeightPx,
                Math.round(dragStartRef.current.startHeight + deltaY)
            )
        );
        setBoxHeightPx(nextHeight);
    };

    const handleResizePointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
        if (!dragStartRef.current) return;
        try {
            e.currentTarget.releasePointerCapture(e.pointerId);
        } catch {
            // ignore
        }
        dragStartRef.current = null;
        setIsResizingVinyl(false);
        try {
            localStorage.setItem(
                VINYL_HEIGHT_STORAGE_KEY,
                String(effectiveHeightPx)
            );
        } catch {
            // ignore
        }
    };

    const coverUrl = useMemo(() => {
        if (!displayTrack) return null;
        if (displayTrack.coverUrl) return displayTrack.coverUrl;

        const normDisplayPath = normalizeAudioPathForMatch(displayTrack.path);
        const cleanAlbum = (displayTrack.album ?? '').trim().toLowerCase();
        const cleanArtist = (displayTrack.artist ?? '').trim().toLowerCase();

        // 第 2 層：從媒體庫精確匹配相同 ID 或正規化路徑
        const matchedInLibrary = allTracks.find(
            (t) =>
                (t.id === displayTrack.id ||
                    (Boolean(normDisplayPath) &&
                        normalizeAudioPathForMatch(t.path) ===
                            normDisplayPath)) &&
                Boolean(t.coverUrl)
        );
        if (matchedInLibrary?.coverUrl) return matchedInLibrary.coverUrl;

        // 第 3 層：從畫布節點 (workflowNodes) 尋找包含該曲目或相同專輯的封面
        for (const node of workflowNodes) {
            const group = node.data.albumGroup;
            const hasTrackInNode = group.tracks.some(
                (nt) =>
                    nt.id === displayTrack.id ||
                    (Boolean(normDisplayPath) &&
                        normalizeAudioPathForMatch(nt.path) === normDisplayPath)
            );
            const isSameAlbumGroup =
                Boolean(cleanAlbum) &&
                group.album.trim().toLowerCase() === cleanAlbum &&
                (!cleanArtist ||
                    group.artist.trim().toLowerCase() === cleanArtist);

            if (hasTrackInNode || isSameAlbumGroup) {
                if (group.coverUrl) return group.coverUrl;
                const trackWithCover = group.tracks.find((nt) =>
                    Boolean(nt.coverUrl)
                );
                if (trackWithCover?.coverUrl) return trackWithCover.coverUrl;
            }
        }

        // 第 4 層：從媒體庫尋找同專輯其他曲目的已載入封面
        if (cleanAlbum) {
            const siblingInLib = allTracks.find(
                (t) =>
                    Boolean(t.coverUrl) &&
                    t.album.trim().toLowerCase() === cleanAlbum &&
                    (!cleanArtist ||
                        t.artist.trim().toLowerCase() === cleanArtist)
            );
            if (siblingInLib?.coverUrl) return siblingInLib.coverUrl;
        }

        // 第 5 層：查詢記憶體與 IndexedDB 雙層封面快取
        const cached = getCachedCoverSync(
            displayTrack.path,
            displayTrack.artist,
            displayTrack.album
        );
        return cached || null;
    }, [displayTrack, allTracks, workflowNodes]);

    // 當切換曲目封面或切換面板主題時，重新透過對比度增強算法計算最適合當前面板的主色調
    useEffect(() => {
        if (!coverUrl) return;
        let cancelled = false;
        void extractDominantColorFromUrl(coverUrl, themeId).then((hex) => {
            if (!cancelled && hex) {
                setDominantColor(hex);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [coverUrl, themeId, setDominantColor]);

    // 當最小化還原或切換曲目後若仍無封面，主動等待 IndexedDB 快取載入並向 foobar2000 宿主提取封面回填
    useEffect(() => {
        if (!displayTrack || coverUrl) return;

        let cancelled = false;
        void (async () => {
            await ensureArtworkCacheLoaded();
            if (cancelled) return;

            const cachedAfterLoad = getCachedCoverSync(
                displayTrack.path,
                displayTrack.artist,
                displayTrack.album
            );
            if (cachedAfterLoad) {
                updateCurrentTrackComputedMeta(
                    displayTrack.id,
                    displayTrack.path,
                    { coverUrl: cachedAfterLoad }
                );
                updateTrackComputedMeta(displayTrack.id, displayTrack.path, {
                    coverUrl: cachedAfterLoad,
                });
                updateTrackComputedMetaInWorkflow(
                    displayTrack.id,
                    displayTrack.path,
                    { coverUrl: cachedAfterLoad }
                );
                return;
            }

            if (
                displayTrack.path &&
                !displayTrack.path.startsWith('C:\\Music\\DJ_Set\\')
            ) {
                const realCover = await fetchSingleTrackRealCover(
                    displayTrack.path,
                    displayTrack.artist,
                    displayTrack.album
                );
                if (cancelled || !realCover) return;
                updateCurrentTrackComputedMeta(
                    displayTrack.id,
                    displayTrack.path,
                    { coverUrl: realCover }
                );
                updateTrackComputedMeta(displayTrack.id, displayTrack.path, {
                    coverUrl: realCover,
                });
                updateTrackComputedMetaInWorkflow(
                    displayTrack.id,
                    displayTrack.path,
                    { coverUrl: realCover }
                );
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [
        displayTrack,
        coverUrl,
        updateCurrentTrackComputedMeta,
        updateTrackComputedMeta,
        updateTrackComputedMetaInWorkflow,
    ]);

    return (
        // 造成原錯誤的原因：先前直接將內層圖片視窗設為 .bg-slate-950 並疊加 opacity-40 blur-xl 灰暗模糊底圖，導致背景呈現灰色而非主題配色，且 .bg-slate-950 被全站主題強制套用 16px 圓角而壓過下方高度拉桿。
        // 本次修改的目的：完全比照下方 60FPS 視覺化引擎 (SpectrumCanvas) 的雙層結構，外層使用主題卡片容器，內層採用主題背景色 (m3-cafe-mica 為 #f4ece2、深色主題為 bg-slate-900/70) 並以 rounded-t-lg 與底部 -mt-1.5 拉桿無縫銜接。
        <div className="bg-slate-950 border border-slate-800 rounded-xl p-2.5 flex flex-col gap-1.5 shrink-0">
            {/* 專輯封面主容器：高度由拉桿動態控制 (上限為 1:1 正方形)，光暈擴散縮小至 70% 且可見度提升 20% */}
            <div
                ref={outerBoxRef}
                style={{
                    height: `${effectiveHeightPx}px`,
                    boxShadow: activeAudio
                        ? `inset 0 0 36px ${dominantColor}47, inset 0 0 14px ${dominantColor}2e`
                        : `inset 0 0 22px ${dominantColor}26`,
                }}
                className={`w-full shrink-0 rounded-t-lg border p-2.5 flex flex-col items-center justify-center relative overflow-hidden transition-shadow duration-500 ${
                    isCafeMica
                        ? 'bg-[#f4ece2] border-[#c49874]/55'
                        : 'bg-slate-900/70 border-slate-800/80'
                }`}
            >
                {/* 背景微光氛圍層 (擴散距離收斂至 70%，中心可見度提升 20%，不覆蓋主題底色) */}
                <div
                    style={{
                        background: activeAudio
                            ? `radial-gradient(circle at center, ${dominantColor}99 0%, ${dominantColor}4d 32%, transparent 55%)`
                            : `radial-gradient(circle at center, ${dominantColor}66 0%, ${dominantColor}2e 34%, transparent 53%)`,
                    }}
                    className="absolute inset-0 pointer-events-none transition-all duration-500"
                />

                {/* 專輯封面外圍擴散光暈光環 (擴散距離縮小至 70%、可見度提升 20%，播放中啟用大幅度呼吸動畫) */}
                <div
                    style={{
                        width: `${haloSizePx}px`,
                        height: `${haloSizePx}px`,
                        background: `radial-gradient(circle, ${dominantColor}bd 0%, ${dominantColor}66 38%, transparent 56%)`,
                    }}
                    className={`absolute rounded-full blur-xl pointer-events-none transition-opacity duration-500 ${
                        activeAudio
                            ? 'dj-glow-breathe-halo opacity-100'
                            : 'opacity-80 scale-95'
                    }`}
                />

                {/* 專輯封面主圖：隨高度拉桿 1:1 等比例放大縮小，外擴光暈縮小至 70% 並強化 20% 可見度與呼吸幅度 */}
                <div
                    style={
                        {
                            width: `${artworkSizePx}px`,
                            height: `${artworkSizePx}px`,
                            '--dj-breathe-color': dominantColor,
                            borderColor: activeAudio
                                ? `${dominantColor}ff`
                                : `${dominantColor}cc`,
                            boxShadow: activeAudio
                                ? `0 0 15px ${dominantColor}ff, 0 0 32px ${dominantColor}cc, 0 0 53px ${dominantColor}80, inset 0 0 12px ${dominantColor}66`
                                : `0 0 11px ${dominantColor}b8, 0 0 25px ${dominantColor}66, 0 6px 16px rgba(0,0,0,0.45)`,
                        } as React.CSSProperties
                    }
                    className={`relative aspect-square rounded-xl border-2 overflow-hidden bg-slate-900 flex items-center justify-center z-10 transition-shadow duration-300 ${
                        activeAudio ? 'dj-glow-breathe-frame' : ''
                    }`}
                >
                    {coverUrl ? (
                        <img
                            src={coverUrl}
                            alt={displayTrack?.album ?? 'Album Artwork'}
                            referrerPolicy="no-referrer"
                            className="w-full h-full object-cover transition-transform duration-500"
                        />
                    ) : (
                        <div className="flex flex-col items-center justify-center gap-2 text-slate-400">
                            <div
                                style={{
                                    borderColor: `${dominantColor}aa`,
                                    boxShadow: `0 0 13px ${dominantColor}80`,
                                }}
                                className={`w-14 h-14 rounded-full border-2 flex items-center justify-center bg-slate-950 ${
                                    activeAudio
                                        ? 'animate-[spin_8s_linear_infinite]'
                                        : ''
                                }`}
                            >
                                <div
                                    style={{
                                        backgroundColor: `${dominantColor}55`,
                                        borderColor: dominantColor,
                                    }}
                                    className="w-4 h-4 rounded-full border"
                                />
                            </div>
                            <span className="text-[11px] font-mono">
                                無專輯封面
                            </span>
                        </div>
                    )}

                    {/* 左下角動態萃取主色調色票指示 */}
                    <div className="absolute bottom-2 left-2 bg-slate-950/85 backdrop-blur-sm border border-slate-700/80 rounded-full px-2 py-0.5 flex items-center gap-1.5 shadow">
                        <span
                            style={{
                                backgroundColor: dominantColor,
                                boxShadow: `0 0 6px ${dominantColor}`,
                            }}
                            className="w-2 h-2 rounded-full border border-white/50"
                        />
                        <span className="text-[9px] font-mono text-slate-200 uppercase">
                            {dominantColor}
                        </span>
                    </div>

                    {/* 右下角播放狀態迷你徽章 */}
                    <div className="absolute bottom-2 right-2 bg-slate-950/85 backdrop-blur-sm border border-slate-700/80 rounded-full px-2 py-0.5 flex items-center gap-1.5 shadow">
                        <span
                            className={`w-2 h-2 rounded-full ${
                                isPreviewPlaying
                                    ? 'bg-amber-400 animate-pulse'
                                    : isPlaying
                                      ? 'bg-emerald-400 animate-pulse'
                                      : 'bg-cyan-400'
                            }`}
                        />
                        <span className="text-[9px] font-mono text-slate-200">
                            {isPreviewPlaying
                                ? 'PREVIEW'
                                : isPlaying
                                  ? 'PLAYING'
                                  : 'READY'}
                        </span>
                    </div>
                </div>
            </div>

            {/* 專屬專輯封面區塊底部高度調整拉桿（高度上限為外框長寬比 1:1，雙擊恢復預設高度 192px） */}
            <div
                onPointerDown={handleResizePointerDown}
                onPointerMove={handleResizePointerMove}
                onPointerUp={handleResizePointerUp}
                onPointerCancel={handleResizePointerUp}
                onDoubleClick={() => {
                    const target = Math.min(
                        maxSquareHeightPx,
                        DEFAULT_VINYL_HEIGHT
                    );
                    setBoxHeightPx(target);
                    try {
                        localStorage.setItem(
                            VINYL_HEIGHT_STORAGE_KEY,
                            String(target)
                        );
                    } catch {
                        // ignore
                    }
                }}
                title="上下拖曳可調整專輯封面區塊高度（上限為長寬比 1:1，專輯圖片等比例縮放；雙擊恢復預設高度）"
                className={`h-3.5 -mt-1.5 shrink-0 flex items-center justify-center gap-2 cursor-ns-resize select-none rounded-b-lg border-x border-b transition ${
                    isResizingVinyl
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
                    ↕ 封面高度 {effectiveHeightPx}px
                </span>
                <span className="w-7 h-0.5 rounded-full bg-current opacity-60" />
            </div>
        </div>
    );
}
