const { app, BrowserWindow, ipcMain, session, protocol, net, clipboard, Menu, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { exec, execFile, execSync, spawn } = require('child_process');
const { pathToFileURL } = require('url');
const ffmpeg = require('fluent-ffmpeg');


// Set up secure custom media protocol to play local audio files in Renderer
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { bypassCSP: true, stream: true, supportFetchAPI: true, corsEnabled: true } }
]);

let mainWindow;
let activeModel = 'ggml-base.bin';

// Tracks VC++ redist state when user skips the initial dialog
let vcRedistMissingInfo = null; // null = installed/unchecked, { archKey, downloadUrl } = missing & skipped

// Helper to resolve paths to binaries/assets, handling ASAR unpacking automatically
function getAssetPath(...parts) {
  let base;
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    // Packaged Portable application: locate binaries next to the portable executable on host system
    base = process.env.PORTABLE_EXECUTABLE_DIR;
  } else {
    // Installed application or Development mode: locate inside resources or project directory
    base = __dirname.replace('app.asar', 'app.asar.unpacked');
  }
  return path.join(base, ...parts);
}

// Helper to get component config (reads defaults from conf.json, overlays writeable overrides)
function getLocalComponentConfig(component) {
  let config = null;

  // 1. Read default configs from conf.json (single source of truth)
  try {
    const conf = initConf();
    if (conf.pkg && conf.pkg[component]) {
      config = { ...conf.pkg[component] };
    }
  } catch (e) {
    console.error(`[getLocalComponentConfig] Error reading conf.json for ${component}:`, e);
  }

  // 2. Overlay any writeable overrides from installed_components.json
  try {
    const overridePath = getComponentsConfigPath();
    if (fs.existsSync(overridePath)) {
      const overrides = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
      if (overrides[component]) {
        config = { ...config, ...overrides[component] };
      }
    }
  } catch (e) {
    console.error(`[getLocalComponentConfig] Error reading overrides for ${component}:`, e);
  }

  return config;
}

// Helper to get the path to the writeable component metadata file
function getComponentsConfigPath() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    // Portable: save config next to the portable exe (inside bin/) so it's fully self-contained
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'bin', 'installed_components.json');
  }
  // Installed or Dev: save config inside the writeable user data directory
  return path.join(app.getPath('userData'), 'installed_components.json');
}

// Helper to resolve the best URL and version for a component (tries online package.json first, falls back to local config)
async function getComponentDownloadUrl(component, defaultFallbackUrl, defaultFallbackVersion = 'latest') {
  const localConfig = getLocalComponentConfig(component);
  const localVersion = localConfig ? localConfig.version : null;

  // If local version is null, undefined, or the string "null" / "NULL", do NOT query the online version.
  // Use the local package.json configuration directly.
  const localVerStr = localVersion !== null && localVersion !== undefined ? String(localVersion).trim().toLowerCase() : null;
  if (localVersion === null || localVersion === undefined || localVerStr === 'null' || localVerStr === '') {
    const localUrl = localConfig && localConfig.url ? localConfig.url : defaultFallbackUrl;
    const fallbackVer = localVersion || defaultFallbackVersion;
    console.log(`[getComponentDownloadUrl] Local version for ${component} is NULL/undefined. Bypassing online lookup. Using local URL: ${localUrl}`);
    return { url: localUrl, version: fallbackVer, source: 'local' };
  }

  try {
    // Try fetching online package.json with a timeout
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), 3000); // 3-second timeout

    const response = await fetch('https://raw.githubusercontent.com/tinwinaung/SpeechBoleh/main/conf.json', { signal: id.signal });
    clearTimeout(id);

    if (response.ok) {
      const data = await response.json();
      if (data.pkg && data.pkg[component] && data.pkg[component].url) {
        const onlineUrl = data.pkg[component].url;
        const onlineVersion = data.pkg[component].version || 'latest';
        console.log(`[getComponentDownloadUrl] Resolved online URL for ${component}: ${onlineUrl} (version: ${onlineVersion})`);
        return { url: onlineUrl, version: onlineVersion, source: 'online' };
      }
    }
  } catch (e) {
    console.warn(`[getComponentDownloadUrl] Failed to fetch online conf.json for ${component}:`, e.message);
  }

  // Fall back to local package.json
  if (localConfig && localConfig.url) {
    const localUrl = localConfig.url;
    const localVersionVal = localConfig.version || 'latest';
    console.log(`[getComponentDownloadUrl] Resolved local package.json URL for ${component}: ${localUrl}`);
    return { url: localUrl, version: localVersionVal, source: 'local' };
  }

  console.log(`[getComponentDownloadUrl] Resolved default fallback URL for ${component}: ${defaultFallbackUrl}`);
  return { url: defaultFallbackUrl, version: defaultFallbackVersion, source: 'fallback' };
}

// Ensure temp directory exists inside writable user data if packaged
const tmpDir = app.isPackaged 
  ? path.join(app.getPath('userData'), 'tmp') 
  : path.join(__dirname, 'tmp');

if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
}

// ----------------------------------------------------
// conf.json — Writable Config (Option B)
// On first run, the bundled conf.json (inside ASAR) is copied to a writable
// location so the user can edit it after installation without touching the ASAR.
//
//   Installed mode : %APPDATA%\SpeechBoleh\conf.json
//   Portable mode  : <portableDir>\conf.json
//   Dev mode       : <projectDir>\conf.json  (read directly, no copy needed)
// ----------------------------------------------------

function getConfPath() {
  if (!app.isPackaged) {
    // Development: read directly from the project directory
    return path.join(__dirname, 'conf.json');
  }
  if (process.env.PORTABLE_EXECUTABLE_DIR) {
    // Portable: store next to the portable executable
    return path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'conf.json');
  }
  // Installed: store in writable userData directory
  return path.join(app.getPath('userData'), 'conf.json');
}

function initConf() {
  const writablePath = getConfPath();

  // Read app version from package.json (bundled with app)
  let appVersion = '0.0.0';
  try {
    const pkgPath = path.join(__dirname, 'package.json');
    if (fs.existsSync(pkgPath)) {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      appVersion = pkg.version || '0.0.0';
    }
  } catch (e) {
    console.warn('[conf.json] Failed to read package.json version:', e.message);
    try {
      appVersion = app.getVersion();
    } catch (_) {}
  }

  // Helper to extract bundled configuration to the writable path with the correct version
  const extractConfig = () => {
    try {
      const bundledPath = path.join(__dirname, 'conf.json');
      const bundledConf = JSON.parse(fs.readFileSync(bundledPath, 'utf8'));
      
      if (!bundledConf.app) {
        bundledConf.app = {};
      }
      bundledConf.app.version = appVersion;

      fs.mkdirSync(path.dirname(writablePath), { recursive: true });
      fs.writeFileSync(writablePath, JSON.stringify(bundledConf, null, 4), 'utf8');
      console.log(`[conf.json] Extracted/Updated config to version ${appVersion} at: ${writablePath}`);
      return bundledConf;
    } catch (err) {
      console.error('[conf.json] Failed to extract config from bundle:', err.message);
      return null;
    }
  };

  // Packaged mode: first-run extract or version-gated re-extract
  if (app.isPackaged) {
    if (!fs.existsSync(writablePath)) {
      console.log('[conf.json] Writable config file does not exist. Extracting...');
      extractConfig();
    } else {
      try {
        const rawConf = fs.readFileSync(writablePath, 'utf8');
        const conf = JSON.parse(rawConf);
        const currentConfVersion = conf.app?.version;

        if (currentConfVersion !== appVersion) {
          console.log(`[conf.json] Version mismatch (conf.json version: ${currentConfVersion}, package.json version: ${appVersion}). Re-extracting...`);
          extractConfig();
        } else {
          console.log(`[conf.json] Version match (version: ${appVersion}). No extraction needed.`);
        }
      } catch (err) {
        console.warn('[conf.json] Error reading existing config to check version, re-extracting:', err.message);
        extractConfig();
      }
    }
  }

  // Read from the writable location (or project dir in dev mode)
  try {
    const raw = fs.readFileSync(writablePath, 'utf8');
    const conf = JSON.parse(raw);
    console.log(`[conf.json] Loaded from: ${writablePath}`);
    return conf;
  } catch (readErr) {
    console.warn('[conf.json] Failed to read config, falling back to bundled defaults:', readErr.message);
    // Last-resort fallback: read the bundled copy directly
    try {
      const bundledPath = path.join(__dirname, 'conf.json');
      return JSON.parse(fs.readFileSync(bundledPath, 'utf8'));
    } catch (e) {
      console.error('[conf.json] Bundled config also unreadable:', e.message);
      return {};
    }
  }
}

