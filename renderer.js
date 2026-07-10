// ----------------------------------------------------
// Local STT & TTS Renderer Application Logic
// ----------------------------------------------------

// State Variables
let mediaRecorder = null;
let audioChunks = [];
let recordTimerInterval = null;
let recordStartTime = null;
let selectedAudioFile = null;
let generatedAudioPath = null; // Track synthesized WAV for cleanup
let generatedAudioUrl = null;

// Whisper Model & Diagnostics State
let availableModels = [];
let currentModel = 'ggml-base.bin';
let lastMicRecordingPath = null; // Persists raw mic file for diagnostics
let isEventListenersSetup = false; // Guard to prevent duplicate event listener registrations


// UI Elements - STT
const micTab = document.getElementById('mic-tab');
const uploadTab = document.getElementById('upload-tab');
const btnToggleRecord = document.getElementById('btn-toggle-record');
const recordIcon = document.getElementById('record-icon');
const recordStatus = document.getElementById('record-status');
const recordTimer = document.getElementById('record-timer');
const recordProgressContainer = document.getElementById('record-progress-container');
const recordingVisualizer = document.getElementById('recording-visualizer');

const audioDropZone = document.getElementById('audio-drop-zone');
const audioFilePicker = document.getElementById('audio-file-picker');
const selectedFileInfo = document.getElementById('selected-file-info');
const uploadFilename = document.getElementById('upload-filename');
const uploadFilesize = document.getElementById('upload-filesize');
const btnProcessUpload = document.getElementById('btn-process-upload');

const sttOutput = document.getElementById('stt-output');
const sttCharCount = document.getElementById('stt-char-count');
const btnCopyStt = document.getElementById('btn-copy-stt');
const btnFullscreenStt = document.getElementById('btn-fullscreen-stt');
const sttLoadingOverlay = document.getElementById('stt-loading-overlay');
const btnDownloadFfmpegUi = document.getElementById('btn-download-ffmpeg-ui');
const btnDownloadPiperUi = document.getElementById('btn-download-piper-ui');
const btnDownloadWhisperUi = document.getElementById('btn-download-whisper-ui');
const btnCheckUpdate = document.getElementById('btn-check-update');

// Custom Window Controls
const titleBarMinimize = document.getElementById('title-bar-minimize');
const titleBarMaximize = document.getElementById('title-bar-maximize');
const titleBarClose = document.getElementById('title-bar-close');
const maximizeIcon = document.getElementById('maximize-icon');
const titleBarSettings = document.getElementById('title-bar-settings');
const titleBarInfo = document.getElementById('title-bar-info');

// Whisper Model Downloader & Diagnostics elements
const modelSelect = document.getElementById('model-select');
const languageSelect = document.getElementById('language-select');
const btnPlayMic = document.getElementById('btn-play-mic');

// Whisper Model Meta-information — loaded dynamically from conf.json via IPC
// Populated at startup by initWhisperModels(); used by syncModels() and ensureModelDownloaded()
let WHISPER_MODEL_INFO = {};

async function initWhisperModels() {
  try {
    const models = await window.api.getWhisperModels();
    if (!models || models.length === 0) {
      console.warn('[Models] conf.json returned no Whisper models.');
      return;
    }

    // Build lookup map: file -> { name, size }
    WHISPER_MODEL_INFO = {};
    models.forEach(m => {
      WHISPER_MODEL_INFO[m.file] = { name: m.name, size: m.size };
    });

    // Populate the model-select dropdown dynamically
    modelSelect.innerHTML = '';
    models.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.file;
      opt.innerText = `${m.name} (${m.size})`;
      if (m.default) opt.selected = true;
      modelSelect.appendChild(opt);
    });

    console.log(`[Models] Loaded ${models.length} Whisper model(s) from conf.json.`);
  } catch (err) {
    console.error('[Models] Failed to load Whisper model list from conf.json:', err);
  }
}
const playMicIcon = document.getElementById('play-mic-icon');
const modelDownloadOverlay = document.getElementById('model-download-overlay');
const downloadProgressBar = document.getElementById('download-progress-bar');
const downloadBytes = document.getElementById('download-bytes');
const downloadPct = document.getElementById('download-pct');
const downloadTitle = document.getElementById('download-title');
const micSelect = document.getElementById('mic-select');

// UI Elements - TTS
const voiceSelect = document.getElementById('voice-select');
const ttsInput = document.getElementById('tts-input');
const btnSynthesize = document.getElementById('btn-synthesize');
const textFilePicker = document.getElementById('text-file-picker');
const textImportAlert = document.getElementById('text-import-alert');
const importedTxtFilename = document.getElementById('imported-txt-filename');
const ttsLoadingOverlay = document.getElementById('tts-loading-overlay');
const btnPasteTts = document.getElementById('btn-paste-tts');
const btnFullscreenTts = document.getElementById('btn-fullscreen-tts');
const speedSlider = document.getElementById('speed-slider');
const speedValue = document.getElementById('speed-value');
const silenceSlider = document.getElementById('silence-slider');
const silenceValue = document.getElementById('silence-value');
const noiseScaleSlider = document.getElementById('noise-scale-slider');
const noiseScaleValue = document.getElementById('noise-scale-value');
const noiseWSlider = document.getElementById('noise-w-slider');
const noiseWValue = document.getElementById('noise-w-value');

// UI Elements - Audio Player
const audioPlayback = document.getElementById('audio-playback-element');
const btnPlayPause = document.getElementById('btn-play-pause');
const playIcon = document.getElementById('play-icon');
const playerTime = document.getElementById('player-time');
const playerBar = document.getElementById('player-bar');
const playerProgressArea = document.getElementById('player-progress-area');
const playerFilename = document.getElementById('player-filename');
const playerFilesize = document.getElementById('player-filesize');

// UI Elements - Footer status
const statusConsole = document.getElementById('status-console');
const logConsole = document.getElementById('log-console');
const btnClearLogs = document.getElementById('btn-clear-logs');

// Dialog Modal Cache
const appDialogEl = document.getElementById('appDialogModal');
const appDialogTitle = document.getElementById('appDialogModalLabel');
const appDialogMessage = document.getElementById('app-dialog-message');
let appDialogModalInstance = null;

function getAppDialogModal() {
  if (!appDialogModalInstance && typeof bootstrap !== 'undefined') {
    appDialogModalInstance = new bootstrap.Modal(appDialogEl);
  }
  return appDialogModalInstance;
}

function showAppAlert(message, title = "SpeechBoleh Alert") {
  // Hide fullscreen download overlay first if visible to prevent layout deadlock
  if (modelDownloadOverlay && modelDownloadOverlay.style.display === 'flex') {
    modelDownloadOverlay.style.setProperty('display', 'none', 'important');
  }

  return new Promise((resolve) => {
    const modal = getAppDialogModal();
    if (!modal) {
      alert(message);
      resolve();
      return;
    }
    
    appDialogTitle.innerText = title;
    appDialogMessage.innerText = message;
    
    const cancelBtn = document.getElementById('btn-dialog-cancel');
    const okBtn = document.getElementById('btn-dialog-ok');
    
    cancelBtn.style.display = 'none';
    
    const newOk = okBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOk, okBtn);
    
    newOk.addEventListener('click', () => {
      modal.hide();
      resolve();
    });
    
    modal.show();
  });
}

function showAppConfirm(message, title = "SpeechBoleh Confirmation") {
  // Hide fullscreen download overlay first if visible to prevent layout deadlock
  if (modelDownloadOverlay && modelDownloadOverlay.style.display === 'flex') {
    modelDownloadOverlay.style.setProperty('display', 'none', 'important');
  }

  return new Promise((resolve) => {
    const modal = getAppDialogModal();
    if (!modal) {
      resolve(confirm(message));
      return;
    }
    
    appDialogTitle.innerText = title;
    appDialogMessage.innerText = message;
    
    const cancelBtn = document.getElementById('btn-dialog-cancel');
    const okBtn = document.getElementById('btn-dialog-ok');
    
    cancelBtn.style.display = 'inline-block';
    
    const newOk = okBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(newOk, okBtn);
    
    const newCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    
    newOk.addEventListener('click', () => {
      modal.hide();
      resolve(true);
    });
    
    newCancel.addEventListener('click', () => {
      modal.hide();
      resolve(false);
    });
    
    modal.show();
  });
}

