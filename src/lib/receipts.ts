export type ReceiptPhoto = {
  path: string
  title: string
  subtitle?: string
  name: string
}

export const receiptName = (path: string, base: string) => {
  const cleanBase = base
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'palatto-foto'
  const extension = (path.split('.').pop() || 'jpg').toLowerCase().replace(/[^a-z0-9]/g, '') || 'jpg'
  return `${cleanBase}.${extension}`
}

export function triggerBlobDownload(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const link = document.createElement('a')
  link.href = url
  link.download = filename
  document.body.appendChild(link)
  link.click()
  link.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 4000)
}

/**
 * Resize and compress receipt photos before upload so they open rapidly on mobile connections
 * while keeping numbers and transfer details sharp.
 */
export async function compressReceiptImage(file: File): Promise<File> {
  if (typeof document === 'undefined' || !file.type.startsWith('image/')) return file
  // Small files (< 180 KB) are already fast to upload and view.
  if (file.size <= 180 * 1024) return file
  try {
    const maxDimension = 1600
    let width = 0
    let height = 0
    let draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void

    if (typeof createImageBitmap === 'function') {
      const bitmap = await createImageBitmap(file)
      width = bitmap.width
      height = bitmap.height
      draw = (ctx, w, h) => {
        ctx.drawImage(bitmap, 0, 0, w, h)
        bitmap.close()
      }
    } else {
      const objectUrl = URL.createObjectURL(file)
      const img = await new Promise<HTMLImageElement>((resolve, reject) => {
        const element = new Image()
        element.onload = () => resolve(element)
        element.onerror = () => reject(new Error('No se pudo leer la imagen'))
        element.src = objectUrl
      })
      URL.revokeObjectURL(objectUrl)
      width = img.naturalWidth
      height = img.naturalHeight
      draw = (ctx, w, h) => ctx.drawImage(img, 0, 0, w, h)
    }

    if (!width || !height) return file
    const scale = Math.min(1, maxDimension / Math.max(width, height))
    const targetWidth = Math.max(1, Math.round(width * scale))
    const targetHeight = Math.max(1, Math.round(height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = targetWidth
    canvas.height = targetHeight
    const context = canvas.getContext('2d')
    if (!context) return file
    draw(context, targetWidth, targetHeight)

    const targetType = file.type === 'image/png' ? 'image/webp' : file.type === 'image/webp' ? 'image/webp' : 'image/jpeg'
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, targetType, 0.82))
    if (!blob || blob.size >= file.size * 0.92) return file
    const ext = targetType === 'image/webp' ? 'webp' : 'jpg'
    const nextName = file.name.replace(/\.[^.]+$/, '') + `.${ext}`
    return new File([blob], nextName, { type: targetType, lastModified: file.lastModified })
  } catch {
    return file
  }
}