// Load Whisper model configuration from conf.json (single source of truth)
let whisperModels = [];
let piperVoices = [];
try {
  const conf = initConf();
  whisperModels = conf.whisper?.models || [];
  piperVoices = conf.piper?.voices || [];
  console.log(`[conf.json] Loaded ${whisperModels.length} Whisper model(s).`);
  console.log(`[conf.json] Loaded ${piperVoices.length} Piper voice(s).`);
} catch (e) {
  console.warn('[conf.json] Failed to load model/voice config:', e.message);
}

// ----------------------------------------------------
// Robust FFmpeg Binary Location
// ----------------------------------------------------
function configureFfmpeg() {
  // 1. Prioritize local bin directory to support fully self-contained deployment
  const localBinPath = getAssetPath('bin', 'ffmpeg', 'bin', 'ffmpeg.exe');
  if (fs.existsSync(localBinPath)) {
    ffmpeg.setFfmpegPath(localBinPath);
    console.log(`[FFmpeg] Binary configured at local path: ${localBinPath}`);
    return;
  }

  const possiblePaths = [
    // WinGet gyan.dev standard path
    path.join(process.env.USERPROFILE || 'C:\\Users\\TINWINAUNG', 'AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.2-full_build\\bin\\ffmpeg.exe'),
    // Standard system-wide C:\ffmpeg bin
    'C:\\ffmpeg\\bin\\ffmpeg.exe'
  ];

  let ffmpegPath = 'ffmpeg'; // Default fallback to system PATH

  // 2. Try to find ffmpeg using system 'where' command on Windows
  try {
    const whereOutput = execSync('where ffmpeg', { encoding: 'utf8' }).trim();
    const firstPath = whereOutput.split('\r\n')[0];
    if (firstPath && fs.existsSync(firstPath)) {
      ffmpegPath = firstPath;
    }
  } catch (e) {
    // 'where' command failed, proceed to checking paths
  }

  // 3. Fall back to standard known absolute paths if system PATH doesn't have it
  if (ffmpegPath === 'ffmpeg') {
    for (const p of possiblePaths) {
      if (fs.existsSync(p)) {
        ffmpegPath = p;
        break;
      }
    }
  }

  ffmpeg.setFfmpegPath(ffmpegPath);
  console.log(`[FFmpeg] Binary configured at: ${ffmpegPath}`);
}

configureFfmpeg();

function hasValidFfmpeg() {
  const localBinPath = getAssetPath('bin', 'ffmpeg', 'bin', 'ffmpeg.exe');
  if (fs.existsSync(localBinPath)) return true;

  try {
    const whereOutput = execSync('where ffmpeg', { encoding: 'utf8' }).trim();
    const firstPath = whereOutput.split('\r\n')[0];
    if (firstPath && fs.existsSync(firstPath)) return true;
  } catch (e) {}

  const possiblePaths = [
    path.join(process.env.USERPROFILE || 'C:\\Users\\TINWINAUNG', 'AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.2-full_build\\bin\\ffmpeg.exe'),
    'C:\\ffmpeg\\bin\\ffmpeg.exe'
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return true;
  }
  return false;
}

// ----------------------------------------------------
// Clean up all temporary files in tmp folder
// ----------------------------------------------------
function cleanupTempFiles() {
  try {
    if (fs.existsSync(tmpDir)) {
      const files = fs.readdirSync(tmpDir);
      for (const file of files) {
        const filePath = path.join(tmpDir, file);
        try {
          const stat = fs.statSync(filePath);
          if (stat.isDirectory()) {
            fs.rmSync(filePath, { recursive: true, force: true });
          } else {
            fs.unlinkSync(filePath);
          }
        } catch (fileErr) {
          console.warn(`[Cleanup] Failed to remove ${file}:`, fileErr.message);
        }
      }
      console.log('[Cleanup] Temporary files successfully purged.');
    }
  } catch (err) {
    console.error('[Cleanup] Error cleaning up temporary files:', err);
  }
}

// Create Electron window
function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 750,
    icon: path.join(__dirname, 'assets', 'favicon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true // Keeps the application secure while custom media protocol handles audio loading
    },
    title: "Local STT & TTS Pipeline Client",
    autoHideMenuBar: true,
    frame: false
  });

  mainWindow.setMenu(null);
  mainWindow.loadFile('index.html');

  // After the page loads, notify renderer if VC++ redist was skipped
  mainWindow.webContents.on('did-finish-load', () => {
    if (vcRedistMissingInfo) {
      mainWindow.webContents.send('show-vcredist-required', vcRedistMissingInfo);
    }
  });

  mainWindow.on('maximize', () => {
    mainWindow.webContents.send('window-maximized-state', true);
  });

  mainWindow.on('unmaximize', () => {
    mainWindow.webContents.send('window-maximized-state', false);
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// IPC: Custom Window Control Actions
ipcMain.on('window-minimize', () => {
  if (mainWindow) mainWindow.minimize();
});

ipcMain.on('window-maximize', () => {
  if (mainWindow) {
    if (mainWindow.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow.maximize();
    }
  }
});

ipcMain.on('window-close', () => {
  if (mainWindow) mainWindow.close();
});

// IPC: Quit the entire application (used by VC++ redist blocking overlay)
ipcMain.on('quit-app', () => {
  app.quit();
});

// IPC: Trigger VC++ Redistributable download+install from the renderer blocking overlay
ipcMain.handle('install-vcredist', async () => {
  if (!vcRedistMissingInfo) return { success: true, alreadyInstalled: true };
  const { archKey, downloadUrl } = vcRedistMissingInfo;
  const redistTempPath = path.join(tmpDir, `vc_redist.${archKey}.exe`);
  try {
    console.log(`[System] Renderer-triggered VC++ download (${archKey}) from: ${downloadUrl}`);
    await downloadUrlToFile(downloadUrl, redistTempPath);
    console.log('[System] VC++ Redistributable download complete (renderer-triggered).');
    await launchInstaller(redistTempPath);

    // After installer closes, verify it actually installed successfully
    if (isVcRedistRegistryInstalled()) {
      console.log('[System] VC++ Redistributable installed successfully.');
      vcRedistMissingInfo = null; // Clear only after confirmed success
      return { success: true };
    } else {
      // Installer was cancelled or failed — keep the flag and re-trigger the overlay
      console.warn('[System] VC++ Redistributable installer closed without completing installation.');
      if (mainWindow) mainWindow.webContents.send('show-vcredist-required', { archKey, downloadUrl });
      return { success: false, installerCancelled: true, archKey, downloadUrl };
    }
  } catch (err) {
    console.error('[System] Renderer-triggered VC++ download failed:', err);
    return { success: false, error: err.message };
  }
});

// IPC: Quick flag check — is VC++ Redistributable still required?
// Used by the renderer to gate the component download chain at startup.
ipcMain.handle('is-vcredist-required', () => !!vcRedistMissingInfo);


// ----------------------------------------------------
// Microsoft Visual C++ Redistributable Checker
// ----------------------------------------------------

// Lightweight registry check — returns true if VC++ 2015-2022 Redistributable is installed
function isVcRedistRegistryInstalled() {
  if (process.platform !== 'win32') return true;
  const isArm64 = process.arch === 'arm64';
  const regKey = isArm64
    ? 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\arm64'
    : 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64';
  try {
    execSync(`reg query "${regKey}" /v Installed`, { stdio: 'ignore' });
    return true;
  } catch (e) {
    return false;
  }
}

async function checkAndInstallMsvc() {
  if (process.platform !== 'win32') return Promise.resolve();

  const { dialog } = require('electron');

  // Detect system architecture: arm64 or x64 (ia32 treated as x64)
  const isArm64 = process.arch === 'arm64';
  const archKey = isArm64 ? 'arm64' : 'x64';
  const confArchKey = isArm64 ? 'win_arm64' : 'win_x64';

  // Load download URL from conf.json vc_redist section
  let downloadUrl = isArm64
    ? 'https://aka.ms/vc14/vc_redist.arm64.exe'
    : 'https://aka.ms/vc14/vc_redist.x64.exe';
  try {
    const conf = initConf();
    if (conf.vc_redist && conf.vc_redist[confArchKey]) {
      downloadUrl = conf.vc_redist[confArchKey];
      console.log(`[System] VC++ Redistributable URL from conf.json (${archKey}): ${downloadUrl}`);
    }
  } catch (e) {
    console.warn('[System] Could not read vc_redist URL from conf.json, using built-in fallback.');
  }

  const redistFileName = `vc_redist.${archKey}.exe`;
  const redistLocalPath = getAssetPath('bin', redistFileName);
  const redistTempPath = path.join(tmpDir, redistFileName);

  let isInstalled = false;
  try {
    // Use the shared helper for the registry check
    isInstalled = isVcRedistRegistryInstalled();
  } catch (e) {
    isInstalled = false;
  }

  if (isInstalled) {
    console.log(`[System] Microsoft Visual C++ Redistributable (${archKey}) runtime check passed.`);
    return Promise.resolve();
  }

  let finalRedistPath = '';
  if (fs.existsSync(redistLocalPath)) {
    finalRedistPath = redistLocalPath;
  } else if (fs.existsSync(redistTempPath)) {
    finalRedistPath = redistTempPath;
  }

  if (finalRedistPath) {
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Install Now', 'Skip'],
      defaultId: 0,
      title: 'Microsoft Visual C++ Redistributable Required',
      message: `This application requires the Microsoft Visual C++ 2015-2022 Redistributable (${archKey}) runtime to execute local speech processing models.\n\nIt was not detected on your system. Would you like to launch the installer now?`,
      cancelId: 1
    });

    if (choice === 0) {
      await launchInstaller(finalRedistPath);
      // Check if installation actually completed after installer closes
      if (!isVcRedistRegistryInstalled()) {
        console.warn('[System] Bundled installer closed without completing — overlay will be shown.');
        vcRedistMissingInfo = { archKey, downloadUrl };
      }
      return;
    }
    // User skipped — flag so the renderer can show the blocking overlay
    vcRedistMissingInfo = { archKey, downloadUrl };
    return Promise.resolve();
  } else {
    // Installer not bundled — offer to download from conf.json URL
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Download & Install', 'Skip'],
      defaultId: 0,
      title: 'Microsoft Visual C++ Redistributable Required',
      message: `This application requires the Microsoft Visual C++ 2015-2022 Redistributable (${archKey}) runtime to execute local speech models.\n\nWould you like to download and install it automatically now (approx. 24MB)?`,
      cancelId: 1
    });

    if (choice === 0) {
      console.log(`[System] Downloading VC++ Redistributable (${archKey}) from: ${downloadUrl}`);

      return downloadUrlToFile(downloadUrl, redistTempPath)
        .then(async () => {
          console.log('[System] VC++ Redistributable download complete.');
          const installChoice = dialog.showMessageBoxSync({
            type: 'info',
            buttons: ['Run Installer Now', 'Later'],
            defaultId: 0,
            title: 'Download Complete',
            message: 'The Microsoft Visual C++ Redistributable installer was downloaded successfully. Would you like to run it now?'
          });
          if (installChoice === 0) {
            await launchInstaller(redistTempPath);
            // After installer closes, check if it actually completed
            if (!isVcRedistRegistryInstalled()) {
              console.warn('[System] Installer closed without completing — overlay will be shown.');
              vcRedistMissingInfo = { archKey, downloadUrl };
            }
            return;
          }
          // User clicked Later — flag so the overlay is shown when window loads
          console.log('[System] User deferred installer — overlay will be shown.');
          vcRedistMissingInfo = { archKey, downloadUrl };
        })
        .catch((err) => {
          console.error('[System] Failed to download VC++ Redistributable:', err);
          dialog.showErrorBox(
            'Download Failed',
            `Failed to download the VC++ Redistributable installer (${archKey}):\n${err.message}\n\nPlease install it manually from:\n${downloadUrl}`
          );
          // Even on download failure, flag the overlay so user knows it's still needed
          vcRedistMissingInfo = { archKey, downloadUrl };
        });
    }
    // User skipped — flag so the renderer can show the blocking overlay
    vcRedistMissingInfo = { archKey, downloadUrl };
    return Promise.resolve();
  }
}