// ----------------------------------------------------
// System Initialization
// ----------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  // Set up VC++ missing overlay listener immediately before any async initialization steps
  // to ensure we never miss the 'show-vcredist-required' IPC trigger sent right after load.
  const vcredistOverlay   = document.getElementById('vcredist-overlay');
  const vcredistArchBadge = document.getElementById('vcredist-arch-badge');
  const vcredistStatus    = document.getElementById('vcredist-status');
  const btnVcInstall      = document.getElementById('btn-vcredist-install');
  const btnVcClose        = document.getElementById('btn-vcredist-close');

  window.api.onVcRedistRequired(({ archKey, downloadUrl }) => {
    if (vcredistArchBadge) vcredistArchBadge.innerText = archKey;
    if (vcredistOverlay)   vcredistOverlay.style.setProperty('display', 'flex', 'important');
    console.log(`[VC++ Overlay] Showing blocking overlay for arch: ${archKey}`);
  });

  // Bind VC++ overlay button actions synchronously here so they work immediately
  // even if the rest of the application initialization fails or gets stuck.
  if (btnVcInstall) {
    btnVcInstall.addEventListener('click', async () => {
      btnVcInstall.disabled = true;
      btnVcInstall.innerHTML = '<span class="spinner-border spinner-border-sm me-2"></span>Downloading...';
      if (vcredistStatus) vcredistStatus.innerText = 'Downloading Microsoft Visual C++ Redistributable installer...';

      const res = await window.api.installVcRedist();
      if (res && res.success) {
        if (vcredistStatus) vcredistStatus.innerText = 'Microsoft Visual C++ Redistributable installed successfully! Proceeding to application...';
        btnVcInstall.innerHTML = '<i class="bi bi-check-circle-fill me-2"></i>Installed Successfully';
        btnVcInstall.className = btnVcInstall.className.replace('btn-warning', 'btn-success');
        
        // Hide Close button so user doesn't interrupt the startup transition
        if (btnVcClose) {
          btnVcClose.style.display = 'none';
        }

        // Wait 1.5s to show success state, then close overlay and proceed
        setTimeout(async () => {
          if (vcredistOverlay) vcredistOverlay.style.setProperty('display', 'none', 'important');
          await runRemainingInitialization();
        }, 1500);
      } else if (res && res.installerCancelled) {
        // Installer ran but user cancelled or it didn't complete — reset so they can try again
        if (vcredistStatus) vcredistStatus.innerText = 'Installation was not completed. Please install to continue using speech features.';
        btnVcInstall.disabled = false;
        btnVcInstall.innerHTML = '<i class="bi bi-download me-2"></i>Try Again';
      } else {
        if (vcredistStatus) vcredistStatus.innerText = `Download failed: ${res?.error || 'Unknown error'}. Please install manually.`;
        btnVcInstall.disabled = false;
        btnVcInstall.innerHTML = '<i class="bi bi-download me-2"></i>Download &amp; Install';
      }
    });
  }

  if (btnVcClose) {
    btnVcClose.addEventListener('click', () => {
      window.api.quitApp();
    });
  }

  // Set version numbers dynamically from package.json
  try {
    const version = await window.api.getAppVersion();
    const titleBarVersion = document.getElementById('title-bar-version');
    const aboutVersion = document.getElementById('about-version');
    const footerVersion = document.getElementById('footer-version');

    if (titleBarVersion) titleBarVersion.innerText = `Beta v${version}`;
    if (aboutVersion) aboutVersion.innerText = `Version Beta v${version}`;
    if (footerVersion) footerVersion.innerText = `v${version} (Win64)`;
  } catch (err) {
    console.error('Failed to get app version:', err);
  }

  logStatus('Starting local SpeechBoleh services...', 'system');
  logStatus('Scanning system microphones...', 'info');
  await populateMics();
  logStatus('Initializing local SAPI / Piper voice lists...', 'info');
  await populateVoices();
  logStatus('Syncing offline Whisper model weights...', 'info');
  await initWhisperModels();

  // Gate: if VC++ Redistributable was not installed at startup, skip all component
  // downloads. The blocking overlay will appear via the 'show-vcredist-required' IPC event.
  const vcRequired = await window.api.isVcRedistRequired();
  if (vcRequired) {
    logStatus('Microsoft Visual C++ Redistributable is required. Please install it to continue.', 'error');
    console.warn('[Startup] VC++ Redistributable required — skipping component sync and first-run setup.');
    setupEventListeners();
    return;
  }

  await runRemainingInitialization();
});

// Helper: Performs/resumes the remaining part of startup initialization after VC++ is verified
async function runRemainingInitialization() {
  logStatus('Syncing offline Whisper model weights...', 'info');
  await syncModels();
  setupEventListeners();

  const aboutGithubLink = document.getElementById('about-github-link');
  if (aboutGithubLink) {
    // Re-bind only if event listeners setup hasn't run yet or run independently
    aboutGithubLink.addEventListener('click', (e) => {
      e.preventDefault();
      window.api.openExternalUrl('https://github.com/tinwinaung/SpeechBoleh');
    });
  }

  // Run first-run setup checks
  await checkAndSetupFirstRun();

  logStatus('System ready. All offline pipelines successfully loaded.', 'success');
}


