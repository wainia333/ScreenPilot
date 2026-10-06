// Pixel-block averaging: partial edge blocks
// average only real pixels. One repeated edge pixel protects smooth sampling.
export function reduceMosaic(source: Uint8ClampedArray, width: number, height: number, block: number) {
  block = Math.max(2, Math.round(block))
  const cols = Math.ceil(width / block), rows = Math.ceil(height / block), outWidth = cols + 2, outHeight = rows + 2
  const data = new Uint8ClampedArray(outWidth * outHeight * 4)
  for (let row = 0; row < rows; row++) for (let col = 0; col < cols; col++) {
    const x1 = col * block, y1 = row * block, x2 = Math.min(width, x1 + block), y2 = Math.min(height, y1 + block), count = (x2 - x1) * (y2 - y1)
    const sums = [0, 0, 0, 0]
    for (let y = y1; y < y2; y++) for (let x = x1; x < x2; x++) { const at = (y * width + x) * 4; for (let c = 0; c < 4; c++) sums[c] = (sums[c] ?? 0) + (source[at + c] ?? 0) }
    const at = ((row + 1) * outWidth + col + 1) * 4
    for (let c = 0; c < 4; c++) data[at + c] = Math.floor(((sums[c] ?? 0) + count / 2) / count)
  }
  for (let y = 0; y < outHeight; y++) for (let x = 0; x < outWidth; x++) {
    if (x > 0 && y > 0 && x <= cols && y <= rows) continue
    const from = (Math.min(rows, Math.max(1, y)) * outWidth + Math.min(cols, Math.max(1, x))) * 4
    data.set(data.subarray(from, from + 4), (y * outWidth + x) * 4)
  }
  return { data, width: outWidth, height: outHeight }
}
