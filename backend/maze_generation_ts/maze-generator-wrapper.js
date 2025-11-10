#!/usr/bin/env node

// Node.js wrapper to execute the TypeScript maze generator
// This bridges Python subprocess calls to the original TypeScript code

const { spawn } = require('child_process');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
if (args.length < 2) {
  console.error('Usage: node maze-generator-wrapper.js <width> <height> [rows] [cols]');
  process.exit(1);
}

const width = parseInt(args[0]);
const height = parseInt(args[1]);
const rows = args[2] ? parseInt(args[2]) : undefined;
const cols = args[3] ? parseInt(args[3]) : undefined;

// Execute TypeScript using ts-node
const tsFile = path.join(__dirname, 'maze-generator.ts');
const nodeArgs = [
  '-r', 'ts-node/register',
  tsFile,
  width.toString(),
  height.toString()
];

if (rows !== undefined && cols !== undefined) {
  nodeArgs.push(rows.toString(), cols.toString());
}

const child = spawn('node', nodeArgs, {
  stdio: ['pipe', 'pipe', 'pipe']
});

child.stdout.on('data', (data) => {
  process.stdout.write(data);
});

child.stderr.on('data', (data) => {
  process.stderr.write(data);
});

child.on('close', (code) => {
  process.exit(code);
});