// Automatic first-run setup checker
async function checkAndSetupFirstRun() {
  logStatus('Checking system dependencies...', 'info');
  try {
    const deps = await window.api.checkDependencies();

    // Determine what needs to be downloaded
    const missingFfmpeg = !deps.ffmpeg;
    const missingPiper = !deps.piperEngine;
    const missingWhisper = !deps.whisperEngine;

    logStatus(`Dependency status: FFmpeg=${deps.ffmpeg}, Piper=${deps.piperEngine}, Whisper=${deps.whisperEngine}`);

    // Check Whisper models
    let missingWhisperModel = false;
    try {
      const models = await window.api.getAvailableModels();
      if (!models || models.length === 0) {
        missingWhisperModel = true;
      }
    } catch (e) {
      missingWhisperModel = true;
    }

    // Check Piper voices
    let missingPiperVoice = false;
    try {
      const voices = await window.api.getVoices();
      if (!voices || voices.length === 0) {
        missingPiperVoice = true;
      }
    } catch (e) {
      missingPiperVoice = true;
    }

    // Only trigger first-run setup if the core executable binaries themselves do not exist
    const needsSetup = missingFfmpeg || missingPiper || missingWhisper;

    if (!needsSetup) {
      logStatus('All core engine binaries are present.', 'success');
      return;
    }

    logStatus('First-run dependencies missing. Launching automatic setup...', 'warning');

    // Show download overlay dialog modal
    modelDownloadOverlay.style.setProperty('display', 'flex', 'important');

    const descEl = modelDownloadOverlay.querySelector('p');
    const originalDesc = descEl ? descEl.innerText : '';

    // 1. Download FFmpeg if missing
    if (missingFfmpeg) {
      logStatus('Downloading FFmpeg core dependency...', 'system');
      if (descEl) descEl.innerText = "Downloading and extracting FFmpeg audio transcoding tools. Please wait...";
      downloadTitle.innerText = "Installing FFmpeg";
      downloadProgressBar.style.width = '0%';
      downloadPct.innerText = '0%';
      downloadBytes.innerText = 'Initializing...';

      const res = await window.api.downloadFfmpeg();
      if (!res.success) {
        throw new Error(`FFmpeg setup failed: ${res.error}`);
      }
      logStatus('FFmpeg configured successfully.', 'success');
    }

    // 2. Download Piper Engine if missing
    if (missingPiper) {
      logStatus('Downloading Piper Neural TTS Engine...', 'system');
      if (descEl) descEl.innerText = "Downloading and extracting Piper text-to-speech engine binaries. Please wait...";
      downloadTitle.innerText = "Installing Piper Engine";
      downloadProgressBar.style.width = '0%';
      downloadPct.innerText = '0%';
      downloadBytes.innerText = 'Initializing...';

      const res = await window.api.downloadPiper();
      if (!res.success) {
        throw new Error(`Piper Engine setup failed: ${res.error}`);
      }
      logStatus('Piper Engine configured successfully.', 'success');
      await populateVoices();
    }

    // 3. Download Whisper Engine if missing
    if (missingWhisper) {
      logStatus('Downloading Whisper.cpp transcription engine...', 'system');
      if (descEl) descEl.innerText = "Downloading and extracting Whisper speech-to-text engine binaries. Please wait...";
      downloadTitle.innerText = "Installing Whisper Engine";
      downloadProgressBar.style.width = '0%';
      downloadPct.innerText = '0%';
      downloadBytes.innerText = 'Initializing...';

      const res = await window.api.downloadWhisperEngine();
      if (!res.success) {
        throw new Error(`Whisper Engine setup failed: ${res.error}`);
      }
      logStatus('Whisper Engine configured successfully.', 'success');
      await syncModels();
    }

    // 4. Download Whisper default model (ggml-base.bin) if missing
    if (missingWhisperModel) {
      const defaultModel = 'ggml-base.bin';
      logStatus(`Downloading default Whisper model (${defaultModel})...`, 'system');
      if (descEl) descEl.innerText = `Downloading default speech recognition model weight (${defaultModel}). This might take a few moments.`;
      downloadTitle.innerText = "Downloading Whisper Model";
      downloadProgressBar.style.width = '0%';
      downloadPct.innerText = '0%';
      downloadBytes.innerText = 'Initializing...';

      // Register temporary progress listeners
      window.api.onDownloadProgress((data) => {
        downloadProgressBar.style.width = `${data.percentage}%`;
        downloadPct.innerText = `${data.percentage}%`;
        downloadBytes.innerText = `Downloaded ${formatBytes(data.downloaded)} / ${formatBytes(data.total)}`;
      });

      const res = await window.api.downloadModel(defaultModel);
      if (!res.success) {
        throw new Error(`Whisper model setup failed: ${res.error}`);
      }
      logStatus('Whisper default model cached successfully.', 'success');
      await syncModels();
      modelSelect.value = defaultModel;
      currentModel = defaultModel;
      await window.api.setActiveModel(defaultModel);
    }

    // 5. Download Piper default voice model (from conf.json) if missing
    if (missingPiperVoice) {
      if (PIPER_VOICE_INFO.length === 0) await initPiperVoices();
      const defaultVoiceInfo = PIPER_VOICE_INFO.find(v => v.default) || PIPER_VOICE_INFO[0];
      const defaultVoice = defaultVoiceInfo ? defaultVoiceInfo.file : 'en_US-lessac-medium.onnx';

      logStatus(`Downloading default Piper voice model (${defaultVoice})...`, 'system');
      if (descEl) descEl.innerText = `Downloading default voice synthesis model (${defaultVoice}). Please wait...`;
      downloadTitle.innerText = "Downloading Piper Voice";
      downloadProgressBar.style.width = '0%';
      downloadPct.innerText = '0%';
      downloadBytes.innerText = 'Initializing...';

      // Register temporary progress listeners
      window.api.onVoiceDownloadProgress((data) => {
        downloadProgressBar.style.width = `${data.percentage}%`;
        downloadPct.innerText = `${data.percentage}%`;
        downloadBytes.innerText = `Downloaded ${formatBytes(data.downloaded)} / ${formatBytes(data.total)}`;
      });

      const res = await window.api.downloadVoiceModel(defaultVoice);
      if (!res.success) {
        throw new Error(`Piper voice setup failed: ${res.error}`);
      }
      logStatus('Piper default voice model cached successfully.', 'success');
      await populateVoices();
    }

    await showAppAlert('First-run dependencies setup completed successfully! All offline modules are ready for use.');

  } catch (err) {
    console.error('[First Run Setup Error]', err);
    logStatus(`Setup Error: ${err.message}`, 'error');
    await showAppAlert(`First-run setup failed:\n${err.message}\n\nYou can retry downloading missing modules manually from the "Download Engines" menu.`);
  } finally {
    // Hide overlay and restore default texts
    modelDownloadOverlay.style.setProperty('display', 'none', 'important');

    // Reset overlay titles to standard models
    downloadTitle.innerText = "Downloading Model";
  }
}

// Helper for UI Console Logger
function logStatus(message, type = 'info') {
  const timestamp = new Date().toLocaleTimeString();
  const fullMessage = `[${timestamp}] ${message}`;

  if (statusConsole) {
    statusConsole.innerText = fullMessage;
  }

  if (logConsole) {
    const logLine = document.createElement('div');

    let colorClass = 'text-white-50';
    if (type === 'error') {
      colorClass = 'text-danger';
    } else if (type === 'success') {
      colorClass = 'text-success';
    } else if (type === 'warning') {
      colorClass = 'text-warning';
    } else if (type === 'system') {
      colorClass = 'text-info';
    }

    logLine.className = colorClass;
    logLine.innerText = fullMessage;
    logConsole.appendChild(logLine);

    while (logConsole.childNodes.length > 150) {
      logConsole.removeChild(logConsole.firstChild);
    }

    logConsole.scrollTop = logConsole.scrollHeight;
  }
}

// ----------------------------------------------------
// TTS: Populate Voices from conf.json
// ----------------------------------------------------
let PIPER_VOICE_INFO = []; // Cached voice list from conf.json

async function initPiperVoices() {
  try {
    const voices = await window.api.getPiperVoices();
    if (!voices || voices.length === 0) {
      console.warn('[Voices] conf.json returned no Piper voices.');
      return;
    }
    PIPER_VOICE_INFO = voices;
    console.log(`[Voices] Loaded ${voices.length} Piper voice(s) from conf.json.`);
  } catch (err) {
    console.error('[Voices] Failed to load Piper voice list from conf.json:', err);
  }
}

async function populateVoices() {
  try {
    // Ensure voice metadata is loaded
    if (PIPER_VOICE_INFO.length === 0) await initPiperVoices();

    const cachedVoices = await window.api.getVoices();
    console.log('[Voices] Downloaded Piper voices found:', cachedVoices);

    // Rebuild the dropdown from conf.json voice list
    voiceSelect.innerHTML = '';
    PIPER_VOICE_INFO.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.file;
      const isCached = cachedVoices.includes(v.file);
      const suffix = isCached ? '[Cached]' : '[Cloud Download]';
      const defaultMark = v.default ? ' ★' : '';
      opt.innerText = `${v.name}${defaultMark} ${suffix}`;
      if (v.default && !cachedVoices.length) opt.selected = true;
      voiceSelect.appendChild(opt);
    });

    // Select the first cached voice, or the default if none cached
    const defaultVoice = PIPER_VOICE_INFO.find(v => cachedVoices.includes(v.file))
      || PIPER_VOICE_INFO.find(v => v.default)
      || PIPER_VOICE_INFO[0];
    if (defaultVoice) voiceSelect.value = defaultVoice.file;

    logStatus(`Synced Piper voice models. Cached voices: ${cachedVoices.length}`);
  } catch (err) {
    console.error('Failed to query voices', err);
    logStatus('Error querying offline Piper voices.');
  }
}

async function handleVoiceChange() {
  const targetVoice = voiceSelect.value;
  logStatus(`Piper voice change requested: ${targetVoice}`);

  const cachedVoices = await window.api.getVoices();
  const isDownloaded = cachedVoices.includes(targetVoice);

  if (!isDownloaded) {
    if (await isDownloadInProgress()) return;
    // Show download UI (reusing modelDownloadOverlay)
    modelDownloadOverlay.style.setProperty('display', 'flex', 'important');
    downloadTitle.innerText = `Downloading Voice Model`;
    downloadProgressBar.style.width = '0%';
    downloadBytes.innerText = '0 / 0 MB';
    downloadPct.innerText = '0%';

    // Bind voice progress IPC listener
    window.api.onVoiceDownloadProgress((data) => {
      if (data.voiceName === targetVoice) {
        const dlMB = (data.downloaded / 1024 / 1024).toFixed(1);
        const totMB = (data.total / 1024 / 1024).toFixed(1);
        downloadBytes.innerText = `${dlMB} / ${totMB} MB`;
        downloadProgressBar.style.width = `${data.percentage}%`;
        downloadPct.innerText = `${data.percentage}%`;
      }
    });

    logStatus(`Downloading Piper voice ${targetVoice} from Hugging Face...`);
    try {
      const res = await window.api.downloadVoiceModel(targetVoice);
      if (res.success) {
        logStatus(`Voice model ${targetVoice} downloaded successfully.`);
        await populateVoices();
      } else {
        throw new Error(res.error || 'Server error during voice download');
      }
    } catch (err) {
      console.error('[Voice Download Error]', err);
      await showAppAlert(`Voice Download Failed:\n${err.message}\nReverting selection.`);
      // Revert to default voice from conf.json
      const defaultVoice = PIPER_VOICE_INFO.find(v => v.default);
      if (defaultVoice) voiceSelect.value = defaultVoice.file;
      return;
    } finally {
      modelDownloadOverlay.style.setProperty('display', 'none', 'important');
    }
  }
}

