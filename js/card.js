// Character card import/export: SillyTavern / TavernAI PNG cards (V1, V2, V3) and JSON.

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
}

function b64ToUtf8(b64) {
  const bin = atob(b64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function utf8ToB64(str) {
  return btoa(latin1(new TextEncoder().encode(str)));
}

export function isPng(buf) {
  const u = new Uint8Array(buf, 0, 8);
  return PNG_SIG.every((b, i) => u[i] === b);
}

/** Returns { keyword: text } for all tEXt / uncompressed iTXt chunks. */
export function readPngText(buf) {
  if (!isPng(buf)) throw new Error('Not a PNG file');
  const u = new Uint8Array(buf);
  const dv = new DataView(buf);
  const out = {};
  let p = 8;
  while (p + 8 <= u.length) {
    const len = dv.getUint32(p);
    const type = latin1(u.subarray(p + 4, p + 8));
    const data = u.subarray(p + 8, p + 8 + len);
    if (type === 'tEXt') {
      const z = data.indexOf(0);
      if (z > 0) out[latin1(data.subarray(0, z))] = latin1(data.subarray(z + 1));
    } else if (type === 'iTXt') {
      const z = data.indexOf(0);
      if (z > 0 && data[z + 1] === 0) {
        let q = z + 3;
        q = data.indexOf(0, q) + 1; // language tag
        q = data.indexOf(0, q) + 1; // translated keyword
        out[latin1(data.subarray(0, z))] = new TextDecoder().decode(data.subarray(q));
      }
    } else if (type === 'IEND') break;
    p += 12 + len;
  }
  return out;
}

let crcTable;
function crc32(bytes) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = crcTable[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function textChunk(keyword, text) {
  const data = new Uint8Array(keyword.length + 1 + text.length);
  for (let i = 0; i < keyword.length; i++) data[i] = keyword.charCodeAt(i);
  for (let i = 0; i < text.length; i++) data[keyword.length + 1 + i] = text.charCodeAt(i);
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length);
  const typeAndData = new Uint8Array(4 + data.length);
  typeAndData.set([116, 69, 88, 116]); // tEXt
  typeAndData.set(data, 4);
  chunk.set(typeAndData, 4);
  dv.setUint32(8 + data.length, crc32(typeAndData));
  return chunk;
}

/** Writes the given text chunks into a PNG (replacing existing ones with the same keyword). */
export function writePngText(buf, entries) {
  const u = new Uint8Array(buf);
  const dv = new DataView(buf);
  const parts = [u.subarray(0, 8)];
  const keys = new Set(Object.keys(entries).map((k) => k.toLowerCase()));
  let p = 8;
  while (p + 8 <= u.length) {
    const len = dv.getUint32(p);
    const type = latin1(u.subarray(p + 4, p + 8));
    const chunk = u.subarray(p, p + 12 + len);
    if (type === 'IEND') {
      for (const [k, v] of Object.entries(entries)) parts.push(textChunk(k, v));
      parts.push(chunk);
      break;
    }
    let skip = false;
    if (type === 'tEXt' || type === 'iTXt') {
      const data = u.subarray(p + 8, p + 8 + len);
      const z = data.indexOf(0);
      if (z > 0 && keys.has(latin1(data.subarray(0, z)).toLowerCase())) skip = true;
    }
    if (!skip) parts.push(chunk);
    p += 12 + len;
  }
  return new Blob(parts, { type: 'image/png' });
}

/** Normalises any V1/V2/V3 card JSON into our internal character shape (without id/avatar). */
export function normalizeCard(json) {
  if (!json || typeof json !== 'object') throw new Error('Invalid character data');
  const d = json.data && typeof json.data === 'object' ? json.data : json;
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));
  const name = str(d.name || d.char_name).trim();
  if (!name) throw new Error('Card has no character name');
  return {
    name,
    description: str(d.description || d.char_persona),
    personality: str(d.personality),
    scenario: str(d.scenario || d.world_scenario),
    first_mes: str(d.first_mes || d.char_greeting),
    mes_example: str(d.mes_example || d.example_dialogue),
    system_prompt: str(d.system_prompt),
    post_history_instructions: str(d.post_history_instructions),
    alternate_greetings: Array.isArray(d.alternate_greetings) ? d.alternate_greetings.map(str).filter((s) => s.trim()) : [],
    creator_notes: str(d.creator_notes),
    tags: Array.isArray(d.tags) ? d.tags.map(str) : [],
    creator: str(d.creator),
    character_version: str(d.character_version),
    character_book: d.character_book && typeof d.character_book === 'object' ? d.character_book : null,
    extensions: d.extensions && typeof d.extensions === 'object' ? d.extensions : {},
  };
}

