import { useEffect, useRef } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { usePlaylistStore } from '../../store/usePlaylistStore';
import { useWorkflowStore } from '../../store/useWorkflowStore';
import { usePlayerStore } from '../../store/usePlayerStore';
import { isM3LayoutTheme, useThemeStore } from '../../store/useThemeStore';

// ============================================================================
// [組件] VirtualTrackList：基於 @tanstack/react-virtual 的高效能虛擬滾動列表
// 支援單選預覽封面、Ctrl/Cmd 多選、Shift 範圍多選、自動捲動定位、試聽、單曲移除 (✕)，以及直接拖曳進入畫布座標
// ============================================================================
export function VirtualTrackList() {
    const parentRef = useRef<HTMLDivElement | null>(null);
    // 記錄已執行過捲動定位的 timestamp，避免因重繪而重複觸發 scrollToIndex
    const lastScrolledTimestampRef = useRef<number>(0);

    const allTracks = usePlaylistStore((s) => s.allTracks);
    const filteredTracks = usePlaylistStore((s) => s.filteredTracks);
    const filteredAlbumGroups = usePlaylistStore((s) => s.filteredAlbumGroups);
    const viewMode = usePlaylistStore((s) => s.viewMode);
    const selectedTrackIds = usePlaylistStore((s) => s.selectedTrackIds);
    const scrollTarget = usePlaylistStore((s) => s.scrollTarget);
    const clearScrollTarget = usePlaylistStore((s) => s.clearScrollTarget);
    const setSelectedTrack = usePlaylistStore((s) => s.setSelectedTrack);
    const toggleSelectTrack = usePlaylistStore((s) => s.toggleSelectTrack);
    const selectTrackRange = usePlaylistStore((s) => s.selectTrackRange);
    const removeTrackFromLibrary = usePlaylistStore(
        (s) => s.removeTrackFromLibrary
    );

    const addAlbumGroupToCanvas = useWorkflowStore(
        (s) => s.addAlbumGroupToCanvas
    );
    const isLiveLocked = usePlayerStore((s) => s.isLiveLocked);
    const currentTrackId = usePlayerStore((s) => s.currentTrack?.id);
    const isPlaying = usePlayerStore((s) => s.isPlaying);
    const isPreviewPlaying = usePlayerStore((s) => s.isPreviewPlaying);
    const previewTrackId = usePlayerStore((s) => s.previewTrackId);
    const previewPlayTrack = usePlayerStore((s) => s.previewPlayTrack);
    const themeId = useThemeStore((s) => s.themeId);
    const isM3Style = isM3LayoutTheme(themeId);
    const isCafeMica = themeId === 'm3-cafe-mica';

    const itemCount =
        viewMode === 'tracks'
            ? filteredTracks.length
            : filteredAlbumGroups.length;

    // [修復問題 1b：媒體庫清單文字略為超出底色的問題]
    // 造成錯誤的原因：原先單曲高度設為 62px (扣除間距 6px 後僅 56px)，再扣除上下 padding 16px 與邊框後僅剩 38px，無法容納 3 行文字 (總高約 46px)。
    // 修改的目的：將單曲列高提升至 68px (實高 62px)、專輯列高提升至 72px (實高 66px)，搭配緊湊行高與內距，確保 3 行曲目文字 100% 完整包覆於底色卡片內。
    const rowVirtualizer = useVirtualizer({
        count: itemCount,
        getScrollElement: () => parentRef.current,
        estimateSize: () => (viewMode === 'tracks' ? 68 : 72),
        overscan: 6,
    });

    // [修復問題 1：解決在左側智慧媒體庫清單多選曲目時發生程式卡死（無限重繪與捲動迴圈）的問題]
    useEffect(() => {
        if (
            !scrollTarget ||
            scrollTarget.timestamp === lastScrolledTimestampRef.current
        ) {
            return;
        }
        lastScrolledTimestampRef.current = scrollTarget.timestamp;

        if (viewMode === 'tracks') {
            const targetIdx = filteredTracks.findIndex(
                (t) => t.id === scrollTarget.trackId
            );
            if (targetIdx !== -1) {
                rowVirtualizer.scrollToIndex(targetIdx, {
                    align: 'center',
                });
            }
        } else {
            const targetGroupIdx = filteredAlbumGroups.findIndex((g) =>
                g.tracks.some((t) => t.id === scrollTarget.trackId)
            );
            if (targetGroupIdx !== -1) {
                rowVirtualizer.scrollToIndex(targetGroupIdx, {
                    align: 'center',
                });
            }
        }

        clearScrollTarget();
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [scrollTarget, viewMode, filteredTracks, filteredAlbumGroups, clearScrollTarget]);

    if (itemCount === 0) {
        return (
            <div className="flex-1 min-h-[140px] flex flex-col items-center justify-center text-center text-xs text-slate-400 px-4 py-8 border border-dashed border-slate-800 rounded-xl gap-1.5">
                {allTracks.length === 0 ? (
                    <>
                        <span className="text-slate-300 font-semibold">
                            目前清單尚無任何曲目 (0 首)
                        </span>
                        <span className="text-[11px] text-slate-500">
                            請點擊上方「➕ 新建 Playlist...」或「➕ 加入本地檔案」匯入音樂，或從歌單下拉選單切換其他播放清單
                        </span>
                    </>
                ) : (
                    <span>無符合目前篩選條件的曲目</span>
                )}
            </div>
        );
    }

    return (
        <div
            ref={parentRef}
            className="flex-1 min-h-0 overflow-auto pr-1 select-none"
        >
            <div
                style={{
                    height: `${rowVirtualizer.getTotalSize()}px`,
                    width: '100%',
                    position: 'relative',
                }}
            >
                {rowVirtualizer.getVirtualItems().map((virtualRow) => {
                    // [模式 A] 單曲檢視模式
                    if (viewMode === 'tracks') {
                        const track = filteredTracks[virtualRow.index];
                        if (!track) return null;
                        const isSelected = selectedTrackIds.includes(track.id);
                        const isThisTrackPreviewing =
                            isPreviewPlaying && previewTrackId === track.id;
                        const isThisTrackMasterPlaying =
                            currentTrackId === track.id && isPlaying;
                        const isActivePlaying =
                            isThisTrackPreviewing || isThisTrackMasterPlaying;

                        // [統一套用 Material 3 深色 & 北歐晨光燕麥奶淺色雲母曲目狀態規範]
                        const cafeMicaTrackStateClass = isSelected
                            ? 'bg-[#f4dec8]/95 border-[#c87d4b] ring-1 ring-[#c87d4b]/55 shadow-sm'
                            : isActivePlaying
                              ? 'bg-[#d9efe0]/95 border-[#4e8763] shadow-sm'
                              : 'bg-[#fffaf4]/84 border-[#c49874]/30 hover:bg-[#f6eadc]/95 hover:border-[#c87d4b]/55';

                        const m3DarkTrackStateClass = isSelected
                            ? 'bg-[#1e3252] border-[#8ab4f8] ring-1 ring-[#8ab4f8]/50 shadow-sm'
                            : isActivePlaying
                              ? 'bg-[#143534] border-[#4db6ac] shadow-sm'
                              : 'bg-[#131722] border-[#a8c7fa]/12 hover:bg-[#1d2332] hover:border-[#a8c7fa]/30';

                        const classicTrackStateClass = isSelected
                            ? 'bg-cyan-950/40 border-cyan-500/80 shadow'
                            : isActivePlaying
                              ? 'bg-emerald-950/45 border-emerald-500/80'
                              : 'bg-slate-950/60 border-slate-800/80 hover:bg-slate-800/50';

                        return (
                            <div
                                key={track.id}
                                style={{
                                    position: 'absolute',
                                    top: 0,
                                    left: 0,
                                    width: '100%',
                                    height: `${virtualRow.size - 6}px`,
                                    transform: `translateY(${virtualRow.start}px)`,
                                }}
                                draggable={!isLiveLocked}
                                onDragStart={(e) => {
                                    if (isLiveLocked) {
                                        e.preventDefault();
                                        return;
                                    }
                                    const dragIds = isSelected
                                        ? selectedTrackIds
                                        : [track.id];
                                    e.dataTransfer.effectAllowed = 'copy';
                                    e.dataTransfer.setData(
                                        'application/x-foobar-dj-tracks',
                                        JSON.stringify(dragIds)
                                    );
                                }}
                                onClick={(e) => {
                                    if (e.shiftKey) {
                                        selectTrackRange(track.id, track);
                                    } else {
                                        toggleSelectTrack(
                                            track.id,
                                            e.ctrlKey || e.metaKey,
                                            track
                                        );
                                    }
                                }}
                                className={`px-2.5 py-1.5 ${
                                    isM3Style ? 'rounded-xl' : 'rounded-lg'
                                } border flex items-center gap-2 overflow-hidden transition ${
                                    !isLiveLocked
                                        ? 'cursor-grab active:cursor-grabbing'
                                        : 'cursor-pointer'
                                } ${
                                    isCafeMica
                                        ? cafeMicaTrackStateClass
                                        : isM3Style
                                          ? m3DarkTrackStateClass
                                          : classicTrackStateClass
                                }`}
                                title="點擊選取此曲目 (selectedTrack，支援 Ctrl 多選 / Shift 範圍選，不改變當前播放曲目)；可直接拖曳至右側畫布"
                            >
                                {track.coverUrl && (
                                    <img
                                        src={track.coverUrl}
                                        alt={track.title}
                                        referrerPolicy="no-referrer"
                                        className={`w-9 h-9 ${
                                            isM3Style ? 'rounded-lg' : 'rounded'
                                        } object-cover border border-slate-700/80 shrink-0 pointer-events-none`}
                                    />
                                )}
                                <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5 leading-tight">
                                    <div className="flex items-center gap-1.5 min-w-0">
                                        <span
                                            className={`text-xs leading-tight font-semibold truncate ${
                                                isSelected
                                                    ? isCafeMica
                                                        ? 'text-[#3d1f0d]'
                                                        : 'text-[#d3e3fd]'
                                                    : isActivePlaying
                                                      ? isCafeMica
                                                          ? 'text-[#163824]'
                                                          : 'text-[#a7f3d0]'
                                                      : 'text-slate-100'
                                            }`}
                                        >
                                            {track.title}
                                        </span>
                                        {isThisTrackMasterPlaying && (
                                            <span
                                                className={`px-1.5 py-0.2 rounded-full border text-[9px] font-mono font-bold shrink-0 ${
                                                    isCafeMica
                                                        ? 'bg-[#4e8763]/20 border-[#4e8763]/50 text-[#1b4a2e]'
                                                        : 'bg-[#4db6ac]/25 border-[#4db6ac]/50 text-[#80cbc4]'
                                                }`}
                                            >
                                                NOW
                                            </span>
                                        )}
                                    </div>
                                    <div className="text-[10px] leading-tight text-slate-400 truncate">
                                        {track.artist} • {track.album}
                                    </div>
                                    <div
                                        className={`text-[10px] leading-tight font-mono truncate ${
                                            isCafeMica
                                                ? 'text-[#a85d2e]'
                                                : isM3Style
                                                  ? 'text-[#8ab4f8]'
                                                  : 'text-cyan-300'
                                        }`}
                                    >
                                        {track.bpm} BPM • Key {track.key}
                                        {track.genre ? ` • ${track.genre}` : ''}
                                    </div>
                                </div>

                                {/* [試聽按鈕 + 2e 單曲移除 X 按鈕] */}
                                <div className="flex items-center gap-1 shrink-0">
                                    <button
                                        type="button"
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            setSelectedTrack(track);
                                            if (!selectedTrackIds.includes(track.id)) {
                                                toggleSelectTrack(track.id, false, track);
                                            }
                                            previewPlayTrack(track);
                                        }}
                                        className={`px-2 py-1 text-[10px] font-semibold rounded border transition shrink-0 cursor-pointer ${
                                            isThisTrackPreviewing
                                                ? 'bg-amber-500/20 hover:bg-amber-500/30 border-amber-500/60 text-amber-300'
                                                : 'bg-slate-800 hover:bg-cyan-600 border-slate-700 text-slate-200 hover:text-white'
                                        }`}
                                        title={
                                            isThisTrackPreviewing
                                                ? '點擊停止試聽此曲目（自動切回總時間軸當前曲目畫面）'
                                                : '點擊開始試聽此曲目（右側封面與波形同步顯示試聽曲目，不影響駱駝色輪的時間軸當前曲目）'
                                        }
                                    >
                                        {isThisTrackPreviewing ? '⏹ 停止' : '🎧 試聽'}
                                    </button>

                                    <button
                                        type="button"
                                        disabled={isLiveLocked}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            if (isThisTrackPreviewing) {
                                                previewPlayTrack(track);
                                            }
                                            removeTrackFromLibrary(track.id);
                                        }}
                                        className="w-6 h-6 rounded border border-slate-700/80 bg-slate-900/90 hover:bg-rose-600 hover:border-rose-500 text-slate-400 hover:text-white text-[10px] font-bold flex items-center justify-center transition disabled:opacity-40 cursor-pointer shrink-0"
                                        title="從當前智慧媒體庫清單中移除此曲目（點擊上方「💾 保存當前歌單」可將變更寫回 foobar2000 播放清單）"
                                    >
                                        ✕
                                    </button>
                                </div>
                            </div>
                        );
                    }

                    // [模式 B] 專輯分組檢視模式
                    const group = filteredAlbumGroups[virtualRow.index];
                    if (!group) return null;
                    const isGroupSelected = group.tracks.some((t) =>
                        selectedTrackIds.includes(t.id)
                    );

                    return (
                        <div
                            key={group.albumId}
                            style={{
                                position: 'absolute',
                                top: 0,
                                left: 0,
                                width: '100%',
                                height: `${virtualRow.size - 6}px`,
                                transform: `translateY(${virtualRow.start}px)`,
                            }}
                            draggable={!isLiveLocked}
                            onClick={() => {
                                if (group.tracks.length > 0) {
                                    toggleSelectTrack(
                                        group.tracks[0].id,
                                        false,
                                        group.tracks[0]
                                    );
                                }
                            }}
                            onDragStart={(e) => {
                                if (isLiveLocked) {
                                    e.preventDefault();
                                    return;
                                }
                                e.dataTransfer.effectAllowed = 'copy';
                                e.dataTransfer.setData(
                                    'application/x-foobar-dj-album',
                                    group.albumId
                                );
                            }}
                            className={`px-2.5 py-1.5 ${
                                isM3Style ? 'rounded-xl' : 'rounded-lg'
                            } border flex items-center gap-2.5 overflow-hidden transition ${
                                !isLiveLocked
                                    ? 'cursor-grab active:cursor-grabbing'
                                    : 'cursor-pointer'
                            } ${
                                isCafeMica
                                    ? isGroupSelected
                                        ? 'bg-[#f4dec8]/95 border-[#c87d4b] shadow-sm'
                                        : 'bg-[#fffaf4]/84 border-[#c49874]/30 hover:bg-[#f6eadc]/95 hover:border-[#c87d4b]/55'
                                    : isM3Style
                                      ? isGroupSelected
                                          ? 'bg-[#1e3252] border-[#8ab4f8] shadow-sm'
                                          : 'bg-[#131722] border-[#a8c7fa]/14 hover:bg-[#1d2332] hover:border-[#8ab4f8]/50'
                                      : 'bg-slate-950/70 border-slate-800 hover:border-indigo-500/60'
                            }`}
                            title="點擊選取專輯代表曲目 (selectedTrack)；可直接將整張專輯拖曳至右側畫布座標"
                        >
                            {group.coverUrl && (
                                <img
                                    src={group.coverUrl}
                                    alt={group.album}
                                    referrerPolicy="no-referrer"
                                    className={`w-10 h-10 ${
                                        isM3Style ? 'rounded-lg' : 'rounded'
                                    } object-cover border border-slate-700 shrink-0 pointer-events-none`}
                                />
                            )}
                            <div className="flex-1 min-w-0 flex flex-col justify-center gap-0.5 leading-tight">
                                <div className="text-xs leading-tight font-bold text-slate-100 truncate">
                                    💿 {group.album}
                                </div>
                                <div className="text-[10px] leading-tight text-slate-400 truncate">
                                    {group.artist} • {group.tracks.length} 首曲目
                                </div>
                                <div
                                    className={`text-[10px] leading-tight font-mono truncate ${
                                        isCafeMica
                                            ? 'text-[#a85d2e]'
                                            : isM3Style
                                              ? 'text-[#8ab4f8]'
                                              : 'text-indigo-300'
                                    }`}
                                >
                                    {group.entryBpm}BPM/{group.entryKey} →{' '}
                                    {group.exitBpm}BPM/{group.exitKey}
                                </div>
                            </div>
                            {!isLiveLocked && (
                                // 造成原錯誤的原因：+整張專輯 按鈕原先固定寫死為 bg-indigo-950 深紫黑底，未隨北歐燕麥奶淺色與 M3 深色主題切換配色。
                                // 本次修改的目的：針對 isCafeMica 套用暖焦糖拿鐵淺色膠囊、針對 isM3Style 套用 M3 藍紫 Tonal 膠囊配色。
                                <button
                                    onClick={(e) => {
                                        e.stopPropagation();
                                        addAlbumGroupToCanvas(group);
                                    }}
                                    className={`px-2.5 py-1 text-[10px] font-semibold border transition shrink-0 cursor-pointer ${
                                        isM3Style ? 'rounded-full' : 'rounded'
                                    } ${
                                        isCafeMica
                                            ? 'bg-[#f3dfc9] hover:bg-[#c87d4b] border-[#c87d4b]/65 text-[#6e3410] hover:text-white shadow-xs'
                                            : isM3Style
                                              ? 'bg-[#26334d] hover:bg-[#8ab4f8] border-[#8ab4f8]/45 text-[#d3e3fd] hover:text-[#081c36]'
                                              : 'bg-indigo-950 hover:bg-indigo-600 border-indigo-700/70 text-indigo-200 hover:text-white'
                                    }`}
                                >
                                    +整張專輯
                                </button>
                            )}
                        </div>
                    );
                })}
            </div>
        </div>
    );
}