async function isDownloadInProgress() {
  if (modelDownloadOverlay.style.display === 'flex') {
    await showAppAlert("An engine installation or download is already in progress. Please wait until it completes.");
    return true;
  }
  return false;
}

// ----------------------------------------------------
// STT: Populate Audio Input Devices (Microphones)
// ----------------------------------------------------
async function populateMics() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const audioInputs = devices.filter(device => device.kind === 'audioinput');

    const selectedVal = micSelect.value;
    micSelect.innerHTML = '';

    const defaultOption = document.createElement('option');
    defaultOption.value = '';
    defaultOption.innerText = 'Default System Microphone';
    micSelect.appendChild(defaultOption);

    audioInputs.forEach((device, index) => {
      const label = device.label || `Microphone ${index + 1} (${device.deviceId.substring(0, 5)})`;
      const option = document.createElement('option');
      option.value = device.deviceId;
      option.innerText = label;
      micSelect.appendChild(option);
    });

    if (selectedVal) {
      micSelect.value = selectedVal;
    }

    logStatus(`Discovered ${audioInputs.length} local audio input devices.`);
  } catch (err) {
    console.error('Failed to list microphone devices:', err);
  }
}

async function triggerFfmpegDownloadFlow(customUrl, customVersion) {
  console.log('[DEBUG] triggerFfmpegDownloadFlow clicked');
  if (await isDownloadInProgress()) return;
  if (!customUrl) {
    const choice = await showAppConfirm("This action will download and extract the latest FFmpeg Essentials build (approx. 90MB) from gyan.dev directly into your bin/ folder.\n\nAre you sure you want to download and install FFmpeg now?");
    if (!choice) {
      console.log('[DEBUG] User cancelled FFmpeg download prompt');
      return;
    }
  }

  logStatus("Starting FFmpeg download & installation process...", "system");

  // Show the download progress overlay
  console.log('[DEBUG] Setting download title...');
  downloadTitle.innerText = "Downloading FFmpeg";
  const descEl = modelDownloadOverlay.querySelector('p');
  const originalDesc = descEl ? descEl.innerText : '';
  if (descEl) {
    descEl.innerText = "Fetching latest binaries and configuring environment. This may take a few minutes depending on your internet connection.";
  }
  downloadProgressBar.style.width = '0%';
  downloadBytes.innerText = 'Initializing...';
  downloadPct.innerText = '0%';
  console.log('[DEBUG] Showing modelDownloadOverlay...', modelDownloadOverlay);
  modelDownloadOverlay.style.setProperty('display', 'flex', 'important');

  try {
    const res = await window.api.downloadFfmpeg(customUrl, customVersion);
    if (res.success) {
      logStatus(`FFmpeg configured successfully at: ${res.path}`, "success");
      await showAppAlert(`FFmpeg downloaded and configured successfully!`);
    } else {
      throw new Error(res.error || "Unknown configuration error");
    }
  } catch (err) {
    console.error("FFmpeg deployment failed:", err);
    logStatus(`FFmpeg Deployment Error: ${err.message}`, "error");
    await showAppAlert(`FFmpeg setup failed:\n${err.message}`);
  } finally {
    console.log('[DEBUG] Hiding modelDownloadOverlay...');
    modelDownloadOverlay.style.setProperty('display', 'none', 'important');
    if (descEl) descEl.innerText = originalDesc;
  }
}

async function triggerPiperDownloadFlow(customUrl, customVersion) {
  console.log('[DEBUG] triggerPiperDownloadFlow clicked');
  if (await isDownloadInProgress()) return;
  if (!customUrl) {
    const choice = await showAppConfirm("This action will download and extract the latest prebuilt Piper TTS Engine (approx. 22MB) from GitHub directly into your bin/ folder.\n\nAre you sure you want to download and install the Piper Engine now?");
    if (!choice) {
      console.log('[DEBUG] User cancelled Piper download prompt');
      return;
    }
  }

  logStatus("Starting Piper engine download & installation...", "system");
  downloadTitle.innerText = "Downloading Piper Engine";
  const descEl = modelDownloadOverlay.querySelector('p');
  const originalDesc = descEl ? descEl.innerText : '';
  if (descEl) {
    descEl.innerText = "Fetching prebuilt voice engine libraries and executables. This may take a few moments.";
  }
  downloadProgressBar.style.width = '0%';
  downloadBytes.innerText = 'Initializing...';
  downloadPct.innerText = '0%';
  console.log('[DEBUG] Showing modelDownloadOverlay...', modelDownloadOverlay);
  modelDownloadOverlay.style.setProperty('display', 'flex', 'important');

  try {
    const res = await window.api.downloadPiper(customUrl, customVersion);
    if (res.success) {
      logStatus(`Piper engine configured successfully at: ${res.path}`, "success");
      await showAppAlert(`Piper engine downloaded and configured successfully!`);
      // Update voice lists to reflect potential new path sync
      await populateVoices();
    } else {
      throw new Error(res.error || "Unknown configuration error");
    }
  } catch (err) {
    console.error("Piper deployment failed:", err);
    logStatus(`Piper Deployment Error: ${err.message}`, "error");
    await showAppAlert(`Piper setup failed:\n${err.message}`);
  } finally {
    console.log('[DEBUG] Hiding modelDownloadOverlay...');
    modelDownloadOverlay.style.setProperty('display', 'none', 'important');
    if (descEl) descEl.innerText = originalDesc;
  }
}

async function triggerWhisperDownloadFlow(customUrl, customVersion) {
  console.log('[DEBUG] triggerWhisperDownloadFlow clicked');
  if (await isDownloadInProgress()) return;
  if (!customUrl) {
    const choice = await showAppConfirm("This action will download and extract the prebuilt Whisper.cpp CPU Engine (approx. 8MB) from GitHub directly into your bin/ folder.\n\nAre you sure you want to download and install the Whisper.cpp Engine now?");
    if (!choice) {
      console.log('[DEBUG] User cancelled Whisper download prompt');
      return;
    }
  }

  logStatus("Starting Whisper engine download & installation...", "system");
  downloadTitle.innerText = "Downloading Whisper Engine";
  const descEl = modelDownloadOverlay.querySelector('p');
  const originalDesc = descEl ? descEl.innerText : '';
  if (descEl) {
    descEl.innerText = "Fetching prebuilt whisper command-line libraries and executables. This may take a few moments.";
  }
  downloadProgressBar.style.width = '0%';
  downloadBytes.innerText = 'Initializing...';
  downloadPct.innerText = '0%';
  console.log('[DEBUG] Showing modelDownloadOverlay...', modelDownloadOverlay);
  modelDownloadOverlay.style.setProperty('display', 'flex', 'important');

  try {
    const res = await window.api.downloadWhisperEngine(customUrl, customVersion);
    if (res.success) {
      logStatus(`Whisper engine configured successfully at: ${res.path}`, "success");
      await showAppAlert(`Whisper.cpp engine downloaded and configured successfully!`);
      // Update models list to reflect new paths
      await syncModels();
    } else {
      throw new Error(res.error || "Unknown configuration error");
    }
  } catch (err) {
    console.error("Whisper deployment failed:", err);
    logStatus(`Whisper Deployment Error: ${err.message}`, "error");
    await showAppAlert(`Whisper setup failed:\n${err.message}`);
  } finally {
    console.log('[DEBUG] Hiding modelDownloadOverlay...');
    modelDownloadOverlay.style.setProperty('display', 'none', 'important');
    if (descEl) descEl.innerText = originalDesc;
  }
}

