// Script to create a release ZIP for Chrome Web Store submission
import { createWriteStream, existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import archiver from 'archiver';

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, 'dist');
const outputDir = __dirname;

// Get version from manifest
const manifestPath = join(distDir, 'manifest.json');
const manifestData = JSON.parse(readFileSync(manifestPath, 'utf8'));
const version = manifestData.version;

const outputPath = join(outputDir, `watch-together-v${version}.zip`);

if (!existsSync(distDir)) {
  console.error('❌ Error: dist/ folder not found. Run "npm run build:prod" first.');
  process.exit(1);
}

console.log('📦 Creating release ZIP for Chrome Web Store...');
console.log(`   Version: ${version}`);
console.log(`   Output: ${outputPath}`);

const output = createWriteStream(outputPath);
const archive = archiver('zip', {
  zlib: { level: 9 } // Maximum compression
});

output.on('close', () => {
  const size = (archive.pointer() / 1024 / 1024).toFixed(2);
  console.log(`✅ Release ZIP created successfully!`);
  console.log(`   Size: ${size} MB`);
  console.log(`   Location: ${outputPath}`);
  console.log('');
  console.log('📤 Next steps:');
  console.log('   1. Go to https://chrome.google.com/webstore/devconsole');
  console.log('   2. Click "New Item"');
  console.log(`   3. Upload: ${outputPath}`);
  console.log('   4. Fill in the store listing information (see STORE_SUBMISSION.md)');
});

archive.on('error', (err) => {
  console.error('❌ Error creating ZIP:', err);
  process.exit(1);
});

archive.pipe(output);

// Add all files from dist folder
archive.directory(distDir, false);

archive.finalize();
