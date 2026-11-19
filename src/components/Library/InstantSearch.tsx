import { usePlaylistStore } from '../../store/usePlaylistStore';
import { isM3LayoutTheme, useThemeStore } from '../../store/useThemeStore';

// ============================================================================
// [組件] InstantSearch：媒體庫即時搜尋與 BPM / Key / Genre 多重過濾器 (規格書 2.2)
// ============================================================================
export function InstantSearch() {
    const {
        filter,
        availableKeys,
        availableGenres,
        viewMode,
        setSearchQuery,
        setBpmRange,
        setSelectedKey,
        setSelectedGenre,
        resetFilters,
        setViewMode,
    } = usePlaylistStore();

    const themeId = useThemeStore((s) => s.themeId);
    const isM3Style = isM3LayoutTheme(themeId);
    const isCafeMica = themeId === 'm3-cafe-mica';

    const hasActiveFilter =
        Boolean(filter.searchQuery.trim()) ||
        filter.minBpm !== null ||
        filter.maxBpm !== null ||
        filter.selectedKey !== null ||
        filter.selectedGenre !== null;

    // 造成原錯誤的原因：單曲/專輯外框與 BPM 篩選外框原先寫死為矩形 rounded / rounded-lg 與 bg-slate-900，在 M3 深色與北歐燕麥奶淺色主題下未呈現膠囊外框且殘留深色底。
    // 本次修改的目的：當啟用 M3 系列主題 (m3-dark / m3-cafe-mica) 時，統一套用 rounded-full 膠囊外框與對應主題底色，並修正搜尋框行高避免文字下緣裁切。
    return (
        <div
            className={`flex flex-col gap-2 border p-2.5 ${
                isCafeMica
                    ? 'bg-[#f7efe6]/85 border-[#c49874]/45 rounded-2xl'
                    : isM3Style
                      ? 'bg-[#171c26]/90 border-[#a8c7fa]/20 rounded-2xl'
                      : 'bg-slate-950/70 border-slate-800/90 rounded-lg'
            }`}
        >
            {/* [功能段落 1] 關鍵字搜尋框與單曲/專輯檢視模式切換 */}
            <div className="flex items-center gap-1.5">
                <input
                    type="text"
                    placeholder="搜尋曲名、演出者、專輯..."
                    value={filter.searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className={`flex-1 min-w-0 bg-slate-900 border border-slate-800 ${
                        isM3Style ? 'rounded-full px-3' : 'rounded-lg px-2.5'
                    } py-1.5 text-xs leading-normal text-slate-200 placeholder-slate-500 focus:outline-none focus:border-cyan-500`}
                />
                <div
                    className={`flex overflow-hidden border shrink-0 ${
                        isCafeMica
                            ? 'rounded-full p-0.5 gap-0.5 bg-[#efe3d5] border-[#c49874]/60'
                            : isM3Style
                              ? 'rounded-full p-0.5 gap-0.5 bg-[#1c2230] border-[#a8c7fa]/28'
                              : 'rounded-lg border-slate-800'
                    }`}
                >
                    <button
                        onClick={() => setViewMode('tracks')}
                        className={`px-2.5 py-1 text-[10px] font-semibold transition cursor-pointer ${
                            viewMode === 'tracks'
                                ? 'bg-cyan-600 text-white'
                                : isCafeMica
                                  ? 'bg-transparent text-[#5c4030] hover:text-[#2b1e17]'
                                  : 'bg-slate-900 text-slate-400 hover:text-slate-200'
                        }`}
                        title="單曲檢視模式"
                    >
                        單曲
                    </button>
                    <button
                        onClick={() => setViewMode('albums')}
                        className={`px-2.5 py-1 text-[10px] font-semibold transition cursor-pointer ${
                            viewMode === 'albums'
                                ? 'bg-cyan-600 text-white'
                                : isCafeMica
                                  ? 'bg-transparent text-[#5c4030] hover:text-[#2b1e17]'
                                  : 'bg-slate-900 text-slate-400 hover:text-slate-200'
                        }`}
                        title="專輯分組檢視模式"
                    >
                        專輯
                    </button>
                </div>
            </div>

            {/* [功能段落 2] BPM 範圍、Camelot Key 調性與 Genre 曲風篩選列 */}
            <div className="grid grid-cols-2 gap-1.5">
                {/* BPM 範圍輸入 (M3 主題下套用膠囊外框 rounded-full) */}
                <div
                    className={`flex items-center gap-1 border px-3 py-1 ${
                        isCafeMica
                            ? 'rounded-full bg-[#fffaf4] border-[#c49874]/60'
                            : isM3Style
                              ? 'rounded-full bg-[#1c2230] border-[#a8c7fa]/25'
                              : 'rounded bg-slate-900 border-slate-800 px-2'
                    }`}
                >
                    <span
                        className={`text-[10px] font-mono shrink-0 ${
                            isCafeMica
                                ? 'text-[#6e4f3d] font-bold'
                                : 'text-slate-400'
                        }`}
                    >
                        BPM
                    </span>
                    <input
                        type="number"
                        placeholder="Min"
                        value={filter.minBpm ?? ''}
                        onChange={(e) => {
                            const val = e.target.value ? Number(e.target.value) : null;
                            setBpmRange(val, filter.maxBpm);
                        }}
                        className={`w-full min-w-0 bg-transparent text-[11px] leading-normal font-mono focus:outline-none text-center ${
                            isCafeMica
                                ? 'text-[#8c461c] placeholder-[#9c8270] font-bold'
                                : 'text-cyan-300 placeholder-slate-500'
                        }`}
                    />
                    <span
                        className={`text-[10px] ${
                            isCafeMica ? 'text-[#8c6d58]' : 'text-slate-500'
                        }`}
                    >
                        ~
                    </span>
                    <input
                        type="number"
                        placeholder="Max"
                        value={filter.maxBpm ?? ''}
                        onChange={(e) => {
                            const val = e.target.value ? Number(e.target.value) : null;
                            setBpmRange(filter.minBpm, val);
                        }}
                        className={`w-full min-w-0 bg-transparent text-[11px] leading-normal font-mono focus:outline-none text-center ${
                            isCafeMica
                                ? 'text-[#8c461c] placeholder-[#9c8270] font-bold'
                                : 'text-cyan-300 placeholder-slate-500'
                        }`}
                    />
                </div>

                {/* Camelot Key 調性下拉選單 */}
                <select
                    value={filter.selectedKey ?? ''}
                    onChange={(e) =>
                        setSelectedKey(e.target.value ? e.target.value : null)
                    }
                    className={`bg-slate-900 border border-slate-800 ${
                        isM3Style ? 'rounded-full px-3' : 'rounded px-2'
                    } py-1 text-[11px] leading-normal text-slate-200 focus:outline-none focus:border-cyan-500 cursor-pointer`}
                >
                    <option value="">所有調性 (Key)</option>
                    {availableKeys.map((k) => (
                        <option key={k} value={k}>
                            Key {k}
                        </option>
                    ))}
                </select>
            </div>

            {/* [功能段落 3] Genre 曲風下拉選單與重置篩選按鈕 */}
            <div className="flex items-center gap-1.5">
                <select
                    value={filter.selectedGenre ?? ''}
                    onChange={(e) =>
                        setSelectedGenre(e.target.value ? e.target.value : null)
                    }
                    className={`flex-1 min-w-0 bg-slate-900 border border-slate-800 ${
                        isM3Style ? 'rounded-full px-3' : 'rounded px-2'
                    } py-1 text-[11px] leading-normal text-slate-200 focus:outline-none focus:border-cyan-500 cursor-pointer`}
                >
                    <option value="">所有曲風 (Genre)</option>
                    {availableGenres.map((genre) => (
                        <option key={genre} value={genre}>
                            {genre}
                        </option>
                    ))}
                </select>

                {hasActiveFilter && (
                    <button
                        onClick={resetFilters}
                        className="px-2.5 py-1 text-[10px] font-semibold bg-rose-950/70 hover:bg-rose-900 text-rose-300 border border-rose-800/70 rounded transition shrink-0 cursor-pointer"
                        title="清除所有篩選條件"
                    >
                        重置
                    </button>
                )}
            </div>
        </div>
    );
}
