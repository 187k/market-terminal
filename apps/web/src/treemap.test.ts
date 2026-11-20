import { describe, expect, it } from 'vitest';
import { squarify } from './treemap';

const W = 1000;
const H = 400;

describe('squarify', () => {
  const items = [500, 200, 120, 80, 50, 30, 10, 6, 3, 1].map((value, i) => ({ value, data: `c${i}` }));
  const rects = squarify(items, W, H);

  it('gives every item a tile with an area proportional to its value', () => {
    expect(rects).toHaveLength(items.length);
    const total = items.reduce((s, i) => s + i.value, 0);
    for (const r of rects) {
      const item = items.find((i) => i.data === r.data)!;
      expect(r.w * r.h).toBeCloseTo((item.value / total) * W * H, 6);
    }
  });

  it('keeps tiles inside the area and never overlapping', () => {
    const eps = 1e-6;
    for (const r of rects) {
      expect(r.x).toBeGreaterThanOrEqual(-eps);
      expect(r.y).toBeGreaterThanOrEqual(-eps);
      expect(r.x + r.w).toBeLessThanOrEqual(W + eps);
      expect(r.y + r.h).toBeLessThanOrEqual(H + eps);
    }
    for (let a = 0; a < rects.length; a++)
      for (let b = a + 1; b < rects.length; b++) {
        const p = rects[a]!;
        const q = rects[b]!;
        const overlapX = Math.min(p.x + p.w, q.x + q.w) - Math.max(p.x, q.x);
        const overlapY = Math.min(p.y + p.h, q.y + q.h) - Math.max(p.y, q.y);
        expect(overlapX <= eps || overlapY <= eps).toBe(true);
      }
  });

  it('places the largest item first', () => {
    expect(rects[0]?.data).toBe('c0');
    expect(rects[0]).toMatchObject({ x: 0, y: 0 });
  });

  it('leaves out items without a positive value', () => {
    expect(
      squarify(
        [
          { value: 0, data: 'zero' },
          { value: Number.NaN, data: 'nan' },
          { value: 3, data: 'ok' },
        ],
        10,
        10,
      ).map((r) => r.data),
    ).toEqual(['ok']);
    expect(squarify([], 10, 10)).toEqual([]);
    expect(squarify([{ value: 1, data: 'x' }], 0, 10)).toEqual([]);
  });
});
