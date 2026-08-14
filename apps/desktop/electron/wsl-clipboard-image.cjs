// Read an image from the Windows-host clipboard when Fan runs inside WSL2.
// WSLg bridges clipboard text, but screenshots frequently do not reach
// Electron's Linux clipboard.  This fixed PowerShell program contains no
// user-provided interpolation and returns only validated PNG bytes.

const { execFileSync } = require('node:child_process')

const PS_SCRIPT = [
  'Add-Type -AssemblyName System.Windows.Forms,System.Drawing',
  '$img = [System.Windows.Forms.Clipboard]::GetImage()',
  'if ($null -eq $img) { exit 0 }',
  '$ms = New-Object System.IO.MemoryStream',
  '$img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)',
  '[Console]::Out.Write([System.Convert]::ToBase64String($ms.ToArray()))'
].join('\n')

function encodePowerShellCommand(script) {
  return Buffer.from(String(script), 'utf16le').toString('base64')
}

function powershellCandidates() {
  return [
    'powershell.exe',
    '/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe'
  ]
}

function decodeClipboardImageBase64(stdout) {
  const encoded = String(stdout || '').trim()
  if (!encoded) return null

  let image
  try {
    image = Buffer.from(encoded, 'base64')
  } catch {
    return null
  }

  const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  if (
    image.length < pngSignature.length ||
    !image.subarray(0, pngSignature.length).equals(pngSignature)
  ) {
    return null
  }

  return image
}

// Never throw from a clipboard fallback: a missing Windows interop binary,
// an empty host clipboard, and malformed output all behave as "no image".
function readWslWindowsClipboardImage({
  exec = execFileSync,
  candidates = powershellCandidates()
} = {}) {
  const encoded = encodePowerShellCommand(PS_SCRIPT)

  for (const powershell of candidates) {
    try {
      const stdout = exec(
        powershell,
        [
          '-NoProfile',
          '-NonInteractive',
          '-STA',
          '-ExecutionPolicy',
          'Bypass',
          '-EncodedCommand',
          encoded
        ],
        {
          encoding: 'utf8',
          windowsHide: true,
          timeout: 8000,
          maxBuffer: 64 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'ignore']
        }
      )
      const image = decodeClipboardImageBase64(stdout)
      if (image) return image
      if (String(stdout || '').trim() === '') return null
    } catch {
      // Try the fallback absolute Windows path before giving up.
    }
  }

  return null
}

module.exports = {
  decodeClipboardImageBase64,
  encodePowerShellCommand,
  powershellCandidates,
  readWslWindowsClipboardImage
}
