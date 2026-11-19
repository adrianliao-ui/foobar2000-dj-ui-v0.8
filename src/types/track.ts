/**
 * 曲目微觀 Cue 點與循環次數設定
 */
export interface CuePoints {
    mixIn: number;       // 進歌點（秒）
    mixOut: number;      // 切歌點（秒）
    loopCount?: number;  // 區間循環播放次數（預設 1 次，>= 2 代表循環 [mixIn, mixOut] N 次後切下一首）
}

/**
 * 卡片內部相鄰曲目之間的過渡設定
 */
export interface InternalTransition {
    type: 'CROSSFADE' | 'CUT' | 'SILENCE';
    duration: number;
}

/**
 * 單曲與 Metadata 介面 (Track)
 */
export interface Track {
    id: string;
    albumId: string;
    title: string;
    artist: string;
    album: string;
    duration: number;
    bpm: number;
    key: string;
    genre?: string;
    rating?: number;
    path: string;
    coverUrl?: string;
    format?: string;
    lrc?: string;
    waveform?: number[];
    cuePoints: CuePoints;
    internalTransition?: InternalTransition; // 卡片內往下一首歌的過渡模式（預設 CUT 0s）
}

/**
 * 專輯群組資料結構 (AlbumGroup)
 */
export interface AlbumGroup {
    albumId: string;
    album: string;
    artist: string;
    coverUrl?: string;
    tracks: Track[];
    totalDuration: number;
    minBpm: number;
    maxBpm: number;
    entryBpm: number;
    exitBpm: number;
    entryKey: string;
    exitKey: string;
}