function launchInstaller(exePath) {
  return new Promise((resolve) => {
    console.log(`[System] Launching VC++ Redistributable installer: ${exePath}`);
    try {
      // Minimize the application main window
      if (mainWindow) {
        mainWindow.minimize();
      }

      const child = spawn(exePath, [], {
        stdio: 'ignore'
      });

      child.on('close', (code) => {
        console.log(`[System] VC++ Redistributable installer process closed with code ${code}`);
        // Restore and focus the application window when setup completes
        if (mainWindow) {
          mainWindow.restore();
          mainWindow.focus();
        }
        resolve();
      });

      child.on('error', (err) => {
        console.error('[System] VC++ Redistributable installer process error:', err);
        if (mainWindow) {
          mainWindow.restore();
          mainWindow.focus();
        }
        resolve();
      });
    } catch (spawnErr) {
      console.error('[System] Failed to launch redistributable installer:', spawnErr);
      if (mainWindow) {
        mainWindow.restore();
        mainWindow.focus();
      }
      resolve();
    }
  });
}

// ----------------------------------------------------
// Auto-Granting Media Permissions inside Electron
// ----------------------------------------------------
app.whenReady().then(async () => {
  // Clean up any stale files from previous run on startup
  cleanupTempFiles();

  // Set up safe local media streaming protocol
  protocol.handle('media', (request) => {
    const rawUrl = request.url;
    // Decode url and extract path
    const filePath = decodeURIComponent(rawUrl.slice('media://'.length));
    return net.fetch(pathToFileURL(filePath).toString());
  });

  // Automatically grant microphone permissions to local window
  session.defaultSession.setPermissionCheckHandler((webContents, permission, requestingOrigin) => {
    if (permission === 'media' || permission === 'audioCapture') {
      return true; // Auto-grant check
    }
    return false;
  });

  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    if (permission === 'media' || permission === 'audioCapture') {
      callback(true); // Auto-grant request
    } else {
      callback(false);
    }
  });

  // Check and prompt for MSVC Redistributable on Windows before opening window
  await checkAndInstallMsvc();

  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  cleanupTempFiles();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  cleanupTempFiles();
});

// ----------------------------------------------------
// IPC Handler Mappings
// ----------------------------------------------------

// 1. Transcode audio file to Whisper-compatible format (16-bit PCM, Mono, 16000Hz WAV)
function transcodeToWhisperFormat(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .outputOptions([
        '-acodec pcm_s16le', // 16-bit PCM codec
        '-ac 1',             // Mono channel
        '-ar 16000'          // 16000Hz sampling rate
      ])
      .save(outputPath)
      .on('end', () => {
        console.log(`[FFmpeg] Transcoding complete: ${outputPath}`);
        resolve();
      })
      .on('error', (err) => {
        console.error('[FFmpeg] Transcoding failed:', err);
        reject(err);
      });
  });
}

// 2. Invoke local whisper.cpp executable for transcription
function transcribeWithWhisper(wavPath, language) {
  return new Promise((resolve, reject) => {
    const whisperCli = getAssetPath('bin', 'whisper', 'Release', 'whisper-cli.exe');
    const modelPath = getAssetPath('bin', 'whisper', 'Release', activeModel);

    if (!fs.existsSync(whisperCli)) {
      return reject(new Error(`Whisper executable not found at: ${whisperCli}`));
    }
    if (!fs.existsSync(modelPath)) {
      return reject(new Error(`Model file not found at: ${modelPath}`));
    }

    // Parameters: -m (model), -f (audio file), -nt (no timestamps), -np (no prints / clean output)
    const args = ['-m', modelPath, '-f', wavPath, '-nt', '-np'];
    if (language && language !== 'auto') {
      args.push('-l', language);
    }
    console.log(`[Whisper.cpp] Running: ${whisperCli} ${args.join(' ')}`);

    execFile(whisperCli, args, (err, stdout, stderr) => {
      if (err) {
        console.error('[Whisper.cpp] Execution error:', err);
        return reject(err);
      }
      console.log(`[Whisper.cpp] Transcription complete. Result: "${stdout.trim()}"`);
      resolve(stdout.trim());
    });
  });
}

