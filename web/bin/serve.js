#!/usr/bin/env node
const { execSync, spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const command = args[0] || 'serve';

if (command === 'serve') {
  const port = args[1] || process.env.PORT || '3000';

  // The standalone server lives at .next/standalone/server.js relative to the
  // package root. When installed via npx, __dirname is inside bin/.
  const pkgRoot = path.join(__dirname, '..');
  const standaloneServer = path.join(pkgRoot, '.next', 'standalone', 'server.js');

  if (!fs.existsSync(standaloneServer)) {
    console.error('Error: standalone server not found. The package may not have been built correctly.');
    console.error('Expected:', standaloneServer);
    process.exit(1);
  }

  // Copy static files to standalone if not already there
  const staticSrc = path.join(pkgRoot, '.next', 'static');
  const staticDst = path.join(pkgRoot, '.next', 'standalone', '.next', 'static');
  if (fs.existsSync(staticSrc) && !fs.existsSync(staticDst)) {
    fs.mkdirSync(path.dirname(staticDst), { recursive: true });
    copyDir(staticSrc, staticDst);
  }

  // Copy public/ to standalone if not already there
  const publicSrc = path.join(pkgRoot, 'public');
  const publicDst = path.join(pkgRoot, '.next', 'standalone', 'public');
  if (fs.existsSync(publicSrc) && !fs.existsSync(publicDst)) {
    copyDir(publicSrc, publicDst);
  }

  console.log('');
  console.log('        ,___,');
  console.log('        (o,o)   Costea Web UI');
  console.log('        /)_)');
  console.log('         ""');
  console.log('');
  console.log(`   Starting on http://localhost:${port}`);
  console.log('   Press Ctrl+C to stop');
  console.log('');

  const child = spawn('node', [standaloneServer], {
    cwd: path.join(pkgRoot, '.next', 'standalone'),
    env: { ...process.env, PORT: port, HOSTNAME: '0.0.0.0' },
    stdio: 'inherit',
  });

  child.on('exit', (code) => process.exit(code || 0));
  process.on('SIGINT', () => { child.kill('SIGINT'); });
  process.on('SIGTERM', () => { child.kill('SIGTERM'); });

} else {
  console.log('Usage: costea-web serve [port]');
  console.log('');
  console.log('  serve [port]   Start the Costea Web UI (default port: 3000)');
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const dstPath = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}