function cardData(c) {
  return {
    name: c.name,
    description: c.description,
    personality: c.personality,
    scenario: c.scenario,
    first_mes: c.first_mes,
    mes_example: c.mes_example,
    creator_notes: c.creator_notes,
    system_prompt: c.system_prompt,
    post_history_instructions: c.post_history_instructions,
    alternate_greetings: c.alternate_greetings || [],
    character_book: c.character_book || undefined,
    tags: c.tags || [],
    creator: c.creator || '',
    character_version: c.character_version || '',
    extensions: c.extensions || {},
  };
}

export const toV2 = (c) => ({ spec: 'chara_card_v2', spec_version: '2.0', data: cardData(c) });
export const toV3 = (c) => ({
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: { ...cardData(c), group_only_greetings: [] },
});

/** Parse an imported File into { card, avatarBlob|null }. */
export async function parseCardFile(file) {
  const buf = await file.arrayBuffer();
  if (isPng(buf)) {
    const text = readPngText(buf);
    const raw = text.ccv3 || text.chara;
    if (!raw) throw new Error(`${file.name}: PNG has no character data`);
    let json;
    try { json = JSON.parse(b64ToUtf8(raw)); } catch { throw new Error(`${file.name}: corrupt character data`); }
    return { card: normalizeCard(json), avatarBlob: new Blob([buf], { type: 'image/png' }) };
  }
  let json;
  try { json = JSON.parse(new TextDecoder().decode(buf)); } catch { throw new Error(`${file.name}: not a PNG or JSON card`); }
  return { card: normalizeCard(json), avatarBlob: null };
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('Could not load image'));
    img.src = src;
  });
}

/** Resize an image Blob to a compact JPEG data URL for storage/display. */
/**
 * A picture as a data: URL for storage. Small enough pictures are kept exactly as they
 * are; bigger ones are shrunk in halves with high-quality smoothing (one big jump makes
 * detailed art soft) and saved as a high-quality JPEG.
 */
export async function blobToAvatar(blob, max = 1280) {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const longest = Math.max(img.naturalWidth, img.naturalHeight);
    if (longest <= max && blob.size <= 1.5e6 && /^image\/(jpeg|png|webp)$/i.test(blob.type || '')) {
      return await blobToDataUrlLocal(blob);
    }
    const scale = Math.min(1, max / longest);
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(img.naturalHeight * scale));
    // Halve until within 2× of the target, then one last high-quality step.
    let src = img;
    let sw = img.naturalWidth;
    let sh = img.naturalHeight;
    while (sw / 2 >= w * 1.0001 && sh / 2 >= h * 1.0001) {
      const c = document.createElement('canvas');
      c.width = Math.round(sw / 2); c.height = Math.round(sh / 2);
      const cx = c.getContext('2d');
      cx.imageSmoothingEnabled = true; cx.imageSmoothingQuality = 'high';
      cx.drawImage(src, 0, 0, c.width, c.height);
      src = c; sw = c.width; sh = c.height;
    }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#222';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(src, 0, 0, w, h);
    return canvas.toDataURL('image/jpeg', 0.92);
  } finally {
    URL.revokeObjectURL(url);
  }
}

function blobToDataUrlLocal(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}

async function avatarPng(char) {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (char.avatar) {
    const img = await loadImage(char.avatar);
    canvas.width = img.naturalWidth; canvas.height = img.naturalHeight;
    ctx.drawImage(img, 0, 0);
  } else {
    canvas.width = 400; canvas.height = 600;
    ctx.fillStyle = '#3b2f5c'; ctx.fillRect(0, 0, 400, 600);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 200px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText((char.name || '?')[0].toUpperCase(), 200, 300);
  }
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return blob.arrayBuffer();
}

/** Build a SillyTavern-compatible PNG card (V2 'chara' + V3 'ccv3' chunks). */
export async function exportCardPng(char) {
  const buf = await avatarPng(char);
  return writePngText(buf, {
    chara: utf8ToB64(JSON.stringify(toV2(char))),
    ccv3: utf8ToB64(JSON.stringify(toV3(char))),
  });
}

export { utf8ToB64, b64ToUtf8 };