// IPC: STT Transcribe File/Buffer Handler
ipcMain.handle('audio-stt', async (event, inputPath, language) => {
  const transOutPath = path.join(tmpDir, `transcoded_${Date.now()}.wav`);
  try {
    // 1. Transcode input audio
    await transcodeToWhisperFormat(inputPath, transOutPath);

    // 2. Run local transcription
    const transcript = await transcribeWithWhisper(transOutPath, language);

    // 3. Clean up transcoded file immediately
    try {
      if (fs.existsSync(transOutPath)) {
        fs.unlinkSync(transOutPath);
      }
    } catch (cleanErr) {
      console.warn('[Cleanup] Failed to remove transcode file:', cleanErr);
    }

    return { success: true, text: transcript };
  } catch (error) {
    console.error('[IPC STT Error]', error);
    // Cleanup on failure
    try {
      if (fs.existsSync(transOutPath)) {
        fs.unlinkSync(transOutPath);
      }
    } catch (e) { }
    return { success: false, error: error.message };
  }
});

// IPC: Save recorded blob chunks as a webm file
ipcMain.handle('save-mic-audio', async (event, bufferData) => {
  const micPath = path.join(tmpDir, `recording_${Date.now()}.webm`);
  try {
    const buffer = Buffer.from(bufferData);
    console.log(`[IPC save-mic-audio] Received buffer of size: ${buffer.length} bytes`);
    fs.writeFileSync(micPath, buffer);
    return { success: true, filePath: micPath };
  } catch (error) {
    console.error('[IPC Mic Save Error]', error);
    return { success: false, error: error.message };
  }
});

// IPC: TTS Speech Synthesis Handler using offline Piper TTS engine
ipcMain.handle('tts-synthesize', async (event, { text, voice, speed, silence, noiseScale, noiseW }) => {
  const synthOutPath = path.join(tmpDir, `synth_${Date.now()}.wav`);
  return new Promise((resolve) => {
    const voiceModel = voice || 'en_US-lessac-medium.onnx';
    const rate = speed || 1.0;
    const lengthScale = (1.0 / rate).toFixed(2);

    const sentenceSilence = silence !== undefined ? parseFloat(silence).toFixed(1) : '0.2';
    const noiseScaleFactor = noiseScale !== undefined ? parseFloat(noiseScale).toFixed(3) : '0.667';
    const noiseWFactor = noiseW !== undefined ? parseFloat(noiseW).toFixed(3) : '0.800';

    console.log(`[Piper TTS] Synthesizing text: "${text.substring(0, 30)}..." using voice model: ${voiceModel}`);
    console.log(`[Piper TTS] Parameters: length_scale=${lengthScale}, sentence_silence=${sentenceSilence}, noise_scale=${noiseScaleFactor}, noise_w=${noiseWFactor}`);

    const piperExe = getAssetPath('bin', 'piper', 'piper', 'piper.exe');
    const modelPath = getAssetPath('bin', 'piper', 'piper', voiceModel);

    if (!fs.existsSync(piperExe)) {
      return resolve({ success: false, error: `Piper engine executable not found at: ${piperExe}` });
    }
    if (!fs.existsSync(modelPath)) {
      return resolve({ success: false, error: `ONNX voice model file not found at: ${modelPath}` });
    }

    // Parameters: -m (model file), -f (output wav file), --length_scale, --sentence_silence, --noise_scale, --noise_w
    const args = [
      '-m', modelPath,
      '-f', synthOutPath,
      '--length_scale', lengthScale,
      '--sentence_silence', sentenceSilence,
      '--noise_scale', noiseScaleFactor,
      '--noise_w', noiseWFactor
    ];
    console.log(`[Piper TTS] Spawning: ${piperExe} ${args.join(' ')}`);

    const child = spawn(piperExe, args, { cwd: path.dirname(piperExe) });

    // Write text to stdin encoded in UTF-8
    child.stdin.write(text, 'utf8');
    child.stdin.end();

    let stderrData = '';
    child.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    child.on('close', (code) => {
      if (code === 0) {
        console.log(`[Piper TTS] Synthesis complete: ${synthOutPath}`);
        const mediaUrl = `media://${encodeURIComponent(synthOutPath)}`;
        resolve({ success: true, audioUrl: mediaUrl, localPath: synthOutPath });
      } else {
        console.error('[Piper TTS] Execution failed:', code, stderrData);
        resolve({ success: false, error: `Piper process failed (exit code ${code}): ${stderrData}` });
      }
    });

    child.on('error', (err) => {
      console.error('[Piper TTS] Spawn error:', err);
      resolve({ success: false, error: `Failed to initiate Piper process: ${err.message}` });
    });
  });
});

// IPC: Copy text to system clipboard (resilient OS-level API)
ipcMain.handle('copy-to-clipboard', async (event, text) => {
  try {
    clipboard.writeText(text);
    return { success: true };
  } catch (err) {
    console.error('[IPC Clipboard Error]', err);
    return { success: false, error: err.message };
  }
});

// IPC: Read text from system clipboard (resilient OS-level API)
ipcMain.handle('read-clipboard', async () => {
  try {
    const text = clipboard.readText();
    return { success: true, text };
  } catch (err) {
    console.error('[IPC read-clipboard Error]', err);
    return { success: false, error: err.message };
  }
});

// IPC: Check core dependencies and runtime status
ipcMain.handle('check-dependencies', async () => {
  const localFfmpeg = getAssetPath('bin', 'ffmpeg', 'bin', 'ffmpeg.exe');
  const piperExe = getAssetPath('bin', 'piper', 'piper', 'piper.exe');
  const whisperCli = getAssetPath('bin', 'whisper', 'Release', 'whisper-cli.exe');
  
  const ffmpegVal = fs.existsSync(localFfmpeg);
  const piperVal = fs.existsSync(piperExe);
  const whisperVal = fs.existsSync(whisperCli);

  console.log('[Dependencies Check Log]', {
    ffmpeg: ffmpegVal,
    ffmpegExePath: localFfmpeg,
    piperEngine: piperVal,
    piperExePath: piperExe,
    whisperEngine: whisperVal,
    whisperCliPath: whisperCli
  });

  return {
    ffmpeg: ffmpegVal,
    piperEngine: piperVal,
    whisperEngine: whisperVal
  };
});

// IPC: Read Uploaded Text File content
ipcMain.handle('read-text-file', async (event, filePath) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File does not exist' };
    }
    const content = fs.readFileSync(filePath, 'utf8');
    return { success: true, text: content };
  } catch (error) {
    console.error('[IPC File Read Error]', error);
    return { success: false, error: error.message };
  }
});

// IPC: Delete a file (for renderer-initiated audio cleanups)
ipcMain.handle('delete-file', async (event, filePath) => {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      return { success: true };
    }
    return { success: false, error: 'File already deleted' };
  } catch (error) {
    console.warn('[IPC Delete File Warning]', error);
    return { success: false, error: error.message };
  }
});

// Helper: Update a component's config in the writeable override config file
function updateLocalPackageJson(component, url, version) {
  try {
    const overridePath = getComponentsConfigPath();
    
    // Ensure parent directory exists (especially for portable bin/ folder)
    const parentDir = path.dirname(overridePath);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    let data = {};
    if (fs.existsSync(overridePath)) {
      try {
        data = JSON.parse(fs.readFileSync(overridePath, 'utf8'));
      } catch (e) {
        console.warn(`[updateLocalPackageJson] Corrupt override file found, resetting:`, e.message);
      }
    }

    if (!data[component]) data[component] = {};
    data[component].url = url;
    data[component].version = version;

    fs.writeFileSync(overridePath, JSON.stringify(data, null, 2), 'utf8');
    console.log(`[installed_components.json] Update successful for ${component} to version ${version}`);
  } catch (err) {
    console.error(`[installed_components.json] Update failed for ${component}:`, err);
  }
}

