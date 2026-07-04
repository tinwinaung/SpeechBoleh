const fs = require('fs');
const path = require('path');
const { execFile, execSync } = require('child_process');
const ffmpeg = require('fluent-ffmpeg');
const say = require('say');

const scratchDir = __dirname;
const testRawPath = path.join(scratchDir, 'test_raw.wav');
const testTranscodedPath = path.join(scratchDir, 'test_transcoded.wav');
const whisperCli = path.resolve(__dirname, '../bin/whisper/Release/whisper-cli.exe');
const modelPath = path.resolve(__dirname, '../bin/whisper/Release/ggml-tiny.bin');

// Configure ffmpeg path
const GyanFfmpegPath = path.join(process.env.USERPROFILE || 'C:\\Users\\TINWINAUNG', 'AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.2-full_build\\bin\\ffmpeg.exe');
if (fs.existsSync(GyanFfmpegPath)) {
  ffmpeg.setFfmpegPath(GyanFfmpegPath);
} else {
  try {
    const whereFfmpeg = execSync('where ffmpeg', { encoding: 'utf8' }).trim().split('\r\n')[0];
    if (whereFfmpeg) ffmpeg.setFfmpegPath(whereFfmpeg);
  } catch (e) {}
}

console.log('[Test] Step 1: Synthesizing speech...');
say.export('Hello world, testing offline speech transcription.', null, 1.0, testRawPath, (err) => {
  if (err) {
    console.error('[Test] SAPI Synthesis failed:', err);
    process.exit(1);
  }
  console.log('[Test] SAPI Speech synthesized successfully to:', testRawPath);

  console.log('[Test] Step 2: Transcoding audio with FFmpeg...');
  ffmpeg(testRawPath)
    .outputOptions([
      '-acodec pcm_s16le',
      '-ac 1',
      '-ar 16000'
    ])
    .save(testTranscodedPath)
    .on('end', () => {
      console.log('[Test] FFmpeg Transcoding complete:', testTranscodedPath);

      console.log('[Test] Step 3: Running whisper-cli.exe...');
      const args = ['-m', modelPath, '-f', testTranscodedPath, '-nt', '-np'];
      console.log('[Test] Spawning:', whisperCli, args.join(' '));

      execFile(whisperCli, args, (wErr, stdout, stderr) => {
        if (wErr) {
          console.error('[Test] Whisper execution failed:', wErr);
          console.error('[Test] Stderr:', stderr);
        } else {
          console.log('[Test] Transcription Result:');
          console.log('--------------------------------------------------');
          console.log(stdout.trim());
          console.log('--------------------------------------------------');
        }

        // Cleanup
        console.log('[Test] Cleaning up files...');
        try {
          if (fs.existsSync(testRawPath)) fs.unlinkSync(testRawPath);
          if (fs.existsSync(testTranscodedPath)) fs.unlinkSync(testTranscodedPath);
          console.log('[Test] Cleanup complete.');
        } catch (cErr) {
          console.warn('[Test] Cleanup failed:', cErr);
        }
      });
    })
    .on('error', (fErr) => {
      console.error('[Test] FFmpeg Transcoding failed:', fErr);
      if (fs.existsSync(testRawPath)) fs.unlinkSync(testRawPath);
    });
});
