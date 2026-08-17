#!/usr/bin/env node
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const outputPath = resolve(process.argv[2] || 'data/players/main/Sol5.sav');
const force = process.argv.includes('--force');
if (existsSync(outputPath) && !force) {
  console.log(JSON.stringify({ ok: true, action: 'preserved-existing-save', outputPath }));
  process.exit(0);
}

const levels = [99, 95, 93, 99, 1, 57, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
const names = ['Attack', 'Defence', 'Strength', 'Hitpoints', 'Ranged', 'Prayer', 'Magic', 'Cooking', 'Woodcutting', 'Fletching', 'Fishing', 'Firemaking', 'Crafting', 'Smithing', 'Mining', 'Herblore', 'Agility', 'Thieving', 'Stat18', 'Stat19', 'Runecraft'];

function experienceForLevel(level) {
  if (level <= 1) return 0;
  let acc = 0;
  for (let i = 0; i < level - 1; i++) {
    const currentLevel = i + 1;
    acc += Math.floor(currentLevel + Math.pow(2, currentLevel / 10) * 300);
  }
  return Math.floor(acc / 4) * 10;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
  }
  return (~crc) >>> 0;
}

const out = [];
const p1 = (value) => out.push(Number(value) & 0xff);
const p2 = (value) => { const n = Number(value) & 0xffff; out.push((n >>> 8) & 0xff, n & 0xff); };
const p4 = (value) => { const n = Number(value) >>> 0; out.push((n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff); };
const p8 = (value) => { const n = BigInt(value); for (let shift = 56n; shift >= 0n; shift -= 8n) out.push(Number((n >> shift) & 0xffn)); };

// rs-sdk PlayerLoading.SAV_MAGIC and SAV_VERSION.
p2(0x2004);
p2(7);
// Verified open Lumbridge spawn from the rs-sdk world atlas; avoids the door-blocked recovery location.
p2(3222);
p2(3218);
p1(0);
// Default Player appearance/body values from Player.ts.
for (const value of [0, 10, 18, 26, 33, 36, 42]) p1(value);
for (const value of [0, 0, 0, 0, 0]) p1(value);
p1(0);
p2(10_000);
p4(72 * 60 * 60 * 1000 + 13 * 60 * 1000);
for (const level of levels) {
  p4(experienceForLevel(level));
  p1(level);
}
// No unverifiable quest flags, bank contents, inventory, or equipment are fabricated.
p2(0); // permanent varps
p1(0); // permanent inventories
p1(2); // afk zone count
p4(0);
p4(0);
p2(0); // last AFK zone
p1(0b101010); // public/private/trade chat on
p8(BigInt(Date.now()));
const crc = crc32(Uint8Array.from(out));
p4(crc);

mkdirSync(dirname(outputPath), { recursive: true });
writeFileSync(outputPath, Uint8Array.from(out));
console.log(JSON.stringify({
  ok: true,
  action: 'created-verified-skill-recovery-save',
  outputPath,
  bytes: out.length,
  skills: Object.fromEntries(names.map((name, index) => [name, levels[index]])),
}));