// Helper: Check if remote version is larger than local version
function isVersionNewer(local, remote) {
  const localClean = String(local).split('-')[0];
  const remoteClean = String(remote).split('-')[0];

  // If either is not standard numeric dot-separated format, treat as plain text strings
  const hasLocalNumbers = localClean.split('.').length > 0 && localClean.split('.').every(x => x.trim() !== '' && !isNaN(Number(x)));
  const hasRemoteNumbers = remoteClean.split('.').length > 0 && remoteClean.split('.').every(x => x.trim() !== '' && !isNaN(Number(x)));

  if (!hasLocalNumbers || !hasRemoteNumbers) {
    // If they are identical text strings, no update is needed.
    if (String(local).trim().toLowerCase() === String(remote).trim().toLowerCase()) {
      return false;
    }
    // If they are different text strings, flag update required (return true)
    return true;
  }

  // 1. Compare core semantic version parts (e.g. 2023.11.14)
  const localParts = localClean.split('.').map(Number);
  const remoteParts = remoteClean.split('.').map(Number);
  for (let i = 0; i < Math.max(localParts.length, remoteParts.length); i++) {
    const localPart = localParts[i] || 0;
    const remotePart = remoteParts[i] || 0;
    if (remotePart > localPart) return true;
    if (localPart > remotePart) return false;
  }
  
  // 2. If core versions are identical, compare build tags after '-' if they exist
  const localSplit = String(local).split('-');
  const remoteSplit = String(remote).split('-');
  
  const localSuffix = localSplit[1];
  const remoteSuffix = remoteSplit[1];
  
  if (localSuffix !== undefined && remoteSuffix !== undefined) {
    if (localSuffix.trim().toLowerCase() === remoteSuffix.trim().toLowerCase()) {
      return false;
    }
    const localNum = Number(localSuffix);
    const remoteNum = Number(remoteSuffix);
    if (!isNaN(localNum) && !isNaN(remoteNum)) {
      return remoteNum > localNum;
    }
    // Suffixes are text strings and they differ: flag update required
    return true;
  }
  
  // If remote has a suffix but local doesn't, remote is newer (e.g. 2023.11.14-1 > 2023.11.14)
  if (localSuffix === undefined && remoteSuffix !== undefined) {
    return true;
  }
  
  return false;
}

// IPC: Check for updates online from GitHub conf.json
ipcMain.handle('check-for-updates', async () => {
  const localConf = initConf();
  const localVersion = (localConf.app && localConf.app.version) || '0.0.0';
  
  // 1. Get binary presence statuses
  const localFfmpeg = getAssetPath('bin', 'ffmpeg', 'bin', 'ffmpeg.exe');
  const piperExe = getAssetPath('bin', 'piper', 'piper', 'piper.exe');
  const whisperCli = getAssetPath('bin', 'whisper', 'Release', 'whisper-cli.exe');
  
  const ffmpegInstalled = fs.existsSync(localFfmpeg);
  const piperInstalled = fs.existsSync(piperExe);
  const whisperInstalled = fs.existsSync(whisperCli);

  // 2. Get local component versions via conf.json (single source of truth)
  const getLocalComponentVersion = (name, installed) => {
    if (!installed) return 'Not Installed';
    const compConfig = getLocalComponentConfig(name);
    return (compConfig && compConfig.version) || 'latest';
  };

  const ffmpegLocalVersion = getLocalComponentVersion('ffmpeg', ffmpegInstalled);
  const piperLocalVersion = getLocalComponentVersion('piper', piperInstalled);
  const whisperLocalVersion = getLocalComponentVersion('whisper', whisperInstalled);

  try {
    // 3. Fetch remote package.json (for app remoteVersion) + remote conf.json (for component URLs) in parallel
    const [pkgResponse, confResponse] = await Promise.all([
      fetch('https://raw.githubusercontent.com/tinwinaung/SpeechBoleh/main/package.json'),
      fetch('https://raw.githubusercontent.com/tinwinaung/SpeechBoleh/main/conf.json')
    ]);
    if (!pkgResponse.ok) {
      throw new Error(`Failed to fetch online package.json (status ${pkgResponse.status})`);
    }
    const pkgData = await pkgResponse.json();
    const remoteVersion = pkgData.version || null;
    if (!remoteVersion) {
      throw new Error('Version field not found in remote package.json');
    }
    // conf.json provides component download URLs; fall back to empty object if unavailable
    const data = confResponse.ok ? await confResponse.json() : {};

    const appUpdateAvailable = isVersionNewer(localVersion, remoteVersion);

    // 4. Get remote component configs from conf.json
    const getRemoteComponentData = (name, localVer) => {
      const remoteData = (data.pkg && data.pkg[name]) || { version: 'latest', url: '' };
      const remoteVer = remoteData.version || 'latest';
      const url = remoteData.url || '';
      
      let updateAvailable = false;
      if (localVer === 'Not Installed') {
        updateAvailable = true;
      } else if (localVer === 'latest' && remoteVer === 'latest') {
        updateAvailable = false;
      } else if (localVer !== 'latest' && remoteVer === 'latest') {
        // Local version is number, online version is latest
        updateAvailable = true;
      } else if (localVer === 'latest' && remoteVer !== 'latest') {
        // Local version is latest, online version is number
        updateAvailable = true;
      } else {
        // Both local and remote are version numbers
        updateAvailable = isVersionNewer(localVer, remoteVer);
      }

      return {
        local: localVer,
        remote: remoteVer,
        updateAvailable,
        url
      };
    };

    const result = {
      success: true,
      components: {
        app: {
          local: localVersion,
          remote: remoteVersion,
          updateAvailable: appUpdateAvailable,
          url: 'https://github.com/tinwinaung/SpeechBoleh/releases'
        },
        ffmpeg: getRemoteComponentData('ffmpeg', ffmpegLocalVersion),
        piper: getRemoteComponentData('piper', piperLocalVersion),
        whisper: getRemoteComponentData('whisper', whisperLocalVersion)
      }
    };

    return result;
  } catch (err) {
    console.error('[Update Check Error]', err);
    return { success: false, error: err.message };
  }
});

// IPC: Open external link in default browser
ipcMain.handle('open-external-url', async (event, url) => {
  try {
    shell.openExternal(url);
    return { success: true };
  } catch (err) {
    console.error('Failed to open external URL:', err);
    return { success: false, error: err.message };
  }
});

// IPC: Get local app version from package.json
ipcMain.handle('get-app-version', () => {
  return app.getVersion();
});

// IPC: Get downloaded Piper ONNX models inside the bin path for TTS dropdown populate
ipcMain.handle('get-voices', async () => {
  try {
    const piperBinDir = getAssetPath('bin', 'piper', 'piper');
    if (!fs.existsSync(piperBinDir)) return [];

    const files = fs.readdirSync(piperBinDir);
    return files.filter(f => f.endsWith('.onnx'));
  } catch (err) {
    console.error('[IPC get-voices Error]', err);
    return [];
  }
});

// IPC: Get downloaded Whisper models inside the bin path
ipcMain.handle('get-available-models', async () => {
  try {
    const whisperBinDir = getAssetPath('bin', 'whisper', 'Release');
    if (!fs.existsSync(whisperBinDir)) return [];

    const files = fs.readdirSync(whisperBinDir);
    return files.filter(f => f.endsWith('.bin') && f.startsWith('ggml-'));
  } catch (err) {
    console.error('[IPC get-available-models Error]', err);
    return [];
  }
});

// IPC: Return the full Whisper model list from conf.json
ipcMain.handle('get-whisper-models', () => whisperModels);

// IPC: Return the full Piper voice list from conf.json
ipcMain.handle('get-piper-voices', () => piperVoices);

// IPC: Set current active model
ipcMain.handle('set-active-model', async (event, modelName) => {
  activeModel = modelName;
  console.log(`[Whisper.cpp] Active model switched to: ${activeModel}`);
  return { success: true, activeModel };
});