async function triggerCheckUpdateFlow() {
  console.log('[DEBUG] triggerCheckUpdateFlow clicked');
  logStatus("Checking for updates...", "system");
  btnCheckUpdate.classList.add('disabled');
  try {
    const res = await window.api.checkForUpdates();
    if (!res.success) {
      throw new Error(res.error || "Failed to query update statuses");
    }

    logStatus("Update check completed. Rendering component statuses...", "success");

    const listContainer = document.getElementById('update-components-list');
    if (!listContainer) return;

    listContainer.innerHTML = '';

    const componentKeys = ['app', 'ffmpeg', 'piper', 'whisper'];
    const componentDetails = {
      app: { name: 'SpeechBoleh (App)', icon: 'bi-soundwave', color: 'text-cyan' },
      ffmpeg: { name: 'FFmpeg Core', icon: 'bi-file-earmark-zip', color: 'text-cyan' },
      piper: { name: 'Piper TTS Engine', icon: 'bi-soundwave', color: 'text-purple' },
      whisper: { name: 'Whisper STT Engine', icon: 'bi-translate', color: 'text-cyan' }
    };

    componentKeys.forEach(key => {
      const data = res.components[key];
      const details = componentDetails[key];

      const itemDiv = document.createElement('div');
      itemDiv.className = 'p-3 bg-dark bg-opacity-50 border border-secondary border-opacity-15 rounded-3 d-flex align-items-center justify-content-between';

      // Status icon shown inline next to component name
      let statusIconHtml = '';

      if (key === 'app') {
        if (data.updateAvailable) {
          statusIconHtml = `<i class="bi bi-exclamation-triangle-fill text-warning" title="Update Available" style="font-size:1.1rem;"></i>`;
          actionBtnHtml = `<button class="btn btn-cyan btn-sm py-1 rounded-pill" style="font-size: 0.7rem; width: 100px;" id="btn-update-app"><i class="bi bi-github me-1"></i>Releases</button>`;
        } else {
          statusIconHtml = `<i class="bi bi-check-circle-fill text-success" title="Up to Date" style="font-size:1.1rem;"></i>`;
          actionBtnHtml = `<button class="btn btn-outline-secondary btn-sm py-1 rounded-pill disabled" style="font-size: 0.7rem; width: 100px;"><i class="bi bi-shield-check me-1"></i>Latest</button>`;
        }
      } else {
        if (data.local === 'Not Installed') {
          statusIconHtml = `<i class="bi bi-exclamation-octagon-fill text-danger" title="Not Installed" style="font-size:1.1rem;"></i>`;
          actionBtnHtml = `<button class="btn btn-cyan btn-sm py-1 rounded-pill action-install-btn" style="font-size: 0.7rem; width: 100px;" data-component="${key}" data-url="${data.url}" data-version="${data.remote}"><i class="bi bi-download me-1"></i>Install</button>`;
        } else if (data.updateAvailable) {
          statusIconHtml = `<i class="bi bi-exclamation-triangle-fill text-warning" title="Update Available" style="font-size:1.1rem;"></i>`;
          actionBtnHtml = `<button class="btn btn-cyan btn-sm py-1 rounded-pill action-install-btn" style="font-size: 0.7rem; width: 100px;" data-component="${key}" data-url="${data.url}" data-version="${data.remote}"><i class="bi bi-cloud-download me-1"></i>Update</button>`;
        } else {
          statusIconHtml = `<i class="bi bi-check-circle-fill text-success" title="Installed" style="font-size:1.1rem;"></i>`;
          actionBtnHtml = `<button class="btn btn-outline-secondary btn-sm py-1 rounded-pill action-install-btn" style="font-size: 0.7rem; width: 100px;" data-component="${key}" data-url="${data.url}" data-version="${data.remote}"><i class="bi bi-arrow-repeat me-1"></i>Reinstall</button>`;
        }
      }

      itemDiv.innerHTML = `
        <div class="d-flex align-items-center gap-3">
          <div class="rounded-circle p-2 bg-secondary bg-opacity-10 d-flex align-items-center justify-content-center" style="width: 38px; height: 38px;">
            <i class="bi ${details.icon} ${details.color} fs-5"></i>
          </div>
          <div>
            <h6 class="m-0 fw-bold text-white">${details.name}</h6>
            <span class="small text-secondary" style="font-size: 0.7rem;">Local: <strong>${data.local}</strong> | Latest: <strong>${data.remote}</strong></span>
          </div>
        </div>
        <div class="d-flex align-items-center gap-2">
          ${statusIconHtml}
          ${actionBtnHtml}
        </div>
      `;

      listContainer.appendChild(itemDiv);
      
      // Wire click for App Releases button if created
      if (key === 'app' && data.updateAvailable) {
        const updateAppBtn = itemDiv.querySelector('#btn-update-app');
        if (updateAppBtn) {
          updateAppBtn.addEventListener('click', () => {
            window.api.openExternalUrl(data.url);
          });
        }
      }
    });

    // Wire up events on dynamically generated install buttons
    const updateModalEl = document.getElementById('updateModal');
    const updateModal = bootstrap.Modal.getOrCreateInstance(updateModalEl);
    
    listContainer.querySelectorAll('.action-install-btn').forEach(btn => {
      btn.addEventListener('click', async (e) => {
        const comp = btn.getAttribute('data-component');
        const dlUrl = btn.getAttribute('data-url');
        const dlVersion = btn.getAttribute('data-version');

        console.log(`Triggering download for component: ${comp}, url: ${dlUrl}, version: ${dlVersion}`);
        
        // Close update modal first
        updateModal.hide();

        if (comp === 'ffmpeg') {
          await triggerFfmpegDownloadFlow(dlUrl, dlVersion);
        } else if (comp === 'piper') {
          await triggerPiperDownloadFlow(dlUrl, dlVersion);
        } else if (comp === 'whisper') {
          await triggerWhisperDownloadFlow(dlUrl, dlVersion);
        }
      });
    });

    updateModal.show();

  } catch (err) {
    console.error("Update check failed:", err);
    logStatus(`Update Check Error: ${err.message}`, "error");
    await showAppAlert(`Failed to check for updates:\n${err.message}`);
  } finally {
    btnCheckUpdate.classList.remove('disabled');
  }
}

// ----------------------------------------------------
// STT: Whisper Model Syncing & Downloading
// ----------------------------------------------------
async function syncModels() {
  try {
    availableModels = await window.api.getAvailableModels();
    console.log('[Models] Downloaded Whisper models found:', availableModels);

    // Update select options to indicate cached vs cloud status
    Array.from(modelSelect.options).forEach(opt => {
      const isDownloaded = availableModels.includes(opt.value);
      const info = WHISPER_MODEL_INFO[opt.value] || { name: opt.value, size: 'Unknown size' };
      const statusText = isDownloaded ? '[Cached]' : '[Cloud Download]';
      opt.innerText = `${info.name} (${info.size}) ${statusText}`;
    });
  } catch (err) {
    console.error('[Models] Sync failed:', err);
  }
}

async function ensureModelDownloaded() {
  const targetModel = modelSelect.value;
  try {
    const available = await window.api.getAvailableModels();
    availableModels = available || [];
  } catch (syncErr) {
    console.warn('[Model Check Warning] Failed to fetch downloaded models:', syncErr);
  }

  const isDownloaded = availableModels.includes(targetModel);
  if (!isDownloaded) {
    if (await isDownloadInProgress()) return false;
    // Show download UI
    modelDownloadOverlay.style.setProperty('display', 'flex', 'important');
    const info = WHISPER_MODEL_INFO[targetModel] || { name: targetModel };
    downloadTitle.innerText = `Downloading ${info.name}`;
    downloadProgressBar.style.width = '0%';
    downloadBytes.innerText = '0 / 0 MB';
    downloadPct.innerText = '0%';

    // Bind progress IPC listener
    window.api.onDownloadProgress((data) => {
      if (data.modelName === targetModel) {
        const dlMB = (data.downloaded / 1024 / 1024).toFixed(1);
        const totMB = (data.total / 1024 / 1024).toFixed(1);
        downloadBytes.innerText = `${dlMB} / ${totMB} MB`;
        downloadProgressBar.style.width = `${data.percentage}%`;
        downloadPct.innerText = `${data.percentage}%`;
      }
    });

    logStatus(`Downloading model ${targetModel} from Hugging Face...`);
    try {
      const res = await window.api.downloadModel(targetModel);
      if (res.success) {
        logStatus(`Model ${targetModel} downloaded successfully.`);
        await syncModels();
        return true;
      } else {
        throw new Error(res.error || 'Server connection error during model download');
      }
    } catch (err) {
      console.error('[Model Download Error]', err);
      await showAppAlert(`Model Download Failed:\n${err.message}`);
      return false;
    } finally {
      modelDownloadOverlay.style.setProperty('display', 'none', 'important');
    }
  }
  return true;
}

