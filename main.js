const { app, BrowserWindow, ipcMain, session, protocol, net, clipboard, Menu, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const { exec, execFile, execSync, spawn } = require('child_process');
const { pathToFileURL } = require('url');
const ffmpeg = require('fluent-ffmpeg');

// Preconfigured Piper Voice ONNX paths relative to HF resolve
const PIPER_VOICES = {
  'en_US-lessac-medium.onnx': 'en/en_US/lessac/medium/',
  'en_US-joe-medium.onnx': 'en/en_US/joe/medium/',
  'en_US-ryan-medium.onnx': 'en/en_US/ryan/medium/'
};

// Set up secure custom media protocol to play local audio files in Renderer
protocol.registerSchemesAsPrivileged([
  { scheme: 'media', privileges: { bypassCSP: true, stream: true, supportFetchAPI: true, corsEnabled: true } }
]);

let mainWindow;
let activeModel = 'ggml-base.bin';

// Helper to resolve paths to binaries/assets, handling ASAR unpacking automatically
function getAssetPath(...parts) {
  const base = __dirname.replace('app.asar', 'app.asar.unpacked');
  return path.join(base, ...parts);
}

// Ensure temp directory exists inside writable user data if packaged
const tmpDir = app.isPackaged 
  ? path.join(app.getPath('userData'), 'tmp') 
  : path.join(__dirname, 'tmp');

if (!fs.existsSync(tmpDir)) {
  fs.mkdirSync(tmpDir, { recursive: true });
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

// ----------------------------------------------------
// Clean up all temporary files in tmp folder
// ----------------------------------------------------
function cleanupTempFiles() {
  try {
    if (fs.existsSync(tmpDir)) {
      const files = fs.readdirSync(tmpDir);
      for (const file of files) {
        fs.unlinkSync(path.join(tmpDir, file));
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

// ----------------------------------------------------
// Microsoft Visual C++ Redistributable Checker
// ----------------------------------------------------
function checkAndInstallMsvc() {
  if (process.platform !== 'win32') return;

  const { dialog } = require('electron');
  let isInstalled = false;

  try {
    // Query registry for Visual C++ 2015-2022 Redistributable (x64)
    execSync('reg query "HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64" /v Installed', { stdio: 'ignore' });
    isInstalled = true;
  } catch (e) {
    isInstalled = false;
  }

  if (isInstalled) {
    console.log('[System] Microsoft Visual C++ Redistributable runtime check passed.');
    return;
  }

  const redistLocalPath = getAssetPath('bin', 'vc_redist.x64.exe');
  const redistTempPath = path.join(tmpDir, 'vc_redist.x64.exe');
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
      message: 'This application requires the Microsoft Visual C++ 2015-2022 Redistributable runtime to execute local speech processing models.\n\nIt was not detected on your system. Would you like to launch the installer now?',
      cancelId: 1
    });

    if (choice === 0) {
      launchInstaller(finalRedistPath);
    }
  } else {
    // Both installer files are missing. Offer to download.
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      buttons: ['Download & Install', 'Skip'],
      defaultId: 0,
      title: 'Microsoft Visual C++ Redistributable Required',
      message: 'This application requires the Microsoft Visual C++ 2015-2022 Redistributable runtime to execute local speech models.\n\nWould you like to download and install it automatically now (approx. 24MB)?',
      cancelId: 1
    });

    if (choice === 0) {
      console.log('[System] Downloading VC++ Redistributable installer...');
      const downloadUrl = 'https://aka.ms/vs/17/release/vc_redist.x64.exe';
      
      downloadUrlToFile(downloadUrl, redistTempPath)
        .then(() => {
          console.log('[System] VC++ Redistributable download complete.');
          const installChoice = dialog.showMessageBoxSync({
            type: 'info',
            buttons: ['Run Installer Now', 'Later'],
            defaultId: 0,
            title: 'Download Complete',
            message: 'The Microsoft Visual C++ Redistributable installer was downloaded successfully. Would you like to run it now?'
          });
          if (installChoice === 0) {
            launchInstaller(redistTempPath);
          }
        })
        .catch((err) => {
          console.error('[System] Failed to download VC++ Redistributable:', err);
          dialog.showErrorBox(
            'Download Failed',
            `Failed to download the VC++ Redistributable installer:\n${err.message}\n\nPlease install it manually from: https://aka.ms/vs/17/release/vc_redist.x64.exe`
          );
        });
    }
  }
}

function launchInstaller(exePath) {
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
    });

    child.on('error', (err) => {
      console.error('[System] VC++ Redistributable installer process error:', err);
      if (mainWindow) {
        mainWindow.restore();
        mainWindow.focus();
      }
    });
  } catch (spawnErr) {
    console.error('[System] Failed to launch redistributable installer:', spawnErr);
    if (mainWindow) {
      mainWindow.restore();
      mainWindow.focus();
    }
  }
}

