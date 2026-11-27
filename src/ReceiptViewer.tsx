import { useEffect, useState } from 'react'
import { ChevronLeft, Download, ExternalLink, Image as ImageIcon, ImageOff, LoaderCircle, ZoomIn, ZoomOut } from 'lucide-react'
import type { Restaurant } from './lib/useRestaurant'
import type { ReceiptPhoto } from './lib/receipts'

export function ReceiptPreviewThumb({ app, path, alt }: { app: Restaurant; path: string; alt: string }) {
  const cached = app.peekReceiptUrl(path)
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null)
  const src = cached || loadedSrc
  const { receiptDisplayUrl } = app

  useEffect(() => {
    if (cached) return
    let alive = true
    void receiptDisplayUrl(path).then(({ displayUrl }) => {
      if (alive) setLoadedSrc(displayUrl)
    }).catch(() => undefined)
    return () => { alive = false }
  }, [cached, path, receiptDisplayUrl])

  return <span className="receipt-attachment-thumb">
    {src ? <img src={src} alt={alt} loading="eager" decoding="async"/> : <ImageIcon size={18} aria-hidden="true"/>}
  </span>
}

export function ReceiptPage({ app, photo, back }: { app: Restaurant; photo: ReceiptPhoto; back: () => void }) {
  const cachedDisplay = app.peekReceiptObjectUrl(photo.path) || app.peekReceiptUrl(photo.path)
  const [fetchedDisplay, setFetchedDisplay] = useState<string | null>(null)
  const [externalUrl, setExternalUrl] = useState<string | null>(() => {
    const peek = app.peekReceiptUrl(photo.path)
    return peek && !peek.startsWith('blob:') ? peek : null
  })
  const [imageError, setImageError] = useState(false)
  const [downloading, setDownloading] = useState(false)
  const [downloadError, setDownloadError] = useState('')
  const [zoomed, setZoomed] = useState(false)
  const { receiptDisplayUrl } = app

  const displayUrl = fetchedDisplay || cachedDisplay
  const loading = !displayUrl && !imageError

  useEffect(() => {
    let alive = true
    void receiptDisplayUrl(photo.path).then(result => {
      if (!alive) return
      setFetchedDisplay(result.displayUrl)
      setExternalUrl(result.externalUrl)
    }).catch(() => {
      if (!alive) return
      if (!cachedDisplay) setImageError(true)
    })
    return () => { alive = false }
  }, [cachedDisplay, photo.path, receiptDisplayUrl])

  async function handleDownload() {
    setDownloading(true)
    setDownloadError('')
    try {
      await app.downloadReceipt(photo.path, photo.name)
    } catch {
      setDownloadError('No se pudo descargar la foto. Intenta abrirla en otra pestaña.')
    } finally {
      setDownloading(false)
    }
  }

  return <div className="photo-page">
    <div className="subpage-bar photo-page-bar">
      <button type="button" className="back-button" onClick={back} aria-label="Volver"><ChevronLeft size={22}/><span>Volver</span></button>
      <div>
        <p className="eyebrow">{photo.subtitle || 'Comprobante'}</p>
        <h1>{photo.title}</h1>
      </div>
      {displayUrl && !imageError && <button type="button" className="icon-button photo-zoom-toggle" onClick={() => setZoomed(value => !value)} aria-label={zoomed ? 'Ajustar a pantalla' : 'Ampliar foto'} aria-pressed={zoomed}>
        {zoomed ? <ZoomOut size={19}/> : <ZoomIn size={19}/>}
      </button>}
    </div>

    <section className={`photo-stage ${zoomed ? 'is-zoomed' : ''}`} aria-label={photo.title}>
      {loading && <div className="receipt-loading">
        <LoaderCircle className="spin" size={28}/>
        <span>Cargando foto…</span>
      </div>}
      {imageError
        ? <div className="receipt-loading is-error">
            <ImageOff size={28}/>
            <span>No se pudo cargar la foto.</span>
          </div>
        : displayUrl && <img
            src={displayUrl}
            alt={photo.title}
            loading="eager"
            decoding="async"
            fetchPriority="high"
            onClick={() => setZoomed(value => !value)}
            onError={() => setImageError(true)}
          />}
    </section>

    <p className="photo-stage-hint">{zoomed ? 'Toca la foto o el botón de lupa para ajustar a pantalla.' : 'Toca la foto para ampliarla y leer mejor los detalles.'}</p>

    {downloadError && <p className="alert alert-error" role="alert">{downloadError}</p>}

    <div className="photo-page-actions">
      <button type="button" className="btn btn-primary btn-lg" disabled={downloading || imageError || loading} onClick={() => void handleDownload()}>
        <Download size={18}/>{downloading ? 'Descargando…' : 'Descargar foto'}
      </button>
      {externalUrl
        ? <a className="btn btn-ghost btn-lg" href={externalUrl} target="_blank" rel="noreferrer">
            <ExternalLink size={18}/>Abrir en otra pestaña
          </a>
        : <button type="button" className="btn btn-ghost btn-lg" disabled={imageError} onClick={async () => {
            try {
              const url = await app.receiptUrl(photo.path)
              setExternalUrl(url)
              window.open(url, '_blank', 'noopener,noreferrer')
            } catch {
              setDownloadError('No se pudo abrir en otra pestaña.')
            }
          }}>
            <ExternalLink size={18}/>Abrir en otra pestaña
          </button>}
    </div>
  </div>
}
