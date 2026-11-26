const { deflateSync } = require('node:zlib')
const { mkdirSync, writeFileSync } = require('node:fs')
const { join } = require('node:path')

function crc32(buffer) {
  let checksum = 0xffffffff
  for (const byte of buffer) {
    checksum ^= byte
    for (let bit = 0; bit < 8; bit += 1) checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0)
  }
  return (checksum ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const name = Buffer.from(type)
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const checksum = Buffer.alloc(4)
  checksum.writeUInt32BE(crc32(Buffer.concat([name, data])))
  return Buffer.concat([length, name, data, checksum])
}

function png(size) {
  const rows = Buffer.alloc(size * (1 + size * 4))
  for (let vertical = 0; vertical < size; vertical += 1) {
    for (let horizontal = 0; horizontal < size; horizontal += 1) {
      const position = vertical * (1 + size * 4) + 1 + horizontal * 4
      const normalizedX = horizontal / size
      const normalizedY = vertical / size
      const mark = normalizedY > 0.22 && normalizedY < 0.78 &&
        Math.abs(Math.abs(normalizedX - 0.5) - (0.78 - normalizedY) * 0.52) < 0.055
      rows.set(mark ? [155, 228, 199, 255] : [24, 30, 40, 255], position)
    }
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(size, 0)
  header.writeUInt32BE(size, 4)
  header[8] = 8
  header[9] = 6
  return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))])
}

const sizes = [16, 32, 48, 256]
const images = sizes.map(png)
const directory = Buffer.alloc(6 + sizes.length * 16)
directory.writeUInt16LE(1, 2)
directory.writeUInt16LE(sizes.length, 4)
let offset = directory.length
sizes.forEach((size, index) => {
  const entry = 6 + index * 16
  directory[entry] = size % 256
  directory[entry + 1] = size % 256
  directory.writeUInt16LE(1, entry + 4)
  directory.writeUInt16LE(32, entry + 6)
  directory.writeUInt32LE(images[index].length, entry + 8)
  directory.writeUInt32LE(offset, entry + 12)
  offset += images[index].length
})
const resources = join(__dirname, '..', 'resources')
mkdirSync(resources, { recursive: true })
writeFileSync(join(resources, 'tray.ico'), Buffer.concat([directory, ...images]))
writeFileSync(join(resources, 'icon.png'), images[3])
