import { readFileSync, writeFileSync } from 'node:fs'
const file = process.argv[2]
if (!file) throw new Error('Usage: node scripts/inspect-portable-pe.mjs <application.exe> [report.json]')
const bytes = readFileSync(file)
if (bytes.subarray(0, 2).toString() !== 'MZ') throw new Error('Not a PE application.')
const pe = bytes.readUInt32LE(60), optional = pe + 24, count = bytes.readUInt16LE(pe + 6)
const directory = optional + (bytes.readUInt16LE(optional) === 0x20b ? 112 : 96)
const sections = optional + bytes.readUInt16LE(pe + 20)
const offset = rva => {
  for (let index = 0; index < count; index++) {
    const section = sections + index * 40, address = bytes.readUInt32LE(section + 12)
    const size = Math.max(bytes.readUInt32LE(section + 8), bytes.readUInt32LE(section + 16))
    if (rva >= address && rva < address + size) return bytes.readUInt32LE(section + 20) + rva - address
  }
  throw new Error(`Invalid PE RVA: ${rva}`)
}
const dllName = rva => { const start = offset(rva); return bytes.subarray(start, bytes.indexOf(0, start)).toString() }
const imports = [], delayImports = []
const importRva = bytes.readUInt32LE(directory + 8)
if (importRva) {
  for (let entry = offset(importRva); bytes.readUInt32LE(entry + 12); entry += 20) imports.push(dllName(bytes.readUInt32LE(entry + 12)))
}
const delayRva = bytes.readUInt32LE(directory + 13 * 8)
if (delayRva) {
  for (let entry = offset(delayRva); bytes.readUInt32LE(entry + 4); entry += 32) {
    if ((bytes.readUInt32LE(entry) & 1) !== 1) throw new Error('Unsupported delay import addressing.')
    delayImports.push(dllName(bytes.readUInt32LE(entry + 4)))
  }
}
const report = { executable: file, bytes: bytes.length, imports: [...new Set(imports)], delayImports, runtimePrerequisite: 'Supported Windows with WebView2; DLL imports are checked separately from WebView2 activation.' }
if (process.argv[3]) writeFileSync(process.argv[3], JSON.stringify(report, null, 2))
console.log(JSON.stringify(report, null, 2))
