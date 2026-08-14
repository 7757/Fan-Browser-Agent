export function installDocumentVisibilityPolicy(doc: Document = document): () => void {
  const sync = () => {
    doc.documentElement.toggleAttribute('data-app-hidden', doc.visibilityState !== 'visible')
  }

  sync()
  doc.addEventListener('visibilitychange', sync)

  return () => {
    doc.removeEventListener('visibilitychange', sync)
    doc.documentElement.removeAttribute('data-app-hidden')
  }
}
