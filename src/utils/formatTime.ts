// ============================================================================
// [工具模組] formatTime：時間秒數格式化輔助函式 (規格書 7.1)
// ============================================================================

/**
 * 將秒數格式化為 mm:ss.d (例如 125.4 -> "02:05.4")
 */
export const formatSecondsToMmSsTenths = (seconds: number): string => {
    const safeSec = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    const mins = Math.floor(safeSec / 60);
    const remSec = safeSec - mins * 60;
    const mm = String(mins).padStart(2, '0');
    const ss = remSec.toFixed(1).padStart(4, '0');
    return `${mm}:${ss}`;
};

/**
 * 將秒數格式化為標準 mm:ss 或 hh:mm:ss
 */
export const formatSecondsToClock = (seconds: number): string => {
    const totalSec = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
    const hrs = Math.floor(totalSec / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;

    const mm = String(mins).padStart(2, '0');
    const ss = String(secs).padStart(2, '0');

    if (hrs > 0) {
        const hh = String(hrs).padStart(2, '0');
        return `${hh}:${mm}:${ss}`;
    }
    return `${mm}:${ss}`;
};

/**
 * [修復單曲時長整數截斷造成的系統性累積誤差]
 * 造成原錯誤的原因：先前對宿主 `%length_seconds_fp%` 執行整數 `Math.floor(sec)`，導致如 `260.85s` 被硬砍為 `260s`，
 *                   造成前台提早 0.85s 強制切歌（打斷 C++ 原生無縫換軌）以及背景最小化多曲累積數秒誤差。
 * 本次修改的目的：將曲目時長無條件捨去至 0.1 秒精度 (`Math.floor(sec * 10) / 10`)，兼顧不超過實體 EOF 與 100ms 內高精準度。
 */
export const floorDurationToTenth = (seconds: number): number => {
    if (!Number.isFinite(seconds) || seconds <= 0) return 1;
    return Math.max(1, Math.floor((seconds + 1e-6) * 10) / 10);
};

/**
 * [時間顯示格式升級] 將秒數格式化為智慧省略前導零單位之 `1h:10m:50s` / `10m:50s` / `45s` 格式
 * - mode = 'tenths'：強制保留 1 位小數（如 `2m:32.4s`、`4.5s`）
 * - mode = 'int'：四捨五入至整數秒（如 `1h:10m:50s`、`3m:22s`）
 * - mode = 'auto'：有小數時顯示 1 位小數，整數時省略小數（如 `4.5s`、`3m:22s`）
 */
export const formatSmartDuration = (
    seconds: number,
    mode: 'int' | 'tenths' | 'auto' = 'auto'
): string => {
    const safeSec = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    const totalTenths =
        mode === 'int' ? Math.round(safeSec) * 10 : Math.round(safeSec * 10);

    const hrs = Math.floor(totalTenths / 36000);
    const remAfterHrs = totalTenths - hrs * 36000;
    const mins = Math.floor(remAfterHrs / 600);
    const remTenths = remAfterHrs - mins * 600;
    const secInt = Math.floor(remTenths / 10);
    const tenthDigit = remTenths % 10;

    const showDecimal =
        mode === 'tenths' || (mode === 'auto' && tenthDigit !== 0);
    const hasUpperUnit = hrs > 0 || mins > 0;
    const secBase = hasUpperUnit
        ? String(secInt).padStart(2, '0')
        : String(secInt);
    const secPart = showDecimal ? `${secBase}.${tenthDigit}s` : `${secBase}s`;

    if (hrs > 0) {
        const minPart = `${String(mins).padStart(2, '0')}m`;
        return `${hrs}h:${minPart}:${secPart}`;
    }
    if (mins > 0) {
        return `${mins}m:${secPart}`;
    }
    return secPart;
};

