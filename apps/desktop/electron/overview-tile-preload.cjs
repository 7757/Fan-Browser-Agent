// Preload for the transparent "click-catcher" WebContentsView floated on TOP of
// each LIVE overview tile.
//
// In "全部绘画" a running session's real page WebContentsView is floated over its
// tile to show live progress (main.cjs setOverviewLiveTiles). That native view is
// an OS-level layer above the DOM, so it swallows the click the DOM tile button
// would use to OPEN the session — the tile becomes unclickable while the agent
// runs. This catcher sits ABOVE the live view and:
//   • converts a click into "open this session" (main resolves which session by
//     this catcher's webContents id), and
//   • forwards wheel so the overview still scrolls while the pointer is over a
//     running tile (the live view would otherwise eat the wheel — pre-existing).
// Same overlay-View pattern as the modal scrim (see scrim-preload.cjs).
const { ipcRenderer } = require('electron')

window.addEventListener(
  'click',
  () => {
    ipcRenderer.send('fan:overview:tileClick')
  },
  true
)

window.addEventListener(
  'wheel',
  event => {
    ipcRenderer.send('fan:overview:tileWheel', { deltaX: event.deltaX, deltaY: event.deltaY })
  },
  { capture: true, passive: true }
)
