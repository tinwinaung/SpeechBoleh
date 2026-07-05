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

// Whisper Model Downloader & Diagnostics elements
const modelSelect = document.getElementById('model-select');
const btnPlayMic = document.getElementById('btn-play-mic');
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

// ----------------------------------------------------
// System Initialization
// ----------------------------------------------------
window.addEventListener('DOMContentLoaded', async () => {
  logStatus('Starting local SpeechBoleh services...', 'system');
  logStatus('Scanning system microphones...', 'info');
  await populateMics();
  logStatus('Initializing local SAPI / Piper voice lists...', 'info');
  await populateVoices();
  logStatus('Syncing offline Whisper model weights...', 'info');
  await syncModels();
  setupEventListeners();
  logStatus('System ready. All offline pipelines successfully loaded.', 'success');
});

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
// TTS: Populate Voices from System
// ----------------------------------------------------
async function populateVoices() {
  try {
    const cachedVoices = await window.api.getVoices();
    console.log('[Voices] Downloaded Piper voices found:', cachedVoices);

    Array.from(voiceSelect.options).forEach(opt => {
      const isDownloaded = cachedVoices.includes(opt.value);
      const voiceLabel = opt.value === 'en_US-lessac-medium.onnx' ? 'Lessac (Medium, Female)' :
        opt.value === 'en_US-joe-medium.onnx' ? 'Joe (Medium, Male)' : 'Ryan (Medium, Male)';
      if (isDownloaded) {
        opt.innerText = `${voiceLabel} [Cached]`;
      } else {
        opt.innerText = `${voiceLabel} [Cloud Download]`;
      }
    });
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
    // Show download UI (reusing modelDownloadOverlay)
    modelDownloadOverlay.style.display = 'flex';
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
      alert(`Voice Download Failed:\n${err.message}\nReverting selection.`);
      // Revert select back to default Lessac model
      voiceSelect.value = 'en_US-lessac-medium.onnx';
      return;
    } finally {
      modelDownloadOverlay.style.display = 'none';
    }
  }
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

async function triggerFfmpegDownloadFlow() {
  const choice = confirm("This action will download and extract the latest FFmpeg Essentials build (approx. 90MB) from gyan.dev directly into your bin/ folder.\n\nAre you sure you want to download and install FFmpeg now?");
  if (!choice) return;

  logStatus("Starting FFmpeg download & installation process...", "system");
  
  // Show the download progress overlay
  downloadTitle.innerText = "Downloading FFmpeg";
  const descEl = modelDownloadOverlay.querySelector('p');
  const originalDesc = descEl ? descEl.innerText : '';
  if (descEl) {
    descEl.innerText = "Fetching latest binaries and configuring environment. This may take a few minutes depending on your internet connection.";
  }
  downloadProgressBar.style.width = '0%';
  downloadBytes.innerText = 'Initializing...';
  downloadPct.innerText = '0%';
  modelDownloadOverlay.classList.remove('d-none');

  try {
    const res = await window.api.downloadFfmpeg();
    if (res.success) {
      logStatus(`FFmpeg configured successfully at: ${res.path}`, "success");
      alert(`FFmpeg downloaded and configured successfully!`);
    } else {
      throw new Error(res.error || "Unknown configuration error");
    }
  } catch (err) {
    console.error("FFmpeg deployment failed:", err);
    logStatus(`FFmpeg Deployment Error: ${err.message}`, "error");
    alert(`FFmpeg setup failed:\n${err.message}`);
  } finally {
    modelDownloadOverlay.classList.add('d-none');
    if (descEl) descEl.innerText = originalDesc;
  }
}

async function triggerPiperDownloadFlow() {
  const choice = confirm("This action will download and extract the latest prebuilt Piper TTS Engine (approx. 22MB) from GitHub directly into your bin/ folder.\n\nAre you sure you want to download and install the Piper Engine now?");
  if (!choice) return;

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
  modelDownloadOverlay.classList.remove('d-none');

  try {
    const res = await window.api.downloadPiper();
    if (res.success) {
      logStatus(`Piper engine configured successfully at: ${res.path}`, "success");
      alert(`Piper engine downloaded and configured successfully!`);
      // Update voice lists to reflect potential new path sync
      await populateVoices();
    } else {
      throw new Error(res.error || "Unknown configuration error");
    }
  } catch (err) {
    console.error("Piper deployment failed:", err);
    logStatus(`Piper Deployment Error: ${err.message}`, "error");
    alert(`Piper setup failed:\n${err.message}`);
  } finally {
    modelDownloadOverlay.classList.add('d-none');
    if (descEl) descEl.innerText = originalDesc;
  }
}

async function triggerWhisperDownloadFlow() {
  const choice = confirm("This action will download and extract the prebuilt Whisper.cpp CPU Engine (approx. 8MB) from GitHub directly into your bin/ folder.\n\nAre you sure you want to download and install the Whisper.cpp Engine now?");
  if (!choice) return;

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
  modelDownloadOverlay.classList.remove('d-none');

  try {
    const res = await window.api.downloadWhisperEngine();
    if (res.success) {
      logStatus(`Whisper engine configured successfully at: ${res.path}`, "success");
      alert(`Whisper.cpp engine downloaded and configured successfully!`);
      // Update models list to reflect new paths
      await syncModels();
    } else {
      throw new Error(res.error || "Unknown configuration error");
    }
  } catch (err) {
    console.error("Whisper deployment failed:", err);
    logStatus(`Whisper Deployment Error: ${err.message}`, "error");
    alert(`Whisper setup failed:\n${err.message}`);
  } finally {
    modelDownloadOverlay.classList.add('d-none');
    if (descEl) descEl.innerText = originalDesc;
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
      if (isDownloaded) {
        opt.innerText = opt.value === 'ggml-tiny.bin' ? 'Tiny Model (75MB) [Cached]' : 'Base Model (142MB) [Cached]';
      } else {
        opt.innerText = opt.value === 'ggml-tiny.bin' ? 'Tiny Model (75MB) [Cloud Download]' : 'Base Model (142MB) [Cloud Download]';
      }
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
    // Show download UI
    modelDownloadOverlay.style.display = 'flex';
    downloadTitle.innerText = `Downloading ${targetModel === 'ggml-tiny.bin' ? 'Tiny Model' : 'Base Model'}`;
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
      alert(`Model Download Failed:\n${err.message}`);
      return false;
    } finally {
      modelDownloadOverlay.style.display = 'none';
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
    alert(`Failed to set model:\n${err.message}`);
    modelSelect.value = currentModel;
  }
}

// ----------------------------------------------------
// Event Listeners Registration
// ----------------------------------------------------
function setupEventListeners() {
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
        const transRes = await window.api.sttTranscribe(rawMicPath);

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
        alert(`Speech-to-Text Pipeline Failed:\n${err.message}`);
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
    alert(`Microphone Permission Blocked:\nEnsure permission check handlers are active in main.js. Details: ${err.message}`);
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

    const res = await window.api.sttTranscribe(localFilePath);
    if (res.success) {
      updateSttOutput(res.text);
      logStatus(`Transcribed uploaded audio file: ${selectedAudioFile.name}`, 'success');
    } else {
      throw new Error(res.error || 'Whisper processing failed');
    }
  } catch (err) {
    console.error('Audio file STT error:', err);
    logStatus(`STT Error: ${err.message}`, 'error');
    alert(`Speech-to-Text Pipeline Failed:\n${err.message}`);
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
    alert('Please import a valid plain text file (.txt).');
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
    alert('Please enter or import text to synthesize!');
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
    alert(`Text-to-Speech Engine Failed:\n${err.message}`);
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
