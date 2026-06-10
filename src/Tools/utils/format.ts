export function formatFileSize(sizeInBytes: number): string {
  const kb = sizeInBytes / 1024
  if (kb < 1) {
    return `${sizeInBytes} bytes`
  }
  if (kb < 1024) {
    return `${kb.toFixed(1).replace(/\.0$/, '')}KB`
  }
  const mb = kb / 1024
  if (mb < 1024) {
    return `${mb.toFixed(1).replace(/\.0$/, '')}MB`
  }
  const gb = mb / 1024
  return `${gb.toFixed(1).replace(/\.0$/, '')}GB`
}