// IPC: Download model from Hugging Face with progress tracking
ipcMain.handle('download-model', async (event, modelName) => {
  const whisperBinDir = getAssetPath('bin', 'whisper', 'Release');
  const destPath = path.join(whisperBinDir, modelName);

  // Resolve download URL from conf.json (single source of truth)
  const modelConf = whisperModels.find(m => m.file === modelName);
  if (!modelConf?.url) {
    return { success: false, error: `No download URL configured for model: ${modelName}` };
  }
  const url = modelConf.url;

  if (!fs.existsSync(whisperBinDir)) {
    fs.mkdirSync(whisperBinDir, { recursive: true });
  }

  return new Promise((resolve) => {
    console.log(`[Model Downloader] Starting download for: ${modelName}`);
    const tempDestPath = destPath + '.tmp';
    const file = fs.createWriteStream(tempDestPath);

    function startDownload(downloadUrl) {
      const client = downloadUrl.startsWith('https') ? https : http;
      const parsedUrl = new URL(downloadUrl);
      const options = {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      };

      const request = client.get(options, (response) => {
        // Handle redirects (Hugging Face redirects download links with 301, 302, 303, 307, or 308)
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          const redirectUrl = new URL(response.headers.location, downloadUrl).toString();
          console.log(`[Model Downloader] Following redirect to: ${redirectUrl}`);
          startDownload(redirectUrl);
          return;
        }

        if (response.statusCode !== 200) {
          file.close();
          try {
            if (fs.existsSync(tempDestPath)) fs.unlinkSync(tempDestPath);
          } catch (unlinkErr) {
            console.warn('[Model Downloader] Failed to delete temp file:', unlinkErr.message);
          }
          return resolve({ success: false, error: `Server returned status code: ${response.statusCode}` });
        }

        const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
        let downloadedBytes = 0;

        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          // Send progress updates to the renderer process
          if (mainWindow) {
            mainWindow.webContents.send('download-progress', {
              modelName,
              downloaded: downloadedBytes,
              total: totalBytes,
              percentage: totalBytes ? Math.round((downloadedBytes / totalBytes) * 100) : 0
            });
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          try {
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
            fs.renameSync(tempDestPath, destPath);
            console.log(`[Model Downloader] Successfully downloaded and saved model to: ${destPath}`);
            resolve({ success: true });
          } catch (renameErr) {
            console.error('[Model Downloader] Failed to rename temp file:', renameErr);
            resolve({ success: false, error: renameErr.message });
          }
        });
      });

      request.on('error', (err) => {
        file.close();
        try {
          if (fs.existsSync(tempDestPath)) fs.unlinkSync(tempDestPath);
        } catch (unlinkErr) {
          console.warn('[Model Downloader] Failed to delete temp file on error:', unlinkErr.message);
        }
        console.error('[Model Downloader] Request error:', err);
        resolve({ success: false, error: err.message });
      });
    }

    startDownload(url);
  });
});

// Helper to download files (with redirect support, user agent, protocol-agnostic, and progress)
function downloadUrlToFile(downloadUrl, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    const tempDestPath = destPath + '.tmp';
    let file = fs.createWriteStream(tempDestPath);
    let requestObj = null;

    function startDownload(url) {
      const client = url.startsWith('https') ? https : http;
      const parsedUrl = new URL(url);
      
      const options = {
        protocol: parsedUrl.protocol,
        hostname: parsedUrl.hostname,
        port: parsedUrl.port,
        path: parsedUrl.pathname + parsedUrl.search,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        }
      };

      requestObj = client.get(options, (response) => {
        if ([301, 302, 303, 307, 308].includes(response.statusCode)) {
          const redirectUrl = new URL(response.headers.location, url).toString();
          startDownload(redirectUrl);
          return;
        }
        if (response.statusCode !== 200) {
          file.close();
          try {
            if (fs.existsSync(tempDestPath)) fs.unlinkSync(tempDestPath);
          } catch (unlinkErr) {
            console.warn('[Downloader] Failed to delete temp file:', unlinkErr.message);
          }
          return reject(new Error(`Server returned ${response.statusCode}`));
        }

        const totalBytes = parseInt(response.headers['content-length'], 10) || 0;
        let downloadedBytes = 0;

        response.on('data', (chunk) => {
          downloadedBytes += chunk.length;
          if (onProgress) {
            onProgress(downloadedBytes, totalBytes);
          }
        });

        response.pipe(file);

        file.on('finish', () => {
          file.close();
          try {
            // Try atomic rename first (works even when destPath already exists on same drive)
            fs.renameSync(tempDestPath, destPath);
            resolve();
          } catch (renameErr) {
            // Rename may fail if destination is locked by a previous installer process.
            // Fall back to copy + silent temp cleanup.
            try {
              fs.copyFileSync(tempDestPath, destPath);
              try { fs.unlinkSync(tempDestPath); } catch (e) { /* ignore temp cleanup failure */ }
              resolve();
            } catch (copyErr) {
              reject(copyErr);
            }
          }
        });
      });

      requestObj.on('error', (err) => {
        file.close();
        try {
          if (fs.existsSync(tempDestPath)) fs.unlinkSync(tempDestPath);
        } catch (unlinkErr) {
          console.warn('[Downloader] Failed to delete temp file on error:', unlinkErr.message);
        }
        reject(err);
      });
    }

    startDownload(downloadUrl);
  });
}

// IPC: Download Piper voice model (.onnx and .onnx.json) from Hugging Face
ipcMain.handle('download-voice-model', async (event, voiceName) => {
  const piperBinDir = getAssetPath('bin', 'piper', 'piper');

  // Look up the voice entry from conf.json
  const voiceEntry = piperVoices.find(v => v.file === voiceName);
  if (!voiceEntry || !voiceEntry.url) {
    return { success: false, error: `No download URL configured for voice: ${voiceName}` };
  }

  const onnxUrl = voiceEntry.url;
  const jsonUrl = `${voiceEntry.url}.json`;

  const onnxDest = path.join(piperBinDir, voiceName);
  const jsonDest = path.join(piperBinDir, `${voiceName}.json`);

  if (!fs.existsSync(piperBinDir)) {
    fs.mkdirSync(piperBinDir, { recursive: true });
  }

  try {
    console.log(`[Piper Downloader] Downloading ONNX model: ${voiceName} from ${onnxUrl}`);
    // Download ONNX model (large file — track progress)
    await downloadUrlToFile(onnxUrl, onnxDest, (downloaded, total) => {
      if (mainWindow) {
        mainWindow.webContents.send('voice-download-progress', {
          voiceName,
          downloaded,
          total,
          percentage: total ? Math.round((downloaded / total) * 100) : 0
        });
      }
    });

    console.log(`[Piper Downloader] Downloading config JSON for: ${voiceName}`);
    // Download ONNX.json configuration file (small file)
    await downloadUrlToFile(jsonUrl, jsonDest);

    console.log(`[Piper Downloader] Voice ${voiceName} downloaded successfully.`);
    return { success: true };
  } catch (err) {
    console.error('[Piper Downloader] Failed:', err);
    // Clean up partial files
    if (fs.existsSync(onnxDest)) fs.unlinkSync(onnxDest);
    if (fs.existsSync(jsonDest)) fs.unlinkSync(jsonDest);
    return { success: false, error: err.message };
  }
});

