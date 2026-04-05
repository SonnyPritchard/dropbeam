#!/usr/bin/env node
/**
 * scripts/download-tailscale.js
 *
 * Downloads pre-built Tailscale binaries (tailscale + tailscaled) for the
 * specified platform and arch, placing them in bin/<platform>-<arch>/.
 *
 * Usage (defaults to current platform/arch):
 *   node scripts/download-tailscale.js
 *   node scripts/download-tailscale.js --platform=darwin --arch=arm64
 *   node scripts/download-tailscale.js --platform=windows --arch=x64
 *
 * Environment:
 *   TAILSCALE_VERSION  Override pinned version (e.g. "1.80.3")
 *
 * This script is intended for local development. In CI, the workflow handles
 * downloads directly with curl / PowerShell for maximum reliability.
 */

'use strict';

const https = require('https');
const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const { execSync } = require('child_process');

const PINNED_VERSION = '1.80.3';

// ── Argument parsing ──────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  let platform = process.platform === 'win32' ? 'windows'
               : process.platform === 'darwin' ? 'darwin'
               : 'linux';
  let arch = process.arch === 'arm64' ? 'arm64' : 'amd64';

  for (const arg of args) {
    if (arg.startsWith('--platform=')) platform = arg.split('=')[1];
    if (arg.startsWith('--arch=')) {
      const a = arg.split('=')[1];
      // normalise x64 → amd64
      arch = (a === 'x64') ? 'amd64' : a;
    }
  }
  return { platform, arch };
}

// ── Path helpers ──────────────────────────────────────────────────────────────

function outDir(platform, arch) {
  const platLabel = platform === 'windows' ? 'win'
                  : platform === 'darwin'  ? 'mac'
                  : 'linux';
  const archLabel = arch === 'amd64' ? 'x64' : arch;
  return path.join(__dirname, '..', 'bin', `${platLabel}-${archLabel}`);
}

function downloadUrl(platform, arch, version) {
  if (platform === 'windows') {
    return `https://pkgs.tailscale.com/stable/tailscale_${version}_windows_${arch}.zip`;
  }
  return `https://pkgs.tailscale.com/stable/tailscale_${version}_${platform}_${arch}.tgz`;
}

// ── Fetch helpers ─────────────────────────────────────────────────────────────

function fetchLatestVersion() {
  return new Promise((resolve) => {
    // Try the Tailscale CDN version endpoint
    const url = 'https://pkgs.tailscale.com/stable/?mode=json';
    https.get(url, { timeout: 8000 }, (res) => {
      if (res.statusCode !== 200) { resolve(null); return; }
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const obj = JSON.parse(data);
          // The JSON has a top-level "version" or we parse from a tarball name
          const version = obj.version || obj.Version;
          if (version) { resolve(version); return; }
          // Fallback: parse from a tarball URL string
          const src = JSON.stringify(obj);
          const m = src.match(/tailscale_(\d+\.\d+\.\d+)_/);
          resolve(m ? m[1] : null);
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null));
  });
}

function download(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`  Downloading: ${url}`);
    const file = fs.createWriteStream(dest);

    function doGet(targetUrl) {
      const mod = targetUrl.startsWith('https') ? https : http;
      mod.get(targetUrl, { timeout: 120000 }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          doGet(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) {
          reject(new Error(`HTTP ${res.statusCode} for ${targetUrl}`));
          return;
        }
        let downloaded = 0;
        res.on('data', chunk => {
          downloaded += chunk.length;
          process.stdout.write(`\r  ${(downloaded / 1024 / 1024).toFixed(1)} MB`);
        });
        res.pipe(file);
        file.on('finish', () => { file.close(); process.stdout.write('\n'); resolve(); });
      }).on('error', reject);
    }

    doGet(url);
  });
}

// ── Extraction ────────────────────────────────────────────────────────────────

function extractZip(zipPath, dest) {
  if (process.platform === 'win32') {
    execSync(
      `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${dest}' -Force"`,
      { stdio: 'inherit' }
    );
  } else {
    execSync(`unzip -o "${zipPath}" -d "${dest}"`, { stdio: 'inherit' });
  }
}

function extractTgz(tgzPath, dest) {
  // --strip-components=1 removes the top-level directory from the tarball
  // (e.g. tailscale_1.80.3_darwin_arm64/tailscale → tailscale)
  execSync(`tar -xzf "${tgzPath}" -C "${dest}" --strip-components=1`, { stdio: 'inherit' });
}

function findBinary(dir, name) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      const found = findBinary(full, name);
      if (found) return found;
    } else if (e.name === name) {
      return full;
    }
  }
  return null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  const { platform, arch } = parseArgs();
  const version = process.env.TAILSCALE_VERSION || await fetchLatestVersion() || PINNED_VERSION;

  console.log(`Tailscale ${version} — ${platform}/${arch}`);

  const dir = outDir(platform, arch);
  fs.mkdirSync(dir, { recursive: true });

  const isWin  = platform === 'windows';
  const ext    = isWin ? 'zip' : 'tgz';
  const url    = downloadUrl(platform, arch, version);
  const tmpPkg = path.join(dir, `_download.${ext}`);
  const tmpDir = path.join(dir, '_extract');
  const bins   = isWin ? ['tailscale.exe', 'tailscaled.exe'] : ['tailscale', 'tailscaled'];

  // Download
  await download(url, tmpPkg);

  // Extract into a temp subdirectory then fish out binaries
  fs.mkdirSync(tmpDir, { recursive: true });
  if (isWin) extractZip(tmpPkg, tmpDir);
  else       extractTgz(tmpPkg, tmpDir);

  // Locate and move the two binaries we need
  for (const bin of bins) {
    const found  = findBinary(tmpDir, bin) || path.join(tmpDir, bin);
    const target = path.join(dir, bin);
    if (fs.existsSync(found)) {
      fs.copyFileSync(found, target);
      if (!isWin) fs.chmodSync(target, 0o755);
    } else {
      throw new Error(`Binary not found after extraction: ${bin}`);
    }
  }

  // Clean up
  fs.rmSync(tmpPkg, { force: true });
  fs.rmSync(tmpDir, { recursive: true, force: true });

  // Verify
  console.log('\nInstalled:');
  for (const bin of bins) {
    const p = path.join(dir, bin);
    if (!fs.existsSync(p)) throw new Error(`Missing after install: ${p}`);
    console.log(`  ✓  ${p}`);
  }
  console.log('\nDone.');
}

main().catch(err => {
  console.error('\nError:', err.message);
  process.exit(1);
});
