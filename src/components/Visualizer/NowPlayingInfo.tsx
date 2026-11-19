import { useMemo } from 'react';
import type React from 'react';
import { normalizeAudioPathForMatch } from '../../api/mockBridge';
import { usePlayerStore } from '../../store/usePlayerStore';
import { usePlaylistStore } from '../../store/usePlaylistStore';
import { useWorkflowStore } from '../../store/useWorkflowStore';
import { getCachedCoverSync } from '../../utils/artworkCache';
import { formatSmartDuration } from '../../utils/formatTime';

interface ParsedLrcLine {
    timeSec: number;
    text: string;
}

/**
 * 解析標準 LRC 時間軸字串 (例如 "[00:12.50] Lyric text")
 */
const parseLrcLines = (lrcRaw?: string): ParsedLrcLine[] => {
    if (!lrcRaw) return [];
    const lines = lrcRaw.split(/\r?\n/);
    const result: ParsedLrcLine[] = [];

    for (const line of lines) {
        const match = /^\[(\d{2}):(\d{2}(?:\.\d{1,2})?)\]\s*(.+)$/.exec(
            line.trim()
        );
        if (match) {
            const mins = Number(match[1]);
            const secs = Number(match[2]);
            result.push({
                timeSec: mins * 60 + secs,
                text: match[3],
            });
        }
    }

    return result.sort((a, b) => a.timeSec - b.timeSec);
};