async function handleModelChange() {
  const targetModel = modelSelect.value;
  logStatus(`Whisper model switch requested: ${targetModel}`);

  const isReady = await ensureModelDownloaded();
  if (!isReady) {
    modelSelect.value = currentModel;
    return;
  }

  // Swap active model inside Main process
  try {
    const swapRes = await window.api.setActiveModel(targetModel);
    if (swapRes.success) {
      currentModel = targetModel;
      logStatus(`Active Whisper model switched to: ${currentModel}`);
    } else {
      throw new Error('Failed to configure target model');
    }
  } catch (err) {
    console.error(err);
    await showAppAlert(`Failed to set model:\n${err.message}`);
    modelSelect.value = currentModel;
  }
}

// ----------------------------------------------------
// Event Listeners Registration
// ----------------------------------------------------
function setupEventListeners() {
  if (isEventListenersSetup) return;
  isEventListenersSetup = true;

  // Model Select Dropdown
  modelSelect.addEventListener('change', handleModelChange);

  // Mic Recording Button
  btnToggleRecord.addEventListener('click', toggleRecording);

  // Playback raw recording diagnostics
  btnPlayMic.addEventListener('click', toggleMicPlayback);

  // Audio Upload - Select file browse
  audioFilePicker.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleAudioFileSelected(e.target.files[0]);
    }
  });

  // Audio Upload - Drag & Drop Handlers
  audioDropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    audioDropZone.classList.add('dragover');
  });

  audioDropZone.addEventListener('dragleave', () => {
    audioDropZone.classList.remove('dragover');
  });

  audioDropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    audioDropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
      handleAudioFileSelected(e.dataTransfer.files[0]);
    }
  });

  // Process manual audio file upload button
  btnProcessUpload.addEventListener('click', processAudioUpload);

  // Copy to clipboard
  btnCopyStt.addEventListener('click', copyTranscriptToClipboard);
  btnFullscreenStt.addEventListener('click', toggleSttFullscreen);

  // Download local engines from UI dropdown options
  btnDownloadFfmpegUi.addEventListener('click', (e) => {
    e.preventDefault();
    triggerFfmpegDownloadFlow();
  });
  btnDownloadPiperUi.addEventListener('click', (e) => {
    e.preventDefault();
    triggerPiperDownloadFlow();
  });
  btnDownloadWhisperUi.addEventListener('click', (e) => {
    e.preventDefault();
    triggerWhisperDownloadFlow();
  });
  btnCheckUpdate.addEventListener('click', (e) => {
    e.preventDefault();
    triggerCheckUpdateFlow();
  });

  // Clear activity logs
  btnClearLogs.addEventListener('click', () => {
    if (logConsole) {
      logConsole.innerHTML = '<div class="text-info">[System] Logs cleared. Console active.</div>';
    }
  });

  // TTS Synthesize & Voice Select Change
  btnSynthesize.addEventListener('click', synthesizeText);
  voiceSelect.addEventListener('change', handleVoiceChange);
  btnPasteTts.addEventListener('click', pasteFromClipboard);
  btnFullscreenTts.addEventListener('click', toggleTtsFullscreen);

  // Speech speed slider
  speedSlider.addEventListener('input', (e) => {
    speedValue.innerText = `${parseFloat(e.target.value).toFixed(1)}x`;
  });

  // Sentence silence slider
  silenceSlider.addEventListener('input', (e) => {
    silenceValue.innerText = `${parseFloat(e.target.value).toFixed(1)}s`;
  });

  // Noise scale slider
  noiseScaleSlider.addEventListener('input', (e) => {
    noiseScaleValue.innerText = `${parseFloat(e.target.value).toFixed(2)}`;
  });

  // Noise W slider
  noiseWSlider.addEventListener('input', (e) => {
    noiseWValue.innerText = `${parseFloat(e.target.value).toFixed(2)}`;
  });

  // Import TXT file picker
  textFilePicker.addEventListener('change', (e) => {
    if (e.target.files.length > 0) {
      handleTextFileImport(e.target.files[0]);
    }
  });

  // Drag and drop text file on TTS input area
  ttsInput.addEventListener('dragover', (e) => {
    e.preventDefault();
    ttsInput.classList.add('border-primary');
  });

  ttsInput.addEventListener('dragleave', () => {
    ttsInput.classList.remove('border-primary');
  });

  ttsInput.addEventListener('drop', (e) => {
    e.preventDefault();
    ttsInput.classList.remove('border-primary');
    if (e.dataTransfer.files.length > 0) {
      handleTextFileImport(e.dataTransfer.files[0]);
    }
  });

  // Custom Audio Player Listeners
  btnPlayPause.addEventListener('click', toggleAudioPlayback);
  audioPlayback.addEventListener('timeupdate', updateAudioPlayerProgress);
  audioPlayback.addEventListener('loadedmetadata', updateAudioPlayerMetadata);
  audioPlayback.addEventListener('ended', onAudioPlaybackEnded);
  playerProgressArea.addEventListener('click', seekAudioPlayback);

  // Listen to menu bar triggers to download FFmpeg
  window.api.onTriggerFfmpegDownload(() => {
    triggerFfmpegDownloadFlow();
  });

  // Listen to download progress status events
  window.api.onFfmpegProgress((data) => {
    logStatus(`[FFmpeg Downloader] ${data.msg}`);

    // Update progress overlay visuals dynamically
    downloadTitle.innerText = 'Downloading FFmpeg';
    downloadProgressBar.style.width = `${data.progress}%`;
    downloadPct.innerText = `${data.progress}%`;
    downloadBytes.innerText = data.msg;
  });

  // Listen to menu bar triggers to download Piper
  window.api.onTriggerPiperDownload(() => {
    triggerPiperDownloadFlow();
  });

  window.api.onPiperProgress((data) => {
    logStatus(`[Piper Downloader] ${data.msg}`);
    downloadTitle.innerText = 'Downloading Piper Engine';
    downloadProgressBar.style.width = `${data.progress}%`;
    downloadPct.innerText = `${data.progress}%`;
    downloadBytes.innerText = data.msg;
  });

  // Listen to menu bar triggers to download Whisper engine
  window.api.onTriggerWhisperDownload(() => {
    triggerWhisperDownloadFlow();
  });

  window.api.onWhisperProgress((data) => {
    logStatus(`[Whisper Downloader] ${data.msg}`);
    downloadTitle.innerText = 'Downloading Whisper Engine';
    downloadProgressBar.style.width = `${data.progress}%`;
    downloadPct.innerText = `${data.progress}%`;
    downloadBytes.innerText = data.msg;
  });

  // Custom Window Controls listeners
  titleBarMinimize.addEventListener('click', () => {
    window.api.minimizeWindow();
  });

  titleBarMaximize.addEventListener('click', () => {
    window.api.maximizeWindow();
  });

  titleBarClose.addEventListener('click', () => {
    window.api.closeWindow();
  });

  // Handle changing maximize icon state from the main process events
  window.api.onWindowMaximizedState((isMaximized) => {
    if (isMaximized) {
      maximizeIcon.className = 'bi bi-back';
    } else {
      maximizeIcon.className = 'bi bi-square';
    }
  });

  // Settings & Info click listeners
  if (titleBarSettings) {
    titleBarSettings.addEventListener('click', () => {
      logStatus('Settings toggled from title bar.', 'system');
      alert('Settings panel under active development for SpeechBoleh Beta!');
    });
  }

  titleBarInfo.addEventListener('click', () => {
    logStatus('About dialog opened from title bar.', 'system');
  });
}

// ----------------------------------------------------
// Microphone Recording Logic
// ----------------------------------------------------
async function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    stopRecording();
  } else {
    await startRecording();
  }
}

