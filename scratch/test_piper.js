const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const piperExe = path.join(__dirname, '..', 'bin', 'piper', 'piper', 'piper.exe');
const modelPath = path.join(__dirname, '..', 'bin', 'piper', 'piper', 'en_US-lessac-medium.onnx');
const outputPath = path.join(__dirname, '..', 'tmp', 'test_piper_out.wav');

console.log('Testing Piper executable...');
console.log('Exe:', piperExe);
console.log('Model:', modelPath);
console.log('Output:', outputPath);

const child = spawn(piperExe, ['-m', modelPath, '-f', outputPath], { cwd: path.dirname(piperExe) });
child.stdin.write("Hello, this is a local test of the Piper speech synthesis engine.");
child.stdin.end();

let stderr = '';
child.stderr.on('data', (data) => {
  stderr += data.toString();
});

child.on('close', (code) => {
  if (code === 0) {
    console.log('SUCCESS! Piper synthesized audio file at:', outputPath);
    console.log('File size:', fs.statSync(outputPath).size, 'bytes');
  } else {
    console.error('FAILED! Piper exited with code:', code);
    console.error(stderr);
  }
});