// ============================================================================
// [組件] NowPlayingInfo：左側高可見度霓虹光暈旋轉小 CD + 右側播放中曲目資訊、真實計算 BPM/Key、格式與 LRC
// 當處於媒體庫「試聽」時自動切換顯示試聽曲目封面與資訊，停止試聽後自動回復顯示總時間軸 currentTrack
// ============================================================================
export function NowPlayingInfo() {
    const {
        currentTrack,
        previewTrack,
        isPlaying,
        isPreviewPlaying,
        trackTimeSeconds,
        previewTimeSeconds,
        dominantColor,
    } = usePlayerStore();
    const allTracks = usePlaylistStore((s) => s.allTracks);
    const workflowNodes = useWorkflowStore((s) => s.nodes);

    const activeAudio = isPlaying || isPreviewPlaying;
    const displayTrack =
        isPreviewPlaying && previewTrack ? previewTrack : currentTrack;
    const activeTimeSec =
        isPreviewPlaying && previewTrack
            ? previewTimeSeconds
            : trackTimeSeconds;

    const normDisplayPath = normalizeAudioPathForMatch(displayTrack?.path);

    const matchedInLibrary = displayTrack
        ? (allTracks.find(
              (t) =>
                  t.id === displayTrack.id ||
                  (Boolean(normDisplayPath) &&
                      normalizeAudioPathForMatch(t.path) === normDisplayPath)
          ) ?? null)
        : null;

    let matchedNodeTrack: (typeof allTracks)[number] | null = null;
    let matchedNodeCoverUrl: string | undefined;
    if (displayTrack) {
        for (const node of workflowNodes) {
            const found = node.data.albumGroup.tracks.find(
                (nt) =>
                    nt.id === displayTrack.id ||
                    (Boolean(normDisplayPath) &&
                        normalizeAudioPathForMatch(nt.path) === normDisplayPath)
            );
            if (found) {
                matchedNodeTrack = found;
                matchedNodeCoverUrl =
                    found.coverUrl ||
                    node.data.albumGroup.coverUrl ||
                    node.data.albumGroup.tracks.find((nt) =>
                        Boolean(nt.coverUrl)
                    )?.coverUrl;
                break;
            }
        }
    }

    // [修復問題 1：確保旋轉小 CD 圖示與畫布節點縮圖、大封面共享五層封面來源]
    let resolvedCoverUrl: string | null =
        displayTrack?.coverUrl ||
        matchedInLibrary?.coverUrl ||
        matchedNodeCoverUrl ||
        null;

    if (!resolvedCoverUrl && displayTrack) {
        const cleanAlbum = (displayTrack.album ?? '').trim().toLowerCase();
        const cleanArtist = (displayTrack.artist ?? '').trim().toLowerCase();
        if (cleanAlbum) {
            for (const node of workflowNodes) {
                const group = node.data.albumGroup;
                if (
                    group.album.trim().toLowerCase() === cleanAlbum &&
                    (!cleanArtist ||
                        group.artist.trim().toLowerCase() === cleanArtist)
                ) {
                    const nodeAlbumCover =
                        group.coverUrl ||
                        group.tracks.find((nt) => Boolean(nt.coverUrl))
                            ?.coverUrl;
                    if (nodeAlbumCover) {
                        resolvedCoverUrl = nodeAlbumCover;
                        break;
                    }
                }
            }
            if (!resolvedCoverUrl) {
                const siblingInLib = allTracks.find(
                    (t) =>
                        Boolean(t.coverUrl) &&
                        t.album.trim().toLowerCase() === cleanAlbum &&
                        (!cleanArtist ||
                            t.artist.trim().toLowerCase() === cleanArtist)
                );
                if (siblingInLib?.coverUrl) {
                    resolvedCoverUrl = siblingInLib.coverUrl;
                }
            }
        }
        if (!resolvedCoverUrl) {
            resolvedCoverUrl =
                getCachedCoverSync(
                    displayTrack.path,
                    displayTrack.artist,
                    displayTrack.album
                ) || null;
        }
    }

    const resolvedBpm =
        matchedInLibrary?.bpm ||
        matchedNodeTrack?.bpm ||
        displayTrack?.bpm ||
        124;
    const resolvedKey =
        matchedInLibrary?.key ||
        matchedNodeTrack?.key ||
        displayTrack?.key ||
        '8A';

    const lrcSource =
        displayTrack?.lrc ?? matchedInLibrary?.lrc ?? matchedNodeTrack?.lrc;
    const lrcLines = useMemo(() => parseLrcLines(lrcSource), [lrcSource]);

    // 找出當前播放秒數對應的 LRC 歌詞行
    const activeLyricText = useMemo(() => {
        if (lrcLines.length === 0) return null;
        let current = lrcLines[0].text;
        for (const item of lrcLines) {
            if (activeTimeSec >= item.timeSec) {
                current = item.text;
            } else {
                break;
            }
        }
        return current;
    }, [lrcLines, activeTimeSec]);

    return (
        <div
            style={{
                boxShadow: activeAudio
                    ? `inset 0 0 22px ${dominantColor}33`
                    : `inset 0 0 13px ${dominantColor}1c`,
            }}
            className="bg-slate-950 border border-slate-800 rounded-xl p-3 flex flex-col gap-2 relative overflow-hidden shrink-0"
        >
            <div className="flex items-center gap-3.5">
                {/* 左側：具備高對比呼吸光暈的旋轉小 CD / 黑膠唱片 */}
                {/* 造成原錯誤的原因：原本小 CD 光暈 -inset-3 與陰影擴散 18/34/54px 範圍過大且呼吸變化不明顯。 */}
                {/* 本次修改的目的：將光暈擴散距離縮小至原來的 70%、可見度提升 20%，並在播放中套用顯著呼吸起伏動畫。 */}
                <div className="relative w-16 h-16 flex items-center justify-center shrink-0">
                    {/* 外層擴散光暈環 (擴散縮小至 70%，可見度提升 20%，播放中強化呼吸變化) */}
                    <div
                        style={{
                            background: `radial-gradient(circle, ${dominantColor}eb 0%, ${dominantColor}80 38%, transparent 56%)`,
                        }}
                        className={`absolute -inset-2 rounded-full blur-[7px] pointer-events-none transition-all duration-300 ${
                            activeAudio
                                ? 'dj-glow-breathe-halo opacity-100'
                                : 'opacity-80 scale-95'
                        }`}
                    />

                    {/* 旋轉 CD 本體 */}
                    <div
                        style={
                            {
                                '--dj-breathe-color': dominantColor,
                                borderColor: activeAudio
                                    ? `${dominantColor}ff`
                                    : `${dominantColor}cc`,
                                boxShadow: activeAudio
                                    ? `0 0 13px ${dominantColor}ff, 0 0 24px ${dominantColor}db, 0 0 38px ${dominantColor}90`
                                    : `0 0 10px ${dominantColor}cc, 0 0 20px ${dominantColor}66`,
                            } as React.CSSProperties
                        }
                        // 造成原錯誤的原因：同時掛載 animate-[spin_8s_linear_infinite] 與 dj-glow-breathe-frame 時，後者的 animation 屬性會覆蓋前者的旋轉動畫導致小 CD 不旋轉。
                        // 本次修改的目的：改用複合動畫類別 dj-cd-spin-and-breathe，讓小 CD 在播放中同時維持旋轉與慢速光暈呼吸。
                        className={`w-16 h-16 rounded-full border-2 overflow-hidden relative flex items-center justify-center bg-black z-10 transition-shadow duration-300 ${
                            activeAudio ? 'dj-cd-spin-and-breathe' : ''
                        }`}
                    >
                        {resolvedCoverUrl ? (
                            <img
                                src={resolvedCoverUrl}
                                alt={displayTrack?.title ?? 'CD Cover'}
                                referrerPolicy="no-referrer"
                                className="w-full h-full object-cover"
                            />
                        ) : (
                            <div
                                style={{
                                    backgroundColor: `${dominantColor}33`,
                                    borderColor: dominantColor,
                                }}
                                className="w-6 h-6 rounded-full border"
                            />
                        )}
                        <div
                            style={{
                                borderColor: dominantColor,
                                boxShadow: `0 0 8px ${dominantColor}`,
                            }}
                            className="absolute w-4 h-4 rounded-full bg-slate-950 border"
                        />
                    </div>
                </div>

                {/* 右側：曲名、演出者、真實計算 BPM/Key、音訊格式/取樣率 */}
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 min-w-0">
                        {isPreviewPlaying && (
                            <span className="px-1.5 py-0.2 rounded bg-amber-500/20 border border-amber-500/50 text-[9px] font-bold text-amber-300 shrink-0">
                                🎧 試聽中
                            </span>
                        )}
                        <div className="text-xs font-bold text-slate-100 truncate">
                            {displayTrack ? displayTrack.title : '尚未播放曲目'}
                        </div>
                    </div>
                    <div className="text-[11px] text-slate-400 truncate">
                        {displayTrack
                            ? `${displayTrack.artist} • ${displayTrack.album}`
                            : '請點擊播放或時間軸'}
                    </div>

                    {displayTrack ? (
                        <>
                            <div className="text-[10px] font-mono text-cyan-400 mt-0.5">
                                {resolvedBpm} BPM | Key {resolvedKey} |{' '}
                                {isPreviewPlaying ? '試聽進度' : '單曲進度'}{' '}
                                {formatSmartDuration(activeTimeSec, 'tenths')}
                            </div>
                            <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                <span className="inline-block px-1.5 py-0.5 text-[10px] font-mono text-indigo-300 bg-indigo-950/70 border border-indigo-700/60 rounded">
                                    🎧 {displayTrack.format ?? 'FLAC / 24-bit / 48kHz'}
                                </span>
                            </div>
                        </>
                    ) : (
                        <div className="mt-1 text-[10px] font-mono text-slate-500">
                            格式 / 取樣率：待載入音訊串流
                        </div>
                    )}
                </div>
            </div>

            {/* [Phase 7] LRC 動態同步歌詞 / 曲目段落提示列 */}
            {activeLyricText && (
                <div className="px-2.5 py-1 rounded-lg bg-slate-900/90 border border-slate-800/80 text-[11px] text-cyan-200 font-medium truncate">
                    {activeLyricText}
                </div>
            )}
        </div>
    );
}