// IPC: Download latest FFmpeg build from gyan.dev
ipcMain.handle('download-ffmpeg', async (event, customUrl, customVersion) => {
  const ffmpegBaseDir = getAssetPath('bin', 'ffmpeg');
  const ffmpegBaseDirBak = ffmpegBaseDir + '_bak';
  const ffmpegZipDest = path.join(tmpDir, 'ffmpeg.zip');
  const extractTempDir = path.join(tmpDir, 'ffmpeg_extracted');
  const ffmpegTargetDir = getAssetPath('bin', 'ffmpeg', 'bin');
  const ffmpegFinalPath = path.join(ffmpegTargetDir, 'ffmpeg.exe');

  // Load default URL from local package.json if available
  const pkgConfig = getLocalComponentConfig('ffmpeg');
  const ffmpegUrl = pkgConfig ? pkgConfig.url : 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';
  const ffmpegFallbackUrl = 'https://github.com/BtbN/FFmpeg-Builds/releases/download/latest/ffmpeg-master-latest-win64-gpl.zip';

  let backedUp = false;
  let downloadLink;
  let downloadVersion;
  let resolvedOnline = false;

  if (customUrl) {
    downloadLink = customUrl;
    downloadVersion = customVersion || 'latest';
  } else {
    const resolved = await getComponentDownloadUrl('ffmpeg', ffmpegUrl, 'latest');
    downloadLink = resolved.url;
    downloadVersion = resolved.version;
    if (resolved.source === 'online') {
      resolvedOnline = true;
    }
  }

  try {
    // 1. Ensure temp directory exists
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    // 2. Perform backup of the existing folder
    if (fs.existsSync(ffmpegBaseDir)) {
      sendStatus('Backing up existing FFmpeg configuration...', 0);
      if (fs.existsSync(ffmpegBaseDirBak)) {
        fs.rmSync(ffmpegBaseDirBak, { recursive: true, force: true });
      }
      fs.renameSync(ffmpegBaseDir, ffmpegBaseDirBak);
      backedUp = true;
    }

    // 3. Ensure target directory exists for new download
    if (!fs.existsSync(ffmpegTargetDir)) fs.mkdirSync(ffmpegTargetDir, { recursive: true });

    // 4. Clean up any previous extraction directories
    if (fs.existsSync(extractTempDir)) {
      fs.rmSync(extractTempDir, { recursive: true, force: true });
    }

    // Send initial status update
    sendStatus('Downloading latest FFmpeg essentials release (approx. 90MB)...', 0);

    // 5. Download the zip file with primary/fallback try-catch
    try {
      await downloadUrlToFile(downloadLink, ffmpegZipDest, (downloaded, total) => {
        const percentage = total ? Math.round((downloaded / total) * 100) : 0;
        sendStatus(`Downloading FFmpeg archive: ${percentage}%`, percentage);
      });
    } catch (primaryErr) {
      if (customUrl) {
        throw primaryErr; // Propagate error for specific custom URL downloads
      }
      console.warn('[FFmpeg Downloader] Primary download link refused connection. Attempting backup mirror...', primaryErr);
      sendStatus('Primary mirror connection refused. Accessing backup download mirror (approx. 100MB)...', 0);
      
      await downloadUrlToFile(ffmpegFallbackUrl, ffmpegZipDest, (downloaded, total) => {
        const percentage = total ? Math.round((downloaded / total) * 100) : 0;
        sendStatus(`Downloading FFmpeg (Backup Mirror): ${percentage}%`, percentage);
      });
    }

    // 6. Extract the zip file using PowerShell Expand-Archive (native to Windows)
    sendStatus('Extracting zip archive using PowerShell...', 100);
    const extractCmd = `powershell -Command "Expand-Archive -Path '${ffmpegZipDest}' -DestinationPath '${extractTempDir}' -Force"`;
    
    await new Promise((resolve, reject) => {
      exec(extractCmd, (err, stdout, stderr) => {
        if (err) {
          console.error('[FFmpeg Extraction Error]', err, stderr);
          reject(new Error(`Extraction failed: ${stderr || err.message}`));
        } else {
          resolve();
        }
      });
    });

    // 7. Find ffmpeg.exe inside the extracted folder recursively
    sendStatus('Searching for ffmpeg.exe in extracted folder...', 100);
    const foundExePath = findFileRecursively(extractTempDir, 'ffmpeg.exe');
    if (!foundExePath) {
      throw new Error('Could not locate ffmpeg.exe inside the extracted archive.');
    }

    // 8. Copy ffmpeg.exe to final destination
    sendStatus('Deploying executable to bin/ffmpeg/bin/...', 100);
    fs.copyFileSync(foundExePath, ffmpegFinalPath);

    // 9. Verify file exists
    if (fs.existsSync(ffmpegFinalPath)) {
      sendStatus('Cleaning up temporary setup files...', 100);
      try {
        if (fs.existsSync(ffmpegZipDest)) fs.unlinkSync(ffmpegZipDest);
        if (fs.existsSync(extractTempDir)) fs.rmSync(extractTempDir, { recursive: true, force: true });
        // Delete backup folder now that installation succeeded
        if (backedUp && fs.existsSync(ffmpegBaseDirBak)) {
          fs.rmSync(ffmpegBaseDirBak, { recursive: true, force: true });
        }
      } catch (cleanupErr) {
        console.warn('[FFmpeg Setup Cleanup Warning]', cleanupErr);
      }
      // Re-configure FFmpeg path globally for fluent-ffmpeg now that it exists locally
      configureFfmpeg();
      if (customUrl || resolvedOnline) {
        updateLocalPackageJson('ffmpeg', downloadLink, downloadVersion);
      }
      return { success: true, path: ffmpegFinalPath };
    } else {
      throw new Error('Failed to copy ffmpeg.exe to destination.');
    }

  } catch (error) {
    console.error('[FFmpeg Download/Setup Error]', error);
    
    // Rollback phase
    if (backedUp && fs.existsSync(ffmpegBaseDirBak)) {
      sendStatus('Installation failed. Restoring original FFmpeg backup...', 100);
      try {
        if (fs.existsSync(ffmpegBaseDir)) {
          fs.rmSync(ffmpegBaseDir, { recursive: true, force: true });
        }
        fs.renameSync(ffmpegBaseDirBak, ffmpegBaseDir);
      } catch (restoreErr) {
        console.error('[FFmpeg Rollback Restore Error]', restoreErr);
      }
    }
    
    return { success: false, error: error.message };
  }

  function sendStatus(msg, progress = 0) {
    if (mainWindow) {
      mainWindow.webContents.send('ffmpeg-download-progress', { msg, progress });
    }
  }
});

// Helper: Recursively find a file by name
function findFileRecursively(dir, fileName) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const fullPath = path.join(dir, file);
    const stat = fs.statSync(fullPath);
    if (stat.isDirectory()) {
      const found = findFileRecursively(fullPath, fileName);
      if (found) return found;
    } else if (file.toLowerCase() === fileName.toLowerCase()) {
      return fullPath;
    }
  }
  return null;
}

// Helper: Recursively find and copy files with specified extensions (for restoring models/voices)
function copyFilesWithExtension(srcDir, destDir, extensions) {
  if (!fs.existsSync(srcDir)) return;
  if (!fs.existsSync(destDir)) {
    try {
      fs.mkdirSync(destDir, { recursive: true });
    } catch (e) {
      console.error(`[Backup Restore Error] Failed to create destination directory ${destDir}:`, e);
      return;
    }
  }

  let files = [];
  try {
    files = fs.readdirSync(srcDir);
  } catch (err) {
    console.error(`[Backup Restore Error] Failed to read source directory ${srcDir}:`, err);
    return;
  }

  for (const file of files) {
    const srcPath = path.join(srcDir, file);
    try {
      const stat = fs.statSync(srcPath);
      if (stat.isDirectory()) {
        copyFilesWithExtension(srcPath, destDir, extensions);
      } else {
        const ext = path.extname(file).toLowerCase();
        if (extensions.includes(ext)) {
          const destPath = path.join(destDir, file);
          try {
            fs.copyFileSync(srcPath, destPath);
            console.log(`[Backup Restore] Restored model/voice asset: ${file}`);
          } catch (err) {
            console.error(`[Backup Restore Error] Failed to restore asset ${file}:`, err);
          }
        }
      }
    } catch (statErr) {
      console.error(`[Backup Restore Error] Failed to get stats for ${srcPath}:`, statErr);
    }
  }
}

// IPC: Download Piper Engine (C++ build)
ipcMain.handle('download-piper', async (event, customUrl, customVersion) => {
  const piperTargetDir = getAssetPath('bin', 'piper');
  const piperTargetDirBak = piperTargetDir + '_bak';
  const piperZipDest = path.join(tmpDir, 'piper.zip');
  const piperFinalExe = path.join(piperTargetDir, 'piper', 'piper.exe');
  // Load default URL from local package.json if available
  const pkgConfig = getLocalComponentConfig('piper');
  const url = pkgConfig ? pkgConfig.url : 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';

  let backedUp = false;
  let downloadLink;
  let downloadVersion;
  let resolvedOnline = false;

  if (customUrl) {
    downloadLink = customUrl;
    downloadVersion = customVersion || 'latest';
  } else {
    const resolved = await getComponentDownloadUrl('piper', url, 'latest');
    downloadLink = resolved.url;
    downloadVersion = resolved.version;
    if (resolved.source === 'online') {
      resolvedOnline = true;
    }
  }

  try {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    // 1. Perform backup of the existing folder
    if (fs.existsSync(piperTargetDir)) {
      sendStatus('Backing up existing Piper configuration...', 0);
      if (fs.existsSync(piperTargetDirBak)) {
        fs.rmSync(piperTargetDirBak, { recursive: true, force: true });
      }
      fs.renameSync(piperTargetDir, piperTargetDirBak);
      backedUp = true;
    }

    // 2. Ensure target directory exists for new download
    if (!fs.existsSync(piperTargetDir)) fs.mkdirSync(piperTargetDir, { recursive: true });

    sendStatus('Downloading Piper Neural TTS Engine (approx. 22MB)...', 0);
    await downloadUrlToFile(downloadLink, piperZipDest, (downloaded, total) => {
      const percentage = total ? Math.round((downloaded / total) * 100) : 0;
      sendStatus(`Downloading Piper: ${percentage}%`, percentage);
    });

    sendStatus('Extracting Piper engine archive...', 100);
    const extractCmd = `powershell -Command "Expand-Archive -Path '${piperZipDest}' -DestinationPath '${piperTargetDir}' -Force"`;
    await new Promise((resolve, reject) => {
      exec(extractCmd, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve();
      });
    });

    if (fs.existsSync(piperFinalExe)) {
      sendStatus('Restoring voice models from backup...', 100);
      // Restore voice models (.onnx and .json) from backup folder to avoid redownloading them
      if (backedUp && fs.existsSync(piperTargetDirBak)) {
        const newVoiceDir = path.join(piperTargetDir, 'piper');
        copyFilesWithExtension(piperTargetDirBak, newVoiceDir, ['.onnx', '.json']);
      }

      sendStatus('Cleaning up temp files...', 100);
      if (fs.existsSync(piperZipDest)) fs.unlinkSync(piperZipDest);
      // Delete backup folder now that installation succeeded
      if (backedUp && fs.existsSync(piperTargetDirBak)) {
        fs.rmSync(piperTargetDirBak, { recursive: true, force: true });
      }
      if (customUrl || resolvedOnline) {
        updateLocalPackageJson('piper', downloadLink, downloadVersion);
      }
      return { success: true, path: piperFinalExe };
    } else {
      throw new Error('Failed to configure piper.exe at destination.');
    }
  } catch (error) {
    console.error('[Piper Engine Download Error]', error);
    
    // Rollback phase
    if (backedUp && fs.existsSync(piperTargetDirBak)) {
      sendStatus('Installation failed. Restoring original Piper backup...', 100);
      try {
        if (fs.existsSync(piperTargetDir)) {
          fs.rmSync(piperTargetDir, { recursive: true, force: true });
        }
        fs.renameSync(piperTargetDirBak, piperTargetDir);
      } catch (restoreErr) {
        console.error('[Piper Rollback Restore Error]', restoreErr);
      }
    }
    
    return { success: false, error: error.message };
  }

  function sendStatus(msg, progress = 0) {
    if (mainWindow) {
      mainWindow.webContents.send('piper-download-progress', { msg, progress });
    }
  }
});

