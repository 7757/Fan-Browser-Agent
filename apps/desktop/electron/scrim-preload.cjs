// Preload for the modal scrim WebContentsView that dims the embedded browser
// while a dialog / command palette is open. The scrim is a separate native
// surface, so clicks and keys land in ITS webContents — forward the two
// dismiss gestures back to the app renderer via the main process.
const { ipcRenderer } = require('electron')

window.addEventListener(
  'click',
  () => {
    ipcRenderer.send('fan:scrim:dismiss')
  },
  true
)

window.addEventListener(
  'keydown',
  event => {
    if (event.key === 'Escape') {
      ipcRenderer.send('fan:scrim:dismiss')
    }
  },
  true
)