// ----------------------------------------------------
// Auto-Granting Media Permissions inside Electron
// ----------------------------------------------------
app.whenReady().then(() => {
  // Check and prompt for MSVC Redistributable on Windows
  checkAndInstallMsvc();

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
function transcribeWithWhisper(wavPath) {
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
ipcMain.handle('audio-stt', async (event, inputPath) => {
  const transOutPath = path.join(tmpDir, `transcoded_${Date.now()}.wav`);
  try {
    // 1. Transcode input audio
    await transcodeToWhisperFormat(inputPath, transOutPath);

    // 2. Run local transcription
    const transcript = await transcribeWithWhisper(transOutPath);

    // 3. Clean up transcoded file immediately
    try {
      if (fs.existsSync(transOutPath)) {
        //fs.unlinkSync(transOutPath);
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
        //fs.unlinkSync(transOutPath);
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
  const url = `https://huggingface.co/ggerganov/whisper.cpp/resolve/main/${modelName}`;

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
          if (fs.existsSync(tempDestPath)) fs.unlinkSync(tempDestPath);
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
        if (fs.existsSync(tempDestPath)) fs.unlinkSync(tempDestPath);
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
          if (fs.existsSync(tempDestPath)) fs.unlinkSync(tempDestPath);
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
            if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
            fs.renameSync(tempDestPath, destPath);
            resolve();
          } catch (err) {
            reject(err);
          }
        });
      });

      requestObj.on('error', (err) => {
        file.close();
        if (fs.existsSync(tempDestPath)) fs.unlinkSync(tempDestPath);
        reject(err);
      });
    }

    startDownload(downloadUrl);
  });
}

