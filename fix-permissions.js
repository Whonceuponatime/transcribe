#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

console.log('🔧 Fixing permissions for node_modules executables...');

function fixPermissions(dir) {
  if (!fs.existsSync(dir)) {
    console.log(`⚠️  Directory not found: ${dir}`);
    return;
  }

  try {
    // Try chmod (Linux/Mac)
    execSync(`chmod +x ${path.join(dir, '*')}`, { stdio: 'ignore' });
    console.log(`✅ Fixed permissions for ${dir}`);
  } catch (error) {
    // On Windows, chmod doesn't exist, so we just continue
    console.log(`ℹ️  Skipped ${dir} (Windows or no chmod available)`);
  }
}

// Fix main project node_modules
fixPermissions(path.join(__dirname, 'node_modules', '.bin'));

// Fix client node_modules
fixPermissions(path.join(__dirname, 'client', 'node_modules', '.bin'));

console.log('🎉 Permission fix complete!');
console.log('You can now run: npm run dev');
