export function stableMarkdown(value: string): string {
  const fences = value.match(/```/gu)?.length ?? 0
  const blockMath = value.match(/\$\$/gu)?.length ?? 0
  return `${value}${fences % 2 === 1 ? '\n```' : ''}${blockMath % 2 === 1 ? '\n$$' : ''}`
}