async function startRecording() {
  try {
    // Clean up previous raw mic file from disk if it exists
    if (lastMicRecordingPath) {
      try {
        await window.api.deleteFile(lastMicRecordingPath);
      } catch (e) { }
      lastMicRecordingPath = null;
      btnPlayMic.disabled = true;
      playMicIcon.className = 'bi bi-play-fill';
    }

    logStatus('Accessing system microphone...');
    const selectedMicId = micSelect.value;
    const constraints = {
      audio: selectedMicId ? { deviceId: { exact: selectedMicId } } : true
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);

    // Repopulate mics now that we have active permission to get device labels
    await populateMics();
    if (selectedMicId) {
      micSelect.value = selectedMicId;
    }

    mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
    audioChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) {
        audioChunks.push(e.data);
      }
    };

    mediaRecorder.onstop = async () => {
      logStatus('Microphone recording stopped. Transcoding soundwave...', 'system');

      // Stop all tracks on the stream to release the mic hardware immediately
      stream.getTracks().forEach(track => track.stop());

      // Show loader
      sttLoadingOverlay.style.display = 'flex';

      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      console.log(`[Recorder] Recording ended. Captured Blob size: ${audioBlob.size} bytes.`);
      const arrayBuffer = await audioBlob.arrayBuffer();
      const uint8Array = new Uint8Array(arrayBuffer);

      try {
        // 1. Save recorded raw audio bytes to WebM file
        const saveRes = await window.api.saveMicAudio(uint8Array);
        if (!saveRes.success) {
          throw new Error(saveRes.error || 'Failed to save temporary microphone asset');
        }

        const rawMicPath = saveRes.filePath;
        lastMicRecordingPath = rawMicPath; // Hold reference for diagnostics play
        btnPlayMic.disabled = false; // Enable playback button

        logStatus(`Mic data captured (${formatBytes(audioBlob.size)}). Running local Whisper.cpp...`, 'system');

        // Check/Download model first if selected model is missing
        sttLoadingOverlay.style.display = 'none';
        const isModelReady = await ensureModelDownloaded();
        sttLoadingOverlay.style.display = 'flex';
        if (!isModelReady) {
          throw new Error('Required Whisper model file is not downloaded.');
        }

        // 2. Process transcription pipeline
        const selectedLang = languageSelect ? languageSelect.value : 'auto';
        const transRes = await window.api.sttTranscribe(rawMicPath, selectedLang);

        // Note: We do NOT delete rawMicPath here now, so the user can play it back to check audio levels.
        // It is cleaned up when a new recording starts or when the app closes.

        if (transRes.success) {
          updateSttOutput(transRes.text);
          logStatus('Speech-to-text transcription successfully loaded.', 'success');
        } else {
          throw new Error(transRes.error || 'Whisper pipeline returned failure');
        }

      } catch (err) {
        console.error('Mic STT processing error:', err);
        logStatus(`STT Error: ${err.message}`, 'error');
        await showAppAlert(`Speech-to-Text Pipeline Failed:\n${err.message}`);
      } finally {
        sttLoadingOverlay.style.display = 'none';
      }
    };

    // Begin recording
    mediaRecorder.start();
    recordStartTime = Date.now();

    // Toggle UI State
    btnToggleRecord.classList.add('recording');
    recordIcon.className = 'bi bi-stop-fill text-white';
    recordStatus.innerText = 'Recording Microphone...';
    recordStatus.classList.add('text-danger');
    recordProgressContainer.style.display = 'block';

    // Start UI bar bounce animations
    Array.from(recordingVisualizer.children).forEach(bar => {
      bar.classList.add('recording');
    });

    // Start timer interval updates
    recordTimerInterval = setInterval(updateRecordTimer, 100);
    logStatus('Capturing real-time audio input...');

  } catch (err) {
    console.error('Failed to get mic access', err);
    logStatus(`Permissions error: ${err.message}`);
    await showAppAlert(`Microphone Permission Blocked:\nEnsure permission check handlers are active in main.js. Details: ${err.message}`);
  }
}

function stopRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') {
    mediaRecorder.stop();
  }

  // Restore UI Controls
  btnToggleRecord.classList.remove('recording');
  recordIcon.className = 'bi bi-mic-fill';
  recordStatus.innerText = 'Microphone Standby';
  recordStatus.classList.remove('text-danger');
  recordProgressContainer.style.display = 'none';

  // Stop UI wave bounces
  Array.from(recordingVisualizer.children).forEach(bar => {
    bar.classList.remove('recording');
  });

  // Stop Timer
  clearInterval(recordTimerInterval);
}

function updateRecordTimer() {
  const elapsedMs = Date.now() - recordStartTime;
  const minutes = Math.floor(elapsedMs / 60000);
  const seconds = Math.floor((elapsedMs % 60000) / 1000);
  const tenths = Math.floor((elapsedMs % 1000) / 100);

  const paddedMin = String(minutes).padStart(2, '0');
  const paddedSec = String(seconds).padStart(2, '0');

  recordTimer.innerText = `${paddedMin}:${paddedSec}.${tenths}`;
}

// ----------------------------------------------------
// Play Microphone Diagnostics
// ----------------------------------------------------
function toggleMicPlayback() {
  if (!lastMicRecordingPath) return;

  const micUrl = `media://${encodeURIComponent(lastMicRecordingPath)}`;

  // If already loaded, toggle play/pause
  if (audioPlayback.src === micUrl || audioPlayback.src.endsWith(encodeURIComponent(lastMicRecordingPath))) {
    if (audioPlayback.paused) {
      audioPlayback.play();
      playMicIcon.className = 'bi bi-pause-fill';
      playIcon.className = 'bi bi-pause-fill';
    } else {
      audioPlayback.pause();
      playMicIcon.className = 'bi bi-play-fill';
      playIcon.className = 'bi bi-play-fill';
    }
  } else {
    // Load mic track
    audioPlayback.src = micUrl;
    playerFilename.innerText = 'Raw Microphone Recording';
    playerFilesize.innerText = 'Local WebM Audio';
    btnPlayPause.disabled = false;

    audioPlayback.play();
    playMicIcon.className = 'bi bi-pause-fill';
    playIcon.className = 'bi bi-pause-fill';
    logStatus('Playing back raw microphone recording...');
  }
}

// ----------------------------------------------------
// File Upload STT Logic
// ----------------------------------------------------
function handleAudioFileSelected(file) {
  selectedAudioFile = file;

  uploadFilename.innerText = file.name;
  uploadFilesize.innerText = formatBytes(file.size);
  selectedFileInfo.classList.remove('d-none');

  logStatus(`Audio file selected: ${file.name}`);
}

async function processAudioUpload() {
  if (!selectedAudioFile) return;

  logStatus(`Sending audio file ${selectedAudioFile.name} to local processing...`, 'system');
  sttLoadingOverlay.style.display = 'flex';

  try {
    const localFilePath = selectedAudioFile.path;
    if (!localFilePath) {
      throw new Error('Local file system path could not be resolved');
    }

    // Check/Download model first if selected model is missing
    sttLoadingOverlay.style.display = 'none';
    const isModelReady = await ensureModelDownloaded();
    sttLoadingOverlay.style.display = 'flex';
    if (!isModelReady) {
      throw new Error('Required Whisper model file is not downloaded.');
    }

    const selectedLang = languageSelect ? languageSelect.value : 'auto';
    const res = await window.api.sttTranscribe(localFilePath, selectedLang);
    if (res.success) {
      updateSttOutput(res.text);
      logStatus(`Transcribed uploaded audio file: ${selectedAudioFile.name}`, 'success');
    } else {
      throw new Error(res.error || 'Whisper processing failed');
    }
  } catch (err) {
    console.error('Audio file STT error:', err);
    logStatus(`STT Error: ${err.message}`, 'error');
    await showAppAlert(`Speech-to-Text Pipeline Failed:\n${err.message}`);
  } finally {
    sttLoadingOverlay.style.display = 'none';
  }
}

function updateSttOutput(text) {
  sttOutput.value = text || '(Whisper detected silence or no speech in source)';
  sttCharCount.innerText = `${text ? text.length : 0} characters`;
  btnCopyStt.disabled = !text;
}

async function copyTranscriptToClipboard() {
  if (!sttOutput.value) return;
  try {
    const res = await window.api.copyToClipboard(sttOutput.value);
    if (res.success) {
      logStatus('Transcript copied to clipboard.', 'success');
    } else {
      throw new Error(res.error || 'Native clipboard access failed');
    }
  } catch (err) {
    console.error('Fallback clipboard copy failed:', err);
    // Fall back to standard browser Clipboard API
    try {
      await navigator.clipboard.writeText(sttOutput.value);
      logStatus('Transcript copied to clipboard (browser fallback).', 'success');
    } catch (browserErr) {
      logStatus(`Clipboard Copy Error: ${browserErr.message}`, 'error');
    }
  }

  const originalText = btnCopyStt.innerHTML;
  btnCopyStt.innerHTML = '<i class="bi bi-check-lg me-1"></i>Copied!';
  setTimeout(() => {
    btnCopyStt.innerHTML = originalText;
  }, 2000);
}

