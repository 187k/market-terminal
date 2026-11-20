/** One tile of a treemap, in the coordinate space passed to `squarify`. */
export interface TreemapRect<T> {
  x: number;
  y: number;
  w: number;
  h: number;
  data: T;
}

/** Worst aspect ratio of a row of areas laid along a side of length `side`. */
function worst(row: number[], side: number): number {
  let sum = 0;
  let max = -Infinity;
  let min = Infinity;
  for (const a of row) {
    sum += a;
    if (a > max) max = a;
    if (a < min) min = a;
  }
  return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
}

/**
 * Squarified treemap (Bruls, Huizing, van Wijk): tiles with areas proportional to `value`,
 * largest first, filling `width × height` with tiles as close to square as the values allow.
 * Items with a value that is not a positive number are left out.
 */
export function squarify<T>(
  items: { value: number; data: T }[],
  width: number,
  height: number,
): TreemapRect<T>[] {
  const sorted = items
    .filter((i) => Number.isFinite(i.value) && i.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = sorted.reduce((s, i) => s + i.value, 0);
  if (total <= 0 || width <= 0 || height <= 0) return [];
  const scale = (width * height) / total;
  const areas = sorted.map((i) => i.value * scale);
  const out: TreemapRect<T>[] = [];
  let x = 0;
  let y = 0;
  let w = width;
  let h = height;
  let i = 0;
  while (i < areas.length) {
    const side = Math.min(w, h);
    const row = [areas[i]!];
    let j = i + 1;
    while (j < areas.length && worst([...row, areas[j]!], side) <= worst(row, side)) row.push(areas[j++]!);
    const rowSum = row.reduce((s, a) => s + a, 0);
    if (w >= h) {
      // A column along the left edge.
      const colW = rowSum / h;
      let yy = y;
      row.forEach((a, k) => {
        const th = a / colW;
        out.push({ x, y: yy, w: colW, h: th, data: sorted[i + k]!.data });
        yy += th;
      });
      x += colW;
      w -= colW;
    } else {
      // A row along the top edge.
      const rowH = rowSum / w;
      let xx = x;
      row.forEach((a, k) => {
        const tw = a / rowH;
        out.push({ x: xx, y, w: tw, h: rowH, data: sorted[i + k]!.data });
        xx += tw;
      });
      y += rowH;
      h -= rowH;
    }
    i = j;
  }
  return out;
}
