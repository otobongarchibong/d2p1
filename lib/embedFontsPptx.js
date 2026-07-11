/* embedFontsPptx.js — D2P1 v4.1 export pipeline post-processor (Node port)
 * ==========================================================================
 * Pure-JS port of the verified embed_fonts_pptx.py (EthosM2 eng, 2026-07-10).
 * Same method, same insertion points, same idempotency guarantee — ported so
 * the server stays Node-only (no Python runtime needed on the droplet).
 *
 * Embeds static TTF instances (never variable fonts) into a generated PPTX
 * so desktop PowerPoint renders true brand typography on machines with no
 * fonts installed. Purely additive: slide/chart/notes parts are untouched.
 *
 * Usage:
 *   const { embedFonts } = require("./lib/embedFontsPptx");
 *   const result = await embedFonts(pptxBuffer, "assets/fonts/static");
 *   // result.buffer is the embedded PPTX as a Node Buffer
 * ========================================================================== */
const fs = require("fs");
const path = require("path");
const JSZip = require("jszip");

const FONT_REL_TYPE = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/font";

const BRAND_FONTS = [
  ["Cormorant Garamond", { regular: "CormorantGaramond-Regular.ttf", bold: "CormorantGaramond-Bold.ttf", italic: "CormorantGaramond-Italic.ttf" }],
  ["DM Sans", { regular: "DMSans-Regular.ttf", bold: "DMSans-Bold.ttf", italic: "DMSans-Italic.ttf" }],
  ["DM Mono", { regular: "DMMono-Regular.ttf", italic: "DMMono-Italic.ttf" }]
];

const SLOT_ORDER = ["regular", "bold", "italic", "boldItalic"];

class EmbedError extends Error {}

/**
 * Embed brand fonts into a PPTX buffer.
 * @param {Buffer} pptxBuffer - source PPTX bytes
 * @param {string} fontsDir - absolute path to the directory holding the static TTFs
 * @param {Array} fonts - font manifest, defaults to BRAND_FONTS
 * @returns {Promise<{buffer: Buffer, status: string, fontsAdded: number}>}
 */
async function embedFonts(pptxBuffer, fontsDir, fonts = BRAND_FONTS) {
  const zip = await JSZip.loadAsync(pptxBuffer);

  for (const required of ["[Content_Types].xml", "ppt/_rels/presentation.xml.rels", "ppt/presentation.xml"]) {
    if (!zip.file(required)) throw new EmbedError(`not a PPTX package (missing ${required})`);
  }

  let pres = await zip.file("ppt/presentation.xml").async("string");
  const hasFontParts = Object.keys(zip.files).some((n) => n.startsWith("ppt/fonts/"));
  if (pres.includes("embeddedFontLst") || hasFontParts) {
    // already embedded — pass through untouched, matches Python idempotency
    return { buffer: pptxBuffer, status: "already_embedded", fontsAdded: 0 };
  }

  let ct = await zip.file("[Content_Types].xml").async("string");
  let rels = await zip.file("ppt/_rels/presentation.xml.rels").async("string");

  // 1) content type default for fntdata
  if (!ct.includes('Extension="fntdata"')) {
    ct = ct.replace("</Types>", '<Default Extension="fntdata" ContentType="application/x-fontdata"/></Types>');
  }

  // 2) relationships — continue after highest existing rId
  const ids = [...rels.matchAll(/Id="rId(\d+)"/g)].map((m) => parseInt(m[1], 10));
  let rid = ids.length ? Math.max(...ids) : 0;

  const relAdd = [];
  const fontEntries = [];
  const fontParts = []; // { part, filePath }
  let fontnum = 0;

  for (const [family, slots] of fonts) {
    let entry = `<p:font typeface="${family}"/>`;
    let used = false;
    for (const slot of SLOT_ORDER) {
      if (!slots[slot]) continue;
      const filePath = path.join(fontsDir, slots[slot]);
      if (!fs.existsSync(filePath)) throw new EmbedError(`font asset missing: ${filePath}`);
      rid += 1;
      fontnum += 1;
      const part = `fonts/font${fontnum}.fntdata`;
      relAdd.push(`<Relationship Id="rId${rid}" Type="${FONT_REL_TYPE}" Target="${part}"/>`);
      entry += `<p:${slot} r:id="rId${rid}"/>`;
      fontParts.push({ part: `ppt/${part}`, filePath });
      used = true;
    }
    if (used) fontEntries.push(`<p:embeddedFont>${entry}</p:embeddedFont>`);
  }

  rels = rels.replace("</Relationships>", relAdd.join("") + "</Relationships>");

  // 3) presentation.xml — attribute + list after self-closing notesSz
  if (!pres.includes("embedTrueTypeFonts")) {
    pres = pres.replace("<p:presentation ", '<p:presentation embedTrueTypeFonts="1" ');
  }
  const m = pres.match(/<p:notesSz[^/>]*\/>/);
  if (!m) throw new EmbedError("<p:notesSz/> not found — generator output changed; re-verify insertion point");
  const insertAt = m.index + m[0].length;
  const efl = `<p:embeddedFontLst>${fontEntries.join("")}</p:embeddedFontLst>`;
  pres = pres.slice(0, insertAt) + efl + pres.slice(insertAt);

  // 4) write back the three edited parts, append font parts
  zip.file("[Content_Types].xml", ct);
  zip.file("ppt/_rels/presentation.xml.rels", rels);
  zip.file("ppt/presentation.xml", pres);
  for (const { part, filePath } of fontParts) {
    zip.file(part, fs.readFileSync(filePath));
  }

  const buffer = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  return { buffer, status: "embedded", fontsAdded: fontnum };
}

module.exports = { embedFonts, EmbedError, BRAND_FONTS };
