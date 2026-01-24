# Macroni

A minimal, clean desktop application for recording keyboard and mouse activity with timestamps. Built with Tauri, React, TypeScript, and Tailwind CSS v4.

## Features

- **Global Input Listening**: Records keyboard and mouse events even when the app is in the background
- **Mouse Tracking**: Captures mouse clicks (left, right, middle) with precise coordinates
- **Keyboard Tracking**: Records all keystrokes with timestamps
- **Live Display**: See events appear in real-time as they happen
- **Save & Load**: Save recordings with custom names and load them later
- **Timestamped Logs**: Each event is recorded with precise millisecond timestamps
- **Always on Top**: Window stays visible across all Spaces/Desktops
- **Clean UI**: Minimal, modern interface with glassmorphic transparency

## Prerequisites

- Node.js (v18 or later)
- Rust (latest stable version)
- Platform-specific requirements:
  - **macOS**: You'll be prompted to grant Accessibility permissions on first run
  - **Linux**: No additional permissions required
  - **Windows**: No additional permissions required

## Installation

1. Install dependencies:
```bash
npm install
```

2. Run in development mode:
```bash
npm run tauri dev
```

3. Build for production:
```bash
npm run tauri build
```

## Usage

1. **Start Recording**: Click the "Start" button to begin capturing input events
2. **Stop Recording**: Click the "Stop" button when done
3. **Save**: Enter a name for your recording and click "Save"
4. **View Recordings**: Click the eye icon next to any saved recording to view details
5. **Delete Recordings**: Click the trash icon to remove a recording

## Important Notes

### macOS Permissions

On macOS, the app requires Accessibility permissions to capture global input events. When you first run the app and start recording, you'll see a system dialog asking for permission. 

To grant permissions:
1. Open System Preferences → Security & Privacy → Privacy → Accessibility
2. Unlock the settings (click the lock icon)
3. Add **Cursor.app** (or your IDE/Terminal app)
4. Check the box to enable permissions
5. Restart the app

## Tech Stack

- **Tauri 2**: Cross-platform desktop app framework with macOS private API
- **React 19**: UI library
- **TypeScript 5.9**: Type-safe JavaScript
- **Tailwind CSS v4**: CSS-first utility framework
- **shadcn/ui**: Re-usable component library
- **rdev**: Cross-platform global input capture (Rust)
- **Vite 7**: Fast build tool

## Tailwind CSS v4

This project uses Tailwind CSS v4's new CSS-first configuration approach:
- ✅ No `tailwind.config.js` file needed
- ✅ Theme configuration in CSS using `@theme` directive
- ✅ Native CSS cascade layers
- ✅ Uses OKLCH color space for better color consistency

## What's Recorded

The app captures:
- **Keyboard Events**: All key presses with key name
- **Mouse Clicks**: Press and release events for all buttons
- **Mouse Position**: X,Y coordinates for each click
- **Timestamps**: Millisecond precision for all events

## License

MIT
