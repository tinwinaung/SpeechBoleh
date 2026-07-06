const { contextBridge, ipcRenderer } = require('electron');

// Secure contextBridge to expose IPC channels to the Renderer process
contextBridge.exposeInMainWorld('api', {
  /**
   * Transcribe an audio file (microphone capture or upload) via local whisper.cpp
   * @param {string} filePath - Absolute path to the source audio file
   * @returns {Promise<{success: boolean, text?: string, error?: string}>}
   */
  sttTranscribe: (filePath) => ipcRenderer.invoke('audio-stt', filePath),

  /**
   * Saves raw microphone audio chunk buffer to the main process temp space
   * @param {ArrayBuffer} arrayBuffer - Raw bytes of the recorded audio blob
   * @returns {Promise<{success: boolean, filePath?: string, error?: string}>}
   */
  saveMicAudio: (arrayBuffer) => ipcRenderer.invoke('save-mic-audio', arrayBuffer),

  /**
   * Synthesize text to speech wav file using say library SAPI backend
   * @param {string} text - Text to speak
   * @param {string} voice - SAPI voice name
   * @returns {Promise<{success: boolean, audioUrl?: string, localPath?: string, error?: string}>}
   */
  ttsSynthesize: (text, voice, speed, silence, noiseScale, noiseW) => ipcRenderer.invoke('tts-synthesize', { text, voice, speed, silence, noiseScale, noiseW }),

  /**
   * Read contents of a local text file (.txt)
   * @param {string} filePath - Absolute path of the text file
   * @returns {Promise<{success: boolean, text?: string, error?: string}>}
   */
  readTextFile: (filePath) => ipcRenderer.invoke('read-text-file', filePath),

  /**
   * Unlink/delete a specific temporary file after execution finishes
   * @param {string} filePath - Absolute path to be deleted
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  deleteFile: (filePath) => ipcRenderer.invoke('delete-file', filePath),

  /**
   * Fetch SAPI voices installed on the system
   * @returns {Promise<string[]>}
   */
  getVoices: () => ipcRenderer.invoke('get-voices'),

  /**
   * Query all locally available whisper models
   * @returns {Promise<string[]>}
   */
  getAvailableModels: () => ipcRenderer.invoke('get-available-models'),

  /**
   * Switch the current active Whisper model
   * @param {string} modelName - e.g., 'ggml-tiny.bin'
   * @returns {Promise<{success: boolean, activeModel: string}>}
   */
  setActiveModel: (modelName) => ipcRenderer.invoke('set-active-model', modelName),

  /**
   * Download a Whisper model from Hugging Face
   * @param {string} modelName - e.g., 'ggml-base.bin'
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  downloadModel: (modelName) => ipcRenderer.invoke('download-model', modelName),

  /**
   * Listen for model download progress events
   * @param {function} callback - Called with progress data {modelName, downloaded, total, percentage}
   */
  onDownloadProgress: (callback) => {
    ipcRenderer.removeAllListeners('download-progress');
    ipcRenderer.on('download-progress', (event, data) => callback(data));
  },

  /**
   * Download a Piper voice model from Hugging Face
   * @param {string} voiceName - e.g., 'en_US-joe-medium.onnx'
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  downloadVoiceModel: (voiceName) => ipcRenderer.invoke('download-voice-model', voiceName),

  /**
   * Listen for Piper voice model download progress events
   * @param {function} callback - Called with progress data {voiceName, downloaded, total, percentage}
   */
  onVoiceDownloadProgress: (callback) => {
    ipcRenderer.removeAllListeners('voice-download-progress');
    ipcRenderer.on('voice-download-progress', (event, data) => callback(data));
  },

  /**
   * Copy text to system clipboard using native Electron shell module
   * @param {string} text - Text to copy
   * @returns {Promise<{success: boolean, error?: string}>}
   */
  copyToClipboard: (text) => ipcRenderer.invoke('copy-to-clipboard', text),

  /**
   * Read text from system clipboard using native Electron shell module
   * @returns {Promise<{success: boolean, text?: string, error?: string}>}
   */
  readClipboard: () => ipcRenderer.invoke('read-clipboard'),

  /**
   * Trigger FFmpeg download from backend
   * @returns {Promise<{success: boolean, path?: string, error?: string}>}
   */
  downloadFfmpeg: () => ipcRenderer.invoke('download-ffmpeg'),

  /**
   * Event listener for FFmpeg download progress
   * @param {function} callback
   */
  onFfmpegProgress: (callback) => ipcRenderer.on('ffmpeg-download-progress', (event, data) => callback(data)),

  /**
   * Event listener for Menu bar download triggers
   * @param {function} callback
   */
  onTriggerFfmpegDownload: (callback) => ipcRenderer.on('trigger-ffmpeg-download', (event) => callback()),

  /**
   * Trigger Piper engine download from backend
   * @returns {Promise<{success: boolean, path?: string, error?: string}>}
   */
  downloadPiper: () => ipcRenderer.invoke('download-piper'),

  /**
   * Event listener for Piper download progress
   * @param {function} callback
   */
  onPiperProgress: (callback) => ipcRenderer.on('piper-download-progress', (event, data) => callback(data)),

  /**
   * Event listener for Menu bar Piper download triggers
   * @param {function} callback
   */
  onTriggerPiperDownload: (callback) => ipcRenderer.on('trigger-piper-download', (event) => callback()),

  /**
   * Trigger Whisper engine download from backend
   * @returns {Promise<{success: boolean, path?: string, error?: string}>}
   */
  downloadWhisperEngine: () => ipcRenderer.invoke('download-whisper-engine'),

  /**
   * Event listener for Whisper download progress
   * @param {function} callback
   */
  onWhisperProgress: (callback) => ipcRenderer.on('whisper-download-progress', (event, data) => callback(data)),

  /**
   * Event listener for Menu bar Whisper download triggers
   * @param {function} callback
   */
  onTriggerWhisperDownload: (callback) => ipcRenderer.on('trigger-whisper-download', (event) => callback()),

  /**
   * Frameless Window Actions
   */
  minimizeWindow: () => ipcRenderer.send('window-minimize'),
  maximizeWindow: () => ipcRenderer.send('window-maximize'),
  closeWindow: () => ipcRenderer.send('window-close'),
  onWindowMaximizedState: (callback) => ipcRenderer.on('window-maximized-state', (event, isMaximized) => callback(isMaximized)),
  checkDependencies: () => ipcRenderer.invoke('check-dependencies'),
  checkForUpdates: () => ipcRenderer.invoke('check-for-updates'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version')
});
