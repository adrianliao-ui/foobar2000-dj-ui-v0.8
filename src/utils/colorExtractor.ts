// ============================================================================
// [工具模組] colorExtractor：專輯封面動態主色調萃取器與面板對比度視覺增強算法 (規格書 2.3 & Phase 7)
// 透過離屏 HTML5 Canvas 進行 12 色相分桶 (Hue Clustering) 取樣，並結合當前面板主題背景色計算色差與對比度，
// 自動規避與面板底色過於相近的顏色，挑選並強化出視覺效果最佳的主色調。
// ============================================================================

const DEFAULT_NEON_COLOR = '#06b6d4';

// 各面板主題於右側視覺監控區的代表背景色 (RGB)
const THEME_SURFACE_RGB: Record<string, [number, number, number]> = {
    'm3-dark': [18, 22, 32],        // #121620
    'm3-cafe-mica': [244, 234, 222], // #f4eade (淺色燕麥奶次容器)
    'classic-neon': [2, 6, 23],      // #020617
    'amoled-stage': [4, 5, 8],       // #040508
};

/**
 * 將 RGB (0~255) 轉換為 Hex 字串 (#rrggbb)
 */
const rgbToHex = (r: number, g: number, b: number): string => {
    const toHex = (n: number) =>
        Math.max(0, Math.min(255, Math.round(n)))
            .toString(16)
            .padStart(2, '0');
    return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
};

/**
 * RGB (0~255) 轉 HSL (h: 0~360, s: 0~1, l: 0~1)
 */
const rgbToHsl = (
    r: number,
    g: number,
    b: number
): { h: number; s: number; l: number } => {
    const rn = r / 255;
    const gn = g / 255;
    const bn = b / 255;
    const max = Math.max(rn, gn, bn);
    const min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;

    if (max !== min) {
        const d = max - min;
        s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
        switch (max) {
            case rn:
                h = (gn - bn) / d + (gn < bn ? 6 : 0);
                break;
            case gn:
                h = (bn - rn) / d + 2;
                break;
            default:
                h = (rn - gn) / d + 4;
                break;
        }
        h *= 60;
    }
    return { h, s, l };
};

/**
 * HSL (h: 0~360, s: 0~1, l: 0~1) 轉 RGB (0~255)
 */
const hslToRgb = (h: number, s: number, l: number): [number, number, number] => {
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const hp = (((h % 360) + 360) % 360) / 60;
    const x = c * (1 - Math.abs((hp % 2) - 1));
    let r1: number;
    let g1: number;
    let b1: number;

    if (hp >= 0 && hp < 1) [r1, g1, b1] = [c, x, 0];
    else if (hp < 2) [r1, g1, b1] = [x, c, 0];
    else if (hp < 3) [r1, g1, b1] = [0, c, x];
    else if (hp < 4) [r1, g1, b1] = [0, x, c];
    else if (hp < 5) [r1, g1, b1] = [x, 0, c];
    else [r1, g1, b1] = [c, 0, x];

    const m = l - c / 2;
    return [
        Math.round((r1 + m) * 255),
        Math.round((g1 + m) * 255),
        Math.round((b1 + m) * 255),
    ];
};

/**
 * 計算兩個 RGB 顏色之間的加權歐氏感知色差 (Redmean Color Distance, 0 ~ 765)
 */
const computeColorDistance = (
    c1: [number, number, number],
    c2: [number, number, number]
): number => {
    const rmean = (c1[0] + c2[0]) / 2;
    const dr = c1[0] - c2[0];
    const dg = c1[1] - c2[1];
    const db = c1[2] - c2[2];
    return Math.sqrt(
        (2 + rmean / 256) * dr * dr +
            4 * dg * dg +
            (2 + (255 - rmean) / 256) * db * db
    );
};

/**
 * 讀取當前 DOM 套用的面板主題 ID
 */
const getCurrentActiveThemeId = (): string => {
    if (typeof document !== 'undefined' && document.documentElement) {
        return document.documentElement.getAttribute('data-theme') || 'm3-dark';
    }
    return 'm3-dark';
};

/**
 * 造成原錯誤的原因：單純加權平均或 Color-Thief 取出的主色可能與當前面板底色太接近（如深藍灰撞色或淺米杏色撞色），導致光暈融入背景看不清楚。
 * 本次修改的目的：針對候選 RGB 與當前面板背景色計算感知色差，並在 HSL 空間自動強化飽和度與修正明度區間，確保在深色與淺色面板上皆具備高對比視覺張力。
 */
export const refineColorForThemeContrast = (
    r: number,
    g: number,
    b: number,
    themeId = getCurrentActiveThemeId()
): string => {
    const bgRgb = THEME_SURFACE_RGB[themeId] ?? THEME_SURFACE_RGB['m3-dark'];
    const isLightTheme = themeId === 'm3-cafe-mica';

    let { h, s, l } = rgbToHsl(r, g, b);

    // 1. 提升飽和度以保證光暈鮮明不灰暗
    s = Math.max(isLightTheme ? 0.76 : 0.80, Math.min(0.98, s * 1.18));

    // 2. 根據深/淺面板強制拉開明度對比區間
    if (isLightTheme) {
        // 淺色燕麥奶面板 (#f4eade)：將光暈色控制在濃郁高彩的中深明度 (0.42 ~ 0.56)
        l = Math.max(0.42, Math.min(0.56, l));
    } else {
        // 深色面板 (#121620 / #020617)：將光暈色控制在清澈透亮的高明度 (0.58 ~ 0.72)
        l = Math.max(0.58, Math.min(0.72, l));
    }

    let candidateRgb = hslToRgb(h, s, l);
    const dist = computeColorDistance(candidateRgb, bgRgb);

    // 3. 若調整明度後色相仍與面板底色太接近 (例如在燕麥奶面板抽到淺褐黃，或在深藍面板抽到暗藍)，自動旋轉色相 42 度並拉高飽和度跳脫背景
    if (dist < 185) {
        h = (h + (isLightTheme ? 155 : 42)) % 360;
        s = Math.max(0.85, s);
        l = isLightTheme ? 0.48 : 0.65;
        candidateRgb = hslToRgb(h, s, l);
    }

    return rgbToHex(candidateRgb[0], candidateRgb[1], candidateRgb[2]);
};

