# Windows Setup Guide

ohwow runs on Windows 10 and Windows 11 with Node.js 20 or later.

## Prerequisites

1. **Node.js 20+**: Download from [nodejs.org](https://nodejs.org/) or install via `winget install OpenJS.NodeJS.LTS`

2. **Visual Studio C++ Build Tools**: Required for the `better-sqlite3` native module. Install via:
   ```
   winget install Microsoft.VisualStudio.2022.BuildTools --override "--add Microsoft.VisualStudio.Workload.VCTools"
   ```
   Or download from [visualstudio.microsoft.com](https://visualstudio.microsoft.com/visual-cpp-build-tools/)

3. **Python 3.8+** (optional): Only needed for voice and web scraping features (Voicebox, Scrapling). Install via `winget install Python.Python.3.12`

## Installation

```
npm install -g ohwow
```

If the install fails with a `node-gyp` error, make sure Visual Studio C++ Build Tools are installed (see prerequisites above).

## Usage

All commands work the same as on macOS and Linux:

```
ohwow              # Start TUI
ohwow --daemon     # Start daemon in foreground
ohwow stop         # Stop the daemon
ohwow status       # Check daemon status
ohwow logs         # Tail daemon logs (uses PowerShell Get-Content)
ohwow restart      # Restart the daemon
```

## Shell Execution

When an AI agent runs shell commands on Windows, ohwow uses **PowerShell** (`powershell.exe`) instead of bash. PowerShell ships with all Windows 10+ installations. Commands run with `-NoProfile -NonInteractive` flags to bypass execution policy restrictions for inline commands.

## GPU Detection

ohwow automatically detects your GPU for local model recommendations:

- **NVIDIA GPUs**: Detected via `nvidia-smi` (ships with NVIDIA drivers, already in PATH at `C:\Windows\System32`)
- **Other GPUs**: Detected via WMI (`wmic path win32_videocontroller`)
- **VRAM estimation**: Uses nvidia-smi for NVIDIA cards, falls back to 75% of system RAM

## Ollama

If Ollama is not installed, ohwow will offer to install it via `winget` (if available). You can also install manually from [ollama.com/download/windows](https://ollama.com/download/windows).

## Known Limitations

- **Desktop control** (mouse, keyboard, screen capture) is available on macOS only
- **AMD ROCm GPU detection** is Linux only (ROCm does not support Windows)
- File permission restrictions (like `0600` on PID files) are not enforced on Windows