let isSttFullscreen = false;
function toggleSttFullscreen() {
  isSttFullscreen = !isSttFullscreen;
  const container = document.getElementById('stt-output-container');
  const placeholder = document.getElementById('stt-placeholder');

  if (container) {
    if (isSttFullscreen) {
      // Move element to document body to bypass parent stacking contexts (e.g. backdrop-filter)
      document.body.appendChild(container);
      container.classList.add('fullscreen-active');
      btnFullscreenStt.innerHTML = '<i class="bi bi-fullscreen-exit me-1"></i>Exit Fullscreen';
      logStatus('Entered fullscreen transcript view.', 'system');
    } else {
      // Return element to original place in the flex layout
      if (placeholder) {
        placeholder.parentNode.insertBefore(container, placeholder.nextSibling);
      }
      container.classList.remove('fullscreen-active');
      btnFullscreenStt.innerHTML = '<i class="bi bi-arrows-fullscreen me-1"></i>Fullscreen';
      logStatus('Exited fullscreen transcript view.', 'system');
    }
  }
}

let isTtsFullscreen = false;
function toggleTtsFullscreen() {
  isTtsFullscreen = !isTtsFullscreen;
  const container = document.getElementById('tts-input-container');
  const placeholder = document.getElementById('tts-placeholder');

  if (container) {
    if (isTtsFullscreen) {
      // Move element to document body to bypass parent stacking contexts (e.g. backdrop-filter)
      document.body.appendChild(container);
      container.classList.add('fullscreen-active');
      btnFullscreenTts.innerHTML = '<i class="bi bi-fullscreen-exit me-1"></i>Exit Fullscreen';
      logStatus('Entered fullscreen text input view.', 'system');
    } else {
      // Return element to original place in the flex layout
      if (placeholder) {
        placeholder.parentNode.insertBefore(container, placeholder.nextSibling);
      }
      container.classList.remove('fullscreen-active');
      btnFullscreenTts.innerHTML = '<i class="bi bi-arrows-fullscreen me-1"></i>Fullscreen';
      logStatus('Exited fullscreen text input view.', 'system');
    }
  }
}

// ----------------------------------------------------
// Text File Import & TTS Logic
// ----------------------------------------------------
async function handleTextFileImport(file) {
  if (file.type !== 'text/plain' && !file.name.endsWith('.txt')) {
    await showAppAlert('Please import a valid plain text file (.txt).');
    return;
  }

  logStatus(`Reading text file: ${file.name}...`);
  try {
    const res = await window.api.readTextFile(file.path);
    if (res.success) {
      ttsInput.value = res.text;

      importedTxtFilename.innerText = file.name;
      textImportAlert.classList.remove('d-none');
      logStatus(`Successfully loaded text file content: ${file.name}`);
    } else {
      throw new Error(res.error);
    }
  } catch (err) {
    console.error('Failed to read text file:', err);
    logStatus(`Read file error: ${err.message}`);
  }
}

async function pasteFromClipboard() {
  try {
    const res = await window.api.readClipboard();
    if (res.success) {
      if (res.text) {
        ttsInput.value = res.text;
        logStatus('Pasted text from clipboard into text input.', 'success');
      } else {
        logStatus('Clipboard is empty or does not contain text.', 'warning');
      }
    } else {
      throw new Error(res.error || 'Native clipboard read failed');
    }
  } catch (err) {
    console.error('Fallback clipboard read failed:', err);
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        ttsInput.value = text;
        logStatus('Pasted text from clipboard (browser fallback).', 'success');
      } else {
        logStatus('Clipboard is empty or does not contain text.', 'warning');
      }
    } catch (browserErr) {
      logStatus(`Clipboard Paste Error: ${browserErr.message}`, 'error');
    }
  }
}

function clearTextImport() {
  textImportAlert.classList.add('d-none');
  ttsInput.value = '';
}

// ----------------------------------------------------
// TTS Speech Synthesis Logic
// ----------------------------------------------------
async function synthesizeText() {
  const text = ttsInput.value.trim();
  const selectedVoice = voiceSelect.value;

  if (!text) {
    await showAppAlert('Please enter or import text to synthesize!');
    return;
  }

  // Pre-cleanup check: Delete previously generated voice asset if it exists
  if (generatedAudioPath) {
    try {
      await window.api.deleteFile(generatedAudioPath);
    } catch (e) { }
    generatedAudioPath = null;
  }

  // Ensure the selected voice model is downloaded
  const cachedVoices = await window.api.getVoices();
  if (!cachedVoices.includes(selectedVoice)) {
    logStatus(`Voice model ${selectedVoice} not cached. Initializing download...`, 'warning');
    await handleVoiceChange();
    const updatedVoices = await window.api.getVoices();
    if (!updatedVoices.includes(selectedVoice)) {
      logStatus('Voice model download aborted or failed. Synthesis cancelled.', 'error');
      return;
    }
  }

  logStatus('Synthesizing speech locally via Piper neural engine...', 'system');
  ttsLoadingOverlay.style.display = 'flex';

  try {
    const speed = parseFloat(speedSlider.value) || 1.0;
    const silence = parseFloat(silenceSlider.value) || 0.2;
    const noiseScale = parseFloat(noiseScaleSlider.value) || 0.67;
    const noiseW = parseFloat(noiseWSlider.value) || 0.8;
    const res = await window.api.ttsSynthesize(text, selectedVoice, speed, silence, noiseScale, noiseW);
    if (res.success) {
      generatedAudioPath = res.localPath;
      generatedAudioUrl = res.audioUrl;

      // Load into audio playback engine
      audioPlayback.src = res.audioUrl;
      playerFilename.innerText = pathBasename(res.localPath);
      playerFilesize.innerText = 'Calculating size...';

      btnPlayPause.disabled = false;

      audioPlayback.play();
      playIcon.className = 'bi bi-pause-fill';
      logStatus('Speech synthesized successfully. Playing...', 'success');
    } else {
      throw new Error(res.error || 'Piper Engine threw an error');
    }
  } catch (err) {
    console.error('TTS Synthesis error:', err);
    logStatus(`TTS Error: ${err.message}`, 'error');
    await showAppAlert(`Text-to-Speech Engine Failed:\n${err.message}`);
  } finally {
    ttsLoadingOverlay.style.display = 'none';
  }
}

// ----------------------------------------------------
// Custom Audio Player Logic
// ----------------------------------------------------
function toggleAudioPlayback() {
  const isMic = audioPlayback.src.includes('recording_');
  if (audioPlayback.paused) {
    audioPlayback.play();
    playIcon.className = 'bi bi-pause-fill';
    if (isMic) playMicIcon.className = 'bi bi-pause-fill';
  } else {
    audioPlayback.pause();
    playIcon.className = 'bi bi-play-fill';
    if (isMic) playMicIcon.className = 'bi bi-play-fill';
  }
}

function onAudioPlaybackEnded() {
  playIcon.className = 'bi bi-play-fill';
  playMicIcon.className = 'bi bi-play-fill';
  playerBar.style.width = '0%';
  audioPlayback.currentTime = 0;
  logStatus('Speech playback finished.');
}

function updateAudioPlayerProgress() {
  if (!audioPlayback.duration) return;

  const pct = (audioPlayback.currentTime / audioPlayback.duration) * 100;
  playerBar.style.width = `${pct}%`;

  const currentStr = formatTime(audioPlayback.currentTime);
  const durationStr = formatTime(audioPlayback.duration);
  playerTime.innerText = `${currentStr} / ${durationStr}`;
}

function updateAudioPlayerMetadata() {
  const durationStr = formatTime(audioPlayback.duration);
  playerTime.innerText = `00:00 / ${durationStr}`;
}

function seekAudioPlayback(e) {
  const rect = playerProgressArea.getBoundingClientRect();
  const clickX = e.clientX - rect.left;
  const pct = clickX / rect.width;

  if (audioPlayback.duration) {
    audioPlayback.currentTime = pct * audioPlayback.duration;
  }
}

// ----------------------------------------------------
// Auxiliary Format Helpers
// ----------------------------------------------------
function formatTime(seconds) {
  if (isNaN(seconds)) return '00:00';
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 Bytes';
  const k = 1024;
  const sizes = ['Bytes', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function pathBasename(fullPath) {
  return fullPath.split(/[/\\]/).pop();
}
