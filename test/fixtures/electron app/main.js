const { app, BrowserWindow } = require('electron');

app.whenReady().then(() => {
  const window = new BrowserWindow({ width: 640, height: 480 });
  window.loadFile('index.html');
});