/**
 * 從圖片 URL 萃取與當前面板主題對比最佳、視覺效果最好的高飽和主色調 (Hex)
 */
export const extractDominantColorFromUrl = (
    imageUrl?: string,
    themeId?: string
): Promise<string> => {
    const activeTheme = themeId ?? getCurrentActiveThemeId();
    if (!imageUrl || typeof document === 'undefined') {
        return Promise.resolve(
            activeTheme === 'm3-cafe-mica' ? '#d97706' : DEFAULT_NEON_COLOR
        );
    }

    return new Promise((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.referrerPolicy = 'no-referrer';

        img.onload = () => {
            try {
                const sampleSize = 36;
                const canvas = document.createElement('canvas');
                canvas.width = sampleSize;
                canvas.height = sampleSize;
                const ctx = canvas.getContext('2d');

                if (!ctx) {
                    resolve(DEFAULT_NEON_COLOR);
                    return;
                }

                ctx.drawImage(img, 0, 0, sampleSize, sampleSize);
                const { data } = ctx.getImageData(0, 0, sampleSize, sampleSize);

                const bgRgb =
                    THEME_SURFACE_RGB[activeTheme] ??
                    THEME_SURFACE_RGB['m3-dark'];

                // 建立 12 個色相分桶 (每 30 度一桶)，避免不同色系的鮮豔像素直接平均後抵銷成灰褐色
                const buckets = Array.from({ length: 12 }, () => ({
                    rSum: 0,
                    gSum: 0,
                    bSum: 0,
                    weightSum: 0,
                    count: 0,
                }));

                for (let i = 0; i < data.length; i += 4) {
                    const r = data[i];
                    const g = data[i + 1];
                    const b = data[i + 2];
                    const a = data[i + 3];

                    if (a < 128) continue;

                    const max = Math.max(r, g, b);
                    const min = Math.min(r, g, b);
                    const lightness = (max + min) / 2;
                    const chroma = max - min;

                    // 過濾極端死黑 (< 28)、慘白 (> 242) 以及低彩度灰階像素 (chroma < 22)
                    if (lightness < 28 || lightness > 242 || chroma < 22) {
                        continue;
                    }

                    const { h, s } = rgbToHsl(r, g, b);
                    const bucketIdx = Math.floor(h / 30) % 12;
                    const distFromBg = computeColorDistance([r, g, b], bgRgb);

                    // 綜合權重：高彩度 + 高飽和度 + 與當前面板背景色距離越遠權重越高
                    const contrastBoost = Math.pow(
                        Math.max(0.2, distFromBg / 420),
                        1.4
                    );
                    const weight =
                        ((chroma / 255) * 2.2 + s * 1.5) * contrastBoost;

                    buckets[bucketIdx].rSum += r * weight;
                    buckets[bucketIdx].gSum += g * weight;
                    buckets[bucketIdx].bSum += b * weight;
                    buckets[bucketIdx].weightSum += weight;
                    buckets[bucketIdx].count += 1;
                }

                // 對每個有效色相桶計算「代表色 × 面板對比度綜合得分」，選出視覺效果最佳的色相桶
                let bestBucketScore = -1;
                let bestRgb: [number, number, number] | null = null;

                for (const b of buckets) {
                    if (b.weightSum <= 0 || b.count === 0) continue;
                    const avgR = b.rSum / b.weightSum;
                    const avgG = b.gSum / b.weightSum;
                    const avgB = b.bSum / b.weightSum;
                    const distToPanel = computeColorDistance(
                        [avgR, avgG, avgB],
                        bgRgb
                    );
                    const { s } = rgbToHsl(avgR, avgG, avgB);

                    // 評分公式：色桶累積權重 * 與當前面板色差加權 * 飽和度加權
                    const score =
                        Math.pow(b.weightSum, 0.65) *
                        (distToPanel / 255) *
                        (0.8 + s);
                    if (score > bestBucketScore) {
                        bestBucketScore = score;
                        bestRgb = [avgR, avgG, avgB];
                    }
                }

                if (!bestRgb) {
                    resolve(
                        activeTheme === 'm3-cafe-mica'
                            ? '#d97706'
                            : DEFAULT_NEON_COLOR
                    );
                    return;
                }

                resolve(
                    refineColorForThemeContrast(
                        bestRgb[0],
                        bestRgb[1],
                        bestRgb[2],
                        activeTheme
                    )
                );
            } catch {
                resolve(DEFAULT_NEON_COLOR);
            }
        };

        img.onerror = () => {
            resolve(DEFAULT_NEON_COLOR);
        };

        img.src = imageUrl;
    });
};
