// Build script for Watch Together Chrome Extension
// Uses esbuild to bundle TypeScript files

import * as esbuild from 'esbuild';
import sharp from 'sharp';
import { cpSync, mkdirSync, existsSync, rmSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, 'dist');
const srcDir = join(__dirname, 'src');

const watchMode = process.argv.includes('--watch');
const prodMode = process.argv.includes('--prod');

// Clean dist directory
if (existsSync(distDir)) {
  rmSync(distDir, { recursive: true });
}
mkdirSync(distDir);
mkdirSync(join(distDir, 'content'), { recursive: true });
mkdirSync(join(distDir, 'background'), { recursive: true });
mkdirSync(join(distDir, 'popup'), { recursive: true });
mkdirSync(join(distDir, 'icons'), { recursive: true });

console.log(`Building Watch Together Extension... ${prodMode ? '(PRODUCTION MODE)' : '(Development Mode)'}`);

const commonOptions = {
  bundle: true,
  sourcemap: !prodMode,
  target: 'es2020',
  minify: prodMode,
  logLevel: 'info',
  drop: prodMode ? ['console', 'debugger'] : [],
};

const buildConfigs = [
  {
    ...commonOptions,
    entryPoints: [join(srcDir, 'content', 'youtube.ts')],
    outfile: join(distDir, 'content', 'youtube.js'),
    format: 'iife',
  },
  {
    ...commonOptions,
    entryPoints: [join(srcDir, 'content', 'netflix.ts')],
    outfile: join(distDir, 'content', 'netflix.js'),
    format: 'iife',
  },
  {
    ...commonOptions,
    entryPoints: [join(srcDir, 'content', 'crunchyroll.ts')],
    outfile: join(distDir, 'content', 'crunchyroll.js'),
    format: 'iife',
  },
  {
    ...commonOptions,
    entryPoints: [join(srcDir, 'content', 'crunchyroll-player.ts')],
    outfile: join(distDir, 'content', 'crunchyroll-player.js'),
    format: 'iife',
  },
  {
    ...commonOptions,
    entryPoints: [join(srcDir, 'content', 'vimeo.ts')],
    outfile: join(distDir, 'content', 'vimeo.js'),
    format: 'iife',
  },
  {
    ...commonOptions,
    entryPoints: [join(srcDir, 'content', 'dailymotion.ts')],
    outfile: join(distDir, 'content', 'dailymotion.js'),
    format: 'iife',
  },
  {
    ...commonOptions,
    entryPoints: [join(srcDir, 'content', 'adn.ts')],
    outfile: join(distDir, 'content', 'adn.js'),
    format: 'iife',
  },
  {
    ...commonOptions,
    entryPoints: [join(srcDir, 'content', 'animesama.ts')],
    outfile: join(distDir, 'content', 'animesama.js'),
    format: 'iife',
  },
  {
    ...commonOptions,
    entryPoints: [join(srcDir, 'content', 'twitch.ts')],
    outfile: join(distDir, 'content', 'twitch.js'),
    format: 'iife',
  },
  {
    ...commonOptions,
    entryPoints: [join(srcDir, 'content', 'disneyplus.ts')],
    outfile: join(distDir, 'content', 'disneyplus.js'),
    format: 'iife',
  },
  {
    ...commonOptions,
    entryPoints: [join(srcDir, 'content', 'primevideo.ts')],
    outfile: join(distDir, 'content', 'primevideo.js'),
    format: 'iife',
  },
  {
    ...commonOptions,
    entryPoints: [join(srcDir, 'content', 'max.ts')],
    outfile: join(distDir, 'content', 'max.js'),
    format: 'iife',
  },
  {
    ...commonOptions,
    entryPoints: [join(srcDir, 'background', 'websocket.ts')],
    outfile: join(distDir, 'background', 'websocket.js'),
    format: 'esm',
  },
  {
    ...commonOptions,
    entryPoints: [join(srcDir, 'popup', 'popup.ts')],
    outfile: join(distDir, 'popup', 'popup.js'),
    format: 'iife',
  },
];

async function generateIcons() {
  const sourceIcon = join(__dirname, 'icons', 'icon.png');
  const sizes = [16, 32, 48, 128];

  // Trim transparent padding and resize
  const trimmed = await sharp(sourceIcon)
    .trim()  // Remove transparent borders
    .toBuffer();

  for (const size of sizes) {
    await sharp(trimmed)
      .resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
      .toFile(join(distDir, 'icons', `icon${size}.png`));
  }
  console.log('Generated icon sizes: 16, 32, 48, 128 (trimmed)');
}

function copyStaticAssets() {
  cpSync(join(srcDir, 'popup', 'popup.html'), join(distDir, 'popup', 'popup.html'));
  cpSync(join(srcDir, 'popup', 'popup.css'), join(distDir, 'popup', 'popup.css'));
  cpSync(join(__dirname, 'manifest.json'), join(distDir, 'manifest.json'));
}

async function build() {
  try {
    console.log('Bundling TypeScript...');
    for (const config of buildConfigs) {
      await esbuild.build(config);
    }

    console.log('Copying static assets...');
    copyStaticAssets();

    console.log('Generating icons...');
    await generateIcons();

    console.log('Build complete! Extension is in the dist/ folder.');
    console.log('\nTo load the extension in Chrome:');
    console.log('1. Open chrome://extensions/');
    console.log('2. Enable "Developer mode"');
    console.log('3. Click "Load unpacked"');
    console.log('4. Select the dist/ folder');

  } catch (error) {
    console.error('Build failed:', error);
    process.exit(1);
  }
}

async function watch() {
  console.log('Starting watch mode...');

  const contexts = await Promise.all(
    buildConfigs.map(config => esbuild.context(config))
  );

  await Promise.all(contexts.map(ctx => ctx.watch()));

  copyStaticAssets();
  await generateIcons();

  console.log('Watching for changes... Press Ctrl+C to stop.');
}

if (watchMode) {
  watch();
} else {
  build();
}
