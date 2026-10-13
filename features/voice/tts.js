// Optional spoken responses using the speech engine built into Windows
// (System.Speech / SAPI). No download, no cloud service. The text is passed
// through an environment variable, never interpolated into the command.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const SCRIPT = [
  'Add-Type -AssemblyName System.Speech',
  '$s = New-Object System.Speech.Synthesis.SpeechSynthesizer',
  '$s.Rate = 1',
  '$s.SetOutputToWaveFile($env:SS_TTS_OUT)',
  '$s.Speak($env:SS_TTS_TEXT)',
  '$s.Dispose()',
].join('; ');

export function ttsAvailable() {
  return process.platform === 'win32';
}

export function cleanForSpeech(text) {
  return String(text ?? '')
    .replace(/<[@#][!&]?\d+>/g, '')
    .replace(/<t:\d+(?::\w)?>/g, '')
    .replace(/https?:\/\/\S+/g, 'link')
    .replace(/[*_`~|>#[\]()]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 300);
}

/** @returns {Promise<Buffer>} WAV audio */
export function synthesize(text, { timeoutMs = 15000 } = {}) {
  if (!ttsAvailable()) return Promise.reject(new Error('Windows speech synthesis is only available on Windows.'));
  const out = path.join(os.tmpdir(), `soul-tts-${crypto.randomBytes(6).toString('hex')}.wav`);
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], {
      env: { ...process.env, SS_TTS_TEXT: cleanForSpeech(text), SS_TTS_OUT: out },
      windowsHide: true,
    });
    const timer = setTimeout(() => ps.kill(), timeoutMs);
    let stderr = '';
    ps.stderr.on('data', (d) => (stderr += d));
    ps.on('error', reject);
    ps.on('close', (code) => {
      clearTimeout(timer);
      try {
        if (code !== 0 || !fs.existsSync(out)) return reject(new Error(`speech synthesis failed (${code}): ${stderr.slice(0, 200)}`));
        resolve(fs.readFileSync(out));
      } finally {
        fs.rm(out, { force: true }, () => {});
      }
    });
  });
}
