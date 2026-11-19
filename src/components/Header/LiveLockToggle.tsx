import { usePlayerStore } from '../../store/usePlayerStore';

// ============================================================================
// [組件] LiveLockToggle：演出鎖定模式 (Performance Mode) 開關 (規格書 2.1)
// ============================================================================
export function LiveLockToggle() {
    const isLiveLocked = usePlayerStore((s) => s.isLiveLocked);
    const toggleLiveLock = usePlayerStore((s) => s.toggleLiveLock);

    return (
        <button
            onClick={toggleLiveLock}
            className={`px-3 py-1.5 text-xs font-bold rounded-lg border transition cursor-pointer ${isLiveLocked
                    ? 'bg-amber-950 border-amber-600 text-amber-400 animate-pulse'
                    : 'bg-slate-800 border-slate-700 text-slate-300 hover:bg-slate-700'
                }`}
        >
            {isLiveLocked ? '🔒 演出鎖定中 (Live Lock)' : '🔓 自由編輯模式'}
        </button>
    );
}
