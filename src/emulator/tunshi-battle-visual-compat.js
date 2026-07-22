const PARTY_SPRITES = Object.freeze([151, 159, 167]);
const ENEMY_SPRITES = Object.freeze([191, 199, 207, 215, 223]);
const ICON_SPRITES = Object.freeze([...PARTY_SPRITES, ...ENEMY_SPRITES]);
const SPRITES_PER_ICON = 4;

function hasExpectedIconOam(spriteMem, spriteIndex, expectedTile) {
  for (let offset = 0; offset < SPRITES_PER_ICON; offset += 1) {
    const base = (spriteIndex + offset) * 4;
    if (spriteMem[base] >= 240 || spriteMem[base + 1] !== expectedTile + offset) return false;
  }
  return true;
}

function paintIcon(nes, frame, spriteIndex) {
  const { ppu } = nes;
  const sprites = Array.from({ length: SPRITES_PER_ICON }, (_, offset) => {
    const base = (spriteIndex + offset) * 4;
    return {
      y: ppu.spriteMem[base] + 1,
      tile: ppu.spriteMem[base + 1] + (ppu.f_spPatternTable ? 256 : 0),
      attributes: ppu.spriteMem[base + 2],
      x: ppu.spriteMem[base + 3],
    };
  });
  const minX = Math.min(...sprites.map(({ x }) => x));
  const minY = Math.min(...sprites.map(({ y }) => y));
  const maxX = Math.max(...sprites.map(({ x }) => x)) + 8;
  const maxY = Math.max(...sprites.map(({ y }) => y)) + 8;
  const backdrop = ppu.imgPalette[0] >>> 0;

  // jsnes can retain pixels from the pre-patch sprite cache after restoring
  // this battle checkpoint. Clear the complete 16x16 icon cell first so the
  // transparent pixels in the corrected miniature do not expose that cache.
  for (let y = minY; y < maxY; y += 1) {
    if (y < 0 || y >= 240) continue;
    for (let x = minX; x < maxX; x += 1) {
      if (x >= 0 && x < 256) frame[y * 256 + x] = backdrop;
    }
  }

  for (const sprite of sprites) {
    const tile = ppu.ptTile[sprite.tile];
    if (!tile) continue;
    const flipX = Boolean(sprite.attributes & 0x40);
    const flipY = Boolean(sprite.attributes & 0x80);
    const paletteOffset = (sprite.attributes & 3) * 4;
    for (let y = 0; y < 8; y += 1) {
      const targetY = sprite.y + y;
      if (targetY < 0 || targetY >= 240) continue;
      for (let x = 0; x < 8; x += 1) {
        const targetX = sprite.x + x;
        if (targetX < 0 || targetX >= 256) continue;
        const sourceX = flipX ? 7 - x : x;
        const sourceY = flipY ? 7 - y : y;
        const pixel = tile.pix[sourceY * 8 + sourceX];
        if (pixel !== 0) {
          frame[targetY * 256 + targetX] = ppu.sprPalette[paletteOffset + pixel] >>> 0;
        }
      }
    }
  }
}

/**
 * Repaints only the verified first-battle 3-vs-5 miniature layout used by the
 * private postgame ROM. Other screens and every unrelated ROM are untouched.
 */
export function applyTunshiBattleVisualCompatibility(nes, frame) {
  if (!nes?.mmap?.__tunshiPostgameBankAlias || !frame || frame.length !== 256 * 240) return false;
  const spriteMem = nes.ppu?.spriteMem;
  if (!spriteMem) return false;

  let spriteIndex = 10;
  for (const expectedTile of ICON_SPRITES) {
    if (!hasExpectedIconOam(spriteMem, spriteIndex, expectedTile)) return false;
    spriteIndex += SPRITES_PER_ICON;
  }

  spriteIndex = 10;
  for (const ignored of ICON_SPRITES) {
    paintIcon(nes, frame, spriteIndex);
    spriteIndex += SPRITES_PER_ICON;
  }
  return true;
}

export const tunshiBattleIconTiles = ICON_SPRITES;
