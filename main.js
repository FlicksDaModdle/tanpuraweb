const { app, BrowserWindow, Menu, screen } = require("electron");
const path = require("path");

function createWindow() {
  // Full content (masthead + key card + both tanpura panels + footer) needs
  // roughly 1090-1100px of window height at the default 520px width to show
  // with no scrollbar. 1120 gives a little breathing room. But hard-coding
  // that risks the window opening taller than a smaller display can show
  // (a 1080p screen's usable work area, after the taskbar, is more like
  // ~1030-1040px) — so cap it to the actual screen's work area instead of
  // just the fixed number. Below that cap it falls back to the scrollbar,
  // which still works fine.
  const { workAreaSize } = screen.getPrimaryDisplay();
  const desiredHeight = 1120;
  const height = Math.min(desiredHeight, workAreaSize.height - 40);

  const win = new BrowserWindow({
    width: 520,
    height,
    minWidth: 400,
    minHeight: 700,
    backgroundColor: "#1c130d",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "build", "icon.png"),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  Menu.setApplicationMenu(null);
  win.loadFile(path.join(__dirname, "index.html"));
}

app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
