// Arrow frame, metrics, head and shaft geometry.
// Copyright (c) 2025 JYAARU, MIT; see src-tauri/crates/hdrcapture/LICENSE.
// Canvas has no QPainterPath.united: flatten only for the polygon union, to a
// maximum 0.04 physical-pixel curve error. No change to the upstream geometry.
import polygonClipping from 'polygon-clipping'
import type { Mark, Point, Rect } from './model'
type Head = 'none' | 'swept' | 'open' | 'solid' | 'bar' | 'bar_solid'
const specs: Record<string, ['taper' | 'even' | 'line', Head, Head]> = {
  single: ['taper', 'none', 'swept'], double: ['even', 'swept', 'swept'], hollow: ['taper', 'none', 'swept'],
  line: ['line', 'none', 'open'], line_double: ['line', 'open', 'open'], triangle: ['line', 'none', 'solid'],
  triangle_double: ['line', 'solid', 'solid'], bar: ['line', 'bar', 'bar'], bar_arrow: ['line', 'bar_solid', 'bar_solid'],
}
const add = (p: Point, v: Point, scale = 1): Point => ({ x: p.x + v.x * scale, y: p.y + v.y * scale })
const sub = (a: Point, b: Point): Point => ({ x: a.x - b.x, y: a.y - b.y })
const perp = (p: Point): Point => ({ x: -p.y, y: p.x })
const norm = (p: Point) => Math.hypot(p.x, p.y)
const unit = (p: Point, fallback: Point): Point => { const v = norm(p) > 1e-6 ? p : fallback; return norm(v) > 1e-6 ? { x: v.x / norm(v), y: v.y / norm(v) } : { x: 1, y: 0 } }
const middle = (a: Point, b: Point) => add(a, sub(b, a), 0.5)
function quadratic(a: Point, c: Point, b: Point, output: Point[], depth = 0) {
  if (depth >= 16 || norm(sub(c, middle(a, b))) <= 0.08) { output.push(b); return }
  const ac = middle(a, c), cb = middle(c, b), mid = middle(ac, cb)
  quadratic(a, ac, mid, output, depth + 1); quadratic(mid, cb, b, output, depth + 1)
}
export type ArrowGeometry = { rings: Point[][]; bounds: Rect; outline: number }
const cache = new WeakMap<Mark, { key: string; geometry: ArrowGeometry }>()
export function arrowGeometry(mark: Mark): ArrowGeometry {
  const key = JSON.stringify([mark.points, mark.style.width, mark.style.arrow]), previous = cache.get(mark)
  if (previous?.key === key) return previous.geometry
  const [start, end] = mark.points, mid = mark.points[2] ?? middle(start, end)
  const bezier = sub(add(mid, mid), middle(start, end)), chord = sub(end, start)
  const vs = sub(bezier, start), ve = sub(end, bezier), us = unit(vs, chord), ue = unit(ve, chord)
  const length = Math.max(norm(vs) + norm(ve), norm(chord)), base = Math.max(1, mark.style.width)
  const [shaft, hs, he] = specs[mark.style.arrow] ?? ['taper', 'none', 'swept']
  let headHalf = Math.max(base * 2.2, 8), headLength = headHalf * 1.75
  const heads = [hs, he], swept = heads.filter(h => h === 'swept').length, solid = heads.filter(h => h === 'solid' || h === 'bar_solid').length
  if (solid || swept) {
    const budget = length * (solid + swept === 1 ? 0.45 : 0.34), reach = Math.max(headLength, swept ? headHalf * 1.96 : 0)
    if (reach > budget) { headHalf *= budget / reach; headLength *= budget / reach }
  }
  const lineWidth = Math.max(base * 0.9, 2), openHeads = heads.filter(h => h === 'open').length, angle = 27 * Math.PI / 180
  const wingLength = Math.min(Math.max(base * 4.2, 15), openHeads ? length * (openHeads === 1 ? 0.45 : 0.35) : Infinity)
  const wingWidth = Math.min(lineWidth, wingLength * Math.tan(angle) * 0.9), notch = wingWidth / Math.sin(angle)
  const sweepLength = headHalf * 1.62, sweepDepth = headHalf * 1.96, neckHalf = headHalf * 0.4, barHalf = Math.max(base * 2, 8)
  const pieces: Point[][] = []
  const trim = (h: Head) => h === 'solid' ? headLength * 0.92 : h === 'swept' ? sweepLength * 0.92 : h === 'bar_solid' ? lineWidth * 0.5 + headLength * 0.8 * 0.92 : h === 'open' ? Math.min(lineWidth * 1.4, notch) : 0
  const ts = trim(hs), te = trim(he), a = add(start, us, ts), b = add(end, ue, -te)
  if (length - ts - te > 0.5) {
    const ab = sub(b, a), squared = ab.x * ab.x + ab.y * ab.y
    if (squared >= 1e-6) {
      const wa = shaft === 'line' ? lineWidth : shaft === 'even' || hs !== 'none' ? neckHalf * 2 : 0
      const wb = shaft === 'line' ? lineWidth : shaft === 'even' || he !== 'none' ? neckHalf * 2 : 0
      const am = sub(mid, a), t = Math.max(0, Math.min(1, (am.x * ab.x + am.y * ab.y) / squared)), wm = wa + (wb - wa) * t
      const edge = (sign: number) => {
        const pa = add(a, perp(us), sign * wa / 2), pb = add(b, perp(ue), sign * wb / 2), pm = add(mid, perp(unit(chord, ab)), sign * wm / 2)
        return [pa, sub(add(pm, pm), middle(pa, pb)), pb] as const
      }
      const [ua, uc, ub] = edge(1), [da, dc, db] = edge(-1), ring = [ua]
      quadratic(ua, uc, ub, ring); ring.push(db); quadratic(db, dc, da, ring); pieces.push(ring)
    }
  }
  const triangle = (tip: Point, direction: Point, len: number, half: number) => { const neck = add(tip, direction, -len), n = perp(direction); pieces.push([tip, add(neck, n, half), add(neck, n, -half)]) }
  const head = (kind: Head, tip: Point, direction: Point) => {
    const n = perp(direction)
    if (kind === 'solid') triangle(tip, direction, headLength, headHalf)
    if (kind === 'swept') {
      const neck = add(tip, direction, -sweepLength), barb = add(tip, direction, -sweepDepth)
      pieces.push([add(neck, n, neckHalf), add(barb, n, headHalf), tip, add(barb, n, -headHalf), add(neck, n, -neckHalf)])
    }
    if (kind === 'open') {
      const back = { x: -direction.x, y: -direction.y }, ca = Math.cos(angle), sa = Math.sin(angle)
      const left = { x: back.x * ca - back.y * sa, y: back.x * sa + back.y * ca }, right = { x: back.x * ca + back.y * sa, y: -back.x * sa + back.y * ca }
      const outerLeft = add(tip, left, wingLength), outerRight = add(tip, right, wingLength)
      pieces.push([tip, outerLeft, add(outerLeft, perp(left), -wingWidth), add(tip, back, notch), add(outerRight, perp(right), wingWidth), outerRight])
    }
    if (kind === 'bar' || kind === 'bar_solid') {
      pieces.push([add(add(tip, n, barHalf), direction, lineWidth / 2), add(add(tip, n, -barHalf), direction, lineWidth / 2), add(add(tip, n, -barHalf), direction, -lineWidth / 2), add(add(tip, n, barHalf), direction, -lineWidth / 2)])
      if (kind === 'bar_solid') triangle(add(tip, direction, -lineWidth / 2), direction, headLength * 0.8, headHalf * 0.8)
    }
  }
  head(hs, start, { x: -us.x, y: -us.y }); head(he, end, ue)
  let rings: Point[][] = []
  if (length >= 0.1 && pieces.length) {
    // Near-tangent edges can disagree in the floating-point sweep-line graph.
    // Snap below the curve's 0.04px tolerance before retrying the same union.
    for (const precision of [10000, 1000, 100]) {
      const polygons = pieces.map(ring => [ring.map(p => [Math.round(p.x * precision) / precision, Math.round(p.y * precision) / precision] as [number, number])]), first = polygons[0]
      if (!first) break
      try { rings = polygonClipping.union(first, ...polygons.slice(1)).flatMap(polygon => polygon.map(ring => ring.map(([x, y]) => ({ x, y })))); break }
      catch (error) { if (precision === 100) throw error }
    }
  }
  const points = rings.flat(), xs = points.map(p => p.x), ys = points.map(p => p.y)
  const geometry = { rings, bounds: points.length ? { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) } : { ...start, width: 0, height: 0 }, outline: Math.max(base * 0.34, 1.6) }
  cache.set(mark, { key, geometry }); return geometry
}
export function arrowContains(mark: Mark, point: Point, extra: number) {
  let inside = false
  for (const ring of arrowGeometry(mark).rings) {
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length]; if (!a || !b) continue
      if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) inside = !inside
      const ab = sub(b, a), ap = sub(point, a), t = Math.max(0, Math.min(1, (ap.x * ab.x + ap.y * ab.y) / (ab.x * ab.x + ab.y * ab.y || 1)))
      if (norm(sub(point, add(a, ab, t))) <= extra) return true
    }
  }
  return inside
}