// IPC: Download Whisper.cpp Engine (C++ build)
ipcMain.handle('download-whisper-engine', async (event, customUrl, customVersion) => {
  const whisperBaseDir = getAssetPath('bin', 'whisper');
  const whisperBaseDirBak = whisperBaseDir + '_bak';
  const whisperZipDest = path.join(tmpDir, 'whisper.zip');
  const whisperTargetDir = getAssetPath('bin', 'whisper', 'Release');
  const whisperFinalExe = path.join(whisperTargetDir, 'whisper-cli.exe');
  // Load default URL from local package.json if available
  const pkgConfig = getLocalComponentConfig('whisper');
  const url = pkgConfig ? pkgConfig.url : 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip';

  let backedUp = false;
  let downloadLink;
  let downloadVersion;
  let resolvedOnline = false;

  if (customUrl) {
    downloadLink = customUrl;
    downloadVersion = customVersion || 'latest';
  } else {
    const resolved = await getComponentDownloadUrl('whisper', url, 'latest');
    downloadLink = resolved.url;
    downloadVersion = resolved.version;
    if (resolved.source === 'online') {
      resolvedOnline = true;
    }
  }

  try {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

    // 1. Perform backup of the existing folder
    if (fs.existsSync(whisperBaseDir)) {
      sendStatus('Backing up existing Whisper configuration...', 0);
      if (fs.existsSync(whisperBaseDirBak)) {
        fs.rmSync(whisperBaseDirBak, { recursive: true, force: true });
      }
      fs.renameSync(whisperBaseDir, whisperBaseDirBak);
      backedUp = true;
    }

    // 2. Ensure target directory exists for new download
    if (!fs.existsSync(whisperTargetDir)) fs.mkdirSync(whisperTargetDir, { recursive: true });

    sendStatus('Downloading Whisper.cpp Engine (approx. 8MB)...', 0);
    await downloadUrlToFile(downloadLink, whisperZipDest, (downloaded, total) => {
      const percentage = total ? Math.round((downloaded / total) * 100) : 0;
      sendStatus(`Downloading Whisper: ${percentage}%`, percentage);
    });

    sendStatus('Extracting Whisper engine archive...', 100);
    const extractCmd = `powershell -Command "Expand-Archive -Path '${whisperZipDest}' -DestinationPath '${whisperTargetDir}' -Force"`;
    await new Promise((resolve, reject) => {
      exec(extractCmd, (err, stdout, stderr) => {
        if (err) reject(err);
        else resolve();
      });
    });

    // Handle zip nesting: if archive extracted a nested 'Release' folder, move files up
    const nestedReleaseDir = path.join(whisperTargetDir, 'Release');
    if (fs.existsSync(nestedReleaseDir) && fs.statSync(nestedReleaseDir).isDirectory()) {
      const files = fs.readdirSync(nestedReleaseDir);
      for (const file of files) {
        const srcPath = path.join(nestedReleaseDir, file);
        const destPathFile = path.join(whisperTargetDir, file);
        if (fs.existsSync(destPathFile)) {
          const stat = fs.statSync(destPathFile);
          if (stat.isDirectory()) {
            fs.rmSync(destPathFile, { recursive: true, force: true });
          } else {
            fs.unlinkSync(destPathFile);
          }
        }
        fs.renameSync(srcPath, destPathFile);
      }
      try {
        fs.rmdirSync(nestedReleaseDir);
      } catch (rmDirErr) {
        console.warn('[Whisper Cleanup Warning] Failed to delete nested Release directory:', rmDirErr);
      }
    }

    // Handle binary naming options:
    // In newer releases (v1.9.0+), whisper-cli.exe is precompiled inside the zip, and main.exe is just a deprecation warning.
    // We only rename main.exe to whisper-cli.exe if whisper-cli.exe does not exist.
    const mainExePath = path.join(whisperTargetDir, 'main.exe');
    if (fs.existsSync(mainExePath)) {
      if (!fs.existsSync(whisperFinalExe)) {
        fs.renameSync(mainExePath, whisperFinalExe);
      } else {
        // Delete main.exe warning wrapper as we don't need it
        try {
          fs.unlinkSync(mainExePath);
        } catch (e) {}
      }
    }

    if (fs.existsSync(whisperFinalExe)) {
      sendStatus('Restoring Whisper models from backup...', 100);
      // Restore whisper models (.bin) from backup folder to avoid redownloading them
      if (backedUp && fs.existsSync(whisperBaseDirBak)) {
        const newModelDir = path.join(whisperBaseDir, 'Release');
        copyFilesWithExtension(whisperBaseDirBak, newModelDir, ['.bin']);
      }

      sendStatus('Cleaning up temp files...', 100);
      if (fs.existsSync(whisperZipDest)) fs.unlinkSync(whisperZipDest);
      // Delete backup folder now that installation succeeded
      if (backedUp && fs.existsSync(whisperBaseDirBak)) {
        fs.rmSync(whisperBaseDirBak, { recursive: true, force: true });
      }
      if (customUrl || resolvedOnline) {
        updateLocalPackageJson('whisper', downloadLink, downloadVersion);
      }
      return { success: true, path: whisperFinalExe };
    } else {
      throw new Error('Failed to configure whisper-cli.exe at destination.');
    }
  } catch (error) {
    console.error('[Whisper Engine Download Error]', error);
    
    // Rollback phase
    if (backedUp && fs.existsSync(whisperBaseDirBak)) {
      sendStatus('Installation failed. Restoring original Whisper backup...', 100);
      try {
        if (fs.existsSync(whisperBaseDir)) {
          fs.rmSync(whisperBaseDir, { recursive: true, force: true });
        }
        fs.renameSync(whisperBaseDirBak, whisperBaseDir);
      } catch (restoreErr) {
        console.error('[Whisper Rollback Restore Error]', restoreErr);
      }
    }
    
    return { success: false, error: error.message };
  }

  function sendStatus(msg, progress = 0) {
    if (mainWindow) {
      mainWindow.webContents.send('whisper-download-progress', { msg, progress });
    }
  }
});

// Menu Setup: App menu bar
function setupAppMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { role: 'quit' }
      ]
    },
    {
      label: 'Tools',
      submenu: [
        {
          label: 'Download latest FFmpeg',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('trigger-ffmpeg-download');
            }
          }
        },
        {
          label: 'Download Piper Engine',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('trigger-piper-download');
            }
          }
        },
        {
          label: 'Download Whisper.cpp Engine',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('trigger-whisper-download');
            }
          }
        },
        { type: 'separator' },
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' }
      ]
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}