// IPC: Download Piper voice model (.onnx and .onnx.json) from Hugging Face
ipcMain.handle('download-voice-model', async (event, voiceName) => {
  const piperBinDir = getAssetPath('bin', 'piper', 'piper');
  const relativePath = PIPER_VOICES[voiceName];
  if (!relativePath) {
    return { success: false, error: `Unknown voice name: ${voiceName}` };
  }

  const onnxUrl = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${relativePath}${voiceName}`;
  const jsonUrl = `https://huggingface.co/rhasspy/piper-voices/resolve/main/${relativePath}${voiceName}.json`;

  const onnxDest = path.join(piperBinDir, voiceName);
  const jsonDest = path.join(piperBinDir, `${voiceName}.json`);

  if (!fs.existsSync(piperBinDir)) {
    fs.mkdirSync(piperBinDir, { recursive: true });
  }

  try {
    console.log(`[Piper Downloader] Downloading ONNX model: ${voiceName}`);
    // Download ONNX model (it's the large file, so track progress for this one)
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
    // Download ONNX.json configuration file (small file, direct download)
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
ipcMain.handle('download-ffmpeg', async (event) => {
  const ffmpegZipDest = path.join(tmpDir, 'ffmpeg.zip');
  const extractTempDir = path.join(tmpDir, 'ffmpeg_extracted');
  const ffmpegTargetDir = getAssetPath('bin', 'ffmpeg', 'bin');
  const ffmpegFinalPath = path.join(ffmpegTargetDir, 'ffmpeg.exe');

  // URL for latest stable essentials build from gyan.dev
  const ffmpegUrl = 'https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip';

  try {
    // 1. Ensure target directories exist
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    if (!fs.existsSync(ffmpegTargetDir)) fs.mkdirSync(ffmpegTargetDir, { recursive: true });

    // 2. Clean up any previous extraction directories
    if (fs.existsSync(extractTempDir)) {
      fs.rmSync(extractTempDir, { recursive: true, force: true });
    }

    // Send initial status update
    sendStatus('Downloading latest FFmpeg essentials release (approx. 90MB)...', 0);

    // 3. Download the zip file
    await downloadUrlToFile(ffmpegUrl, ffmpegZipDest, (downloaded, total) => {
      const percentage = total ? Math.round((downloaded / total) * 100) : 0;
      sendStatus(`Downloading FFmpeg archive: ${percentage}%`, percentage);
    });

    // 4. Extract the zip file using PowerShell Expand-Archive (native to Windows)
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

    // 5. Find ffmpeg.exe inside the extracted folder recursively
    sendStatus('Searching for ffmpeg.exe in extracted folder...', 100);
    const foundExePath = findFileRecursively(extractTempDir, 'ffmpeg.exe');
    if (!foundExePath) {
      throw new Error('Could not locate ffmpeg.exe inside the extracted archive.');
    }

    // 6. Copy ffmpeg.exe to final destination
    sendStatus('Deploying executable to bin/ffmpeg/bin/...', 100);
    fs.copyFileSync(foundExePath, ffmpegFinalPath);

    // 7. Verify file exists
    if (fs.existsSync(ffmpegFinalPath)) {
      sendStatus('Cleaning up temporary setup files...', 100);
      try {
        if (fs.existsSync(ffmpegZipDest)) fs.unlinkSync(ffmpegZipDest);
        if (fs.existsSync(extractTempDir)) fs.rmSync(extractTempDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        console.warn('[FFmpeg Setup Cleanup Warning]', cleanupErr);
      }
      return { success: true, path: ffmpegFinalPath };
    } else {
      throw new Error('Failed to copy ffmpeg.exe to destination.');
    }

  } catch (error) {
    console.error('[FFmpeg Download/Setup Error]', error);
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

// IPC: Download Piper Engine (C++ build)
ipcMain.handle('download-piper', async (event) => {
  const piperZipDest = path.join(tmpDir, 'piper.zip');
  const piperTargetDir = getAssetPath('bin', 'piper');
  const piperFinalExe = path.join(piperTargetDir, 'piper', 'piper.exe');
  const url = 'https://github.com/rhasspy/piper/releases/download/2023.11.14-2/piper_windows_amd64.zip';

  try {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    if (!fs.existsSync(piperTargetDir)) fs.mkdirSync(piperTargetDir, { recursive: true });

    sendStatus('Downloading Piper Neural TTS Engine (approx. 22MB)...', 0);
    await downloadUrlToFile(url, piperZipDest, (downloaded, total) => {
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
      sendStatus('Cleaning up temp files...', 100);
      if (fs.existsSync(piperZipDest)) fs.unlinkSync(piperZipDest);
      return { success: true, path: piperFinalExe };
    } else {
      throw new Error('Failed to configure piper.exe at destination.');
    }
  } catch (error) {
    console.error('[Piper Engine Download Error]', error);
    return { success: false, error: error.message };
  }

  function sendStatus(msg, progress = 0) {
    if (mainWindow) {
      mainWindow.webContents.send('piper-download-progress', { msg, progress });
    }
  }
});

// IPC: Download Whisper.cpp Engine (C++ build)
ipcMain.handle('download-whisper-engine', async (event) => {
  const whisperZipDest = path.join(tmpDir, 'whisper.zip');
  const whisperTargetDir = getAssetPath('bin', 'whisper', 'Release');
  const whisperFinalExe = path.join(whisperTargetDir, 'whisper-cli.exe');
  const url = 'https://github.com/ggml-org/whisper.cpp/releases/download/v1.9.1/whisper-bin-x64.zip';

  try {
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    if (!fs.existsSync(whisperTargetDir)) fs.mkdirSync(whisperTargetDir, { recursive: true });

    sendStatus('Downloading Whisper.cpp Engine (approx. 8MB)...', 0);
    await downloadUrlToFile(url, whisperZipDest, (downloaded, total) => {
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
      sendStatus('Cleaning up temp files...', 100);
      if (fs.existsSync(whisperZipDest)) fs.unlinkSync(whisperZipDest);
      return { success: true, path: whisperFinalExe };
    } else {
      throw new Error('Failed to configure whisper-cli.exe at destination.');
    }
  } catch (error) {
    console.error('[Whisper Engine Download Error]', error);
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
