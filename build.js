import * as esbuild from 'esbuild';
import { cpSync, mkdirSync, readFileSync, writeFileSync, rmSync, readdirSync } from 'fs';
import { join } from 'path';
import { writeReleaseArchive } from './release-archive.js';

const isZip = process.argv.includes('--zip');

rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/platforms', { recursive: true });

await esbuild.build({
  entryPoints: [
    { in: 'src/background.js', out: 'background' },
    { in: 'src/platforms/instagram.js', out: 'platforms/instagram' },
  ],
  outdir: 'dist',
  bundle: true,
  format: 'iife',
  minify: isZip,
  target: ['chrome116'],
});

for (const asset of ['icons', 'src/fonts']) {
  cpSync(asset, asset === 'icons' ? 'dist/icons' : 'dist/fonts', { recursive: true });
}
for (const asset of ['popup.html', 'popup.js', 'popup.css']) {
  cpSync(`src/${asset}`, `dist/${asset}`);
}

function removeDesktopIni(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) removeDesktopIni(full);
    else if (entry.name.toLowerCase() === 'desktop.ini') rmSync(full, { force: true });
  }
}
removeDesktopIni('dist');

const manifest = JSON.parse(readFileSync('manifest.json', 'utf8'));
writeFileSync('dist/manifest.json', JSON.stringify(manifest, null, 2));
console.log('Build complete: dist/');

if (isZip) {
  const zipPath = `igel-${manifest.version}.zip`;
  writeReleaseArchive('dist', zipPath);
  console.log(`Release archive complete: ${zipPath}`);
}
