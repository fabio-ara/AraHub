/**
 * Synthetic MAT06 PPTX. Usage: node office_prove.mjs --config <private JSON>.
 * MAT06_CONFIG is also accepted. Config: output_dir inside checkout .private,
 * node_modules (absolute directory), tools {artifact_tool, presentation_utils,
 * node, python, integrity_validator, layout_validator}, each {path, sha256}.
 * --check-config validates paths/hashes without importing or executing tools;
 * --figure-only writes the deterministic synthetic PNG without Office/runtime.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    config: { type: "string", default: process.env.MAT06_CONFIG },
    "check-config": { type: "boolean" },
    "figure-only": { type: "boolean" },
  },
});
if (!values.config) throw new Error("--config or MAT06_CONFIG is required");
const config = JSON.parse((await fs.readFile(values.config, "utf8")).replace(/^\uFEFF/, ""));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const privateRoot = await fs.realpath(path.join(root, ".private"));
// Resolve existing ancestors to reject junction/symlink escapes before mkdir.
async function canonical(candidate) {
  try {
    return await fs.realpath(candidate);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return path.join(await canonical(path.dirname(candidate)), path.basename(candidate));
  }
}
if (!path.isAbsolute(config.output_dir)) throw new Error("output_dir must be absolute");
const out = await canonical(config.output_dir);
const relative = path.relative(privateRoot, out);
if (
  !relative || relative === ".." || relative.startsWith(`..${path.sep}`) ||
  path.isAbsolute(relative)
) {
  throw new Error("output_dir must be inside checkout .private");
}
async function pinnedFile(record) {
  if (!record || !path.isAbsolute(record.path) || !(await fs.stat(record.path)).isFile()) {
    throw new Error("Configuration requires an existing absolute file path");
  }
  const actual = createHash("sha256").update(await fs.readFile(record.path)).digest("hex");
  if (actual !== record.sha256) throw new Error("Configured file checksum mismatch");
  return await fs.realpath(record.path);
}
const toolPaths = {};
for (const [name, record] of Object.entries(config.tools ?? {})) {
  toolPaths[name] = await pinnedFile(record);
}
for (const original of config.originals ?? []) await pinnedFile(original);
if (values["check-config"]) {
  console.log("MAT06 configuration: paths and hashes verified");
  process.exit(0);
}
function syntheticFigure() {
  const width = 600, height = 400;
  const raw = Buffer.alloc((width * 3 + 1) * height, 255);
  const colors = [[35, 78, 112], [220, 125, 50], [50, 140, 95]];
  for (let y = 0; y < height; y++) {
    raw[y * (width * 3 + 1)] = 0;
    for (let i = 0; i < 3; i++) {
      if (y < 70 + 90 * i || y >= 130 + 90 * i) continue;
      for (let x = 80; x < 520; x++) {
        raw.set(colors[i], y * (width * 3 + 1) + 1 + x * 3);
      }
    }
  }
  const chunk = (kind, data) => {
    const body = Buffer.concat([Buffer.from(kind), data]);
    let crc = 0xffffffff;
    for (const byte of body) {
      crc ^= byte;
      for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    const head = Buffer.alloc(4), tail = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    tail.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([head, body, tail]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 2;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(raw, { level: 0 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
await fs.mkdir(out, { recursive: true });
const picture = syntheticFigure();
await fs.writeFile(path.join(out, "synthetic-figure.png"), picture);
if (values["figure-only"]) {
  console.log("MAT06 synthetic figure: generated locally");
  process.exit(0);
}
for (
  const key of [
    "artifact_tool",
    "presentation_utils",
    "node",
    "python",
    "integrity_validator",
    "layout_validator",
  ]
) {
  if (!toolPaths[key]) throw new Error(`Missing configured tool: ${key}`);
}
if (!path.isAbsolute(config.node_modules) || !(await fs.stat(config.node_modules)).isDirectory()) {
  throw new Error("node_modules must be an existing absolute directory");
}
process.env.RUNTIME_NODE_MODULES = await fs.realpath(config.node_modules);
process.env.RUNTIME_NODE = toolPaths.node;
process.env.RUNTIME_PYTHON = toolPaths.python;
const { Presentation, PresentationFile, FileBlob } = await import(pathToFileURL(
  toolPaths.artifact_tool,
));
const { finalizePresentation } = await import(
  pathToFileURL(toolPaths.presentation_utils)
);
await fs.mkdir(path.join(out, "output"), { recursive: true });
const presentation = Presentation.create({ slideSize: { width: 1280, height: 720 } });
const slide = presentation.slides.add();
slide.background.fill = "#FFFFFF";
const box = (text, left, top, width, height, size, bold = false) => {
  const shape = slide.shapes.add({
    geometry: "textbox",
    position: { left, top, width, height },
    fill: "none",
    line: { fill: "none", width: 0 },
  });
  shape.text = text;
  shape.text.style = { typeface: "Arial", fontSize: size, bold, color: "#000000", autoFit: "none" };
  return shape;
};
box("Prova de exportação de materiais", 60, 44, 1160, 70, 40, true);
box(
  "Conteúdo sintético para conferir tabela, hiperlink e figura incorporada.",
  60,
  124,
  1150,
  60,
  24,
);
const tableValues = [["Item", "Quantidade", "Estado"], ["Alfa", "2", "Conferido"], [
  "Beta",
  "3",
  "Conferido",
], ["Total", "5", "Conferido"]];
const table = slide.tables.add({
  rows: 4,
  columns: 3,
  left: 60,
  top: 240,
  width: 660,
  height: 230,
  columnWidths: [240, 180, 240],
  values: tableValues,
});
table.borders.assign({ fill: "#D9D9D9", width: 1, style: "solid" });
for (let r = 0; r < 4; r++) {
  for (let c = 0; c < 3; c++) {
    const cell = table.getCell(r, c);
    cell.fill = r === 0 ? "#234E70" : r % 2 === 0 ? "#EEF3F7" : "#FFFFFF";
    cell.text.style = {
      typeface: "Arial",
      fontSize: 24,
      bold: r === 0,
      color: r === 0 ? "#FFFFFF" : "#000000",
    };
  }
}
slide.images.add({
  blob: picture,
  contentType: "image/png",
  alt: "Três faixas sintéticas azul, laranja e verde",
  fit: "contain",
  position: { left: 760, top: 205, width: 440, height: 294 },
});
box("Figura 1. Faixas coloridas", 790, 482, 410, 55, 22);
box("Os itens Alfa e Beta somam cinco unidades.", 60, 495, 650, 65, 22);
const link = box("", 60, 585, 620, 50, 24);
link.text.set([[{
  run: "Referência sintética",
  textStyle: { color: "#175899", underline: "sng", typeface: "Arial", fontSize: "24px" },
  link: { uri: "https://example.invalid/mat06#fonte", isExternal: true },
}]]);
slide.speakerNotes.textFrame.setText(
  "MAT06 synthetic fixture. Table and hyperlink are native objects. Embedded figure is deterministic RGB data generated locally. No URL fetched, no personal content.",
);
const draft = path.join(out, "build/candidate.pptx");
await fs.mkdir(path.dirname(draft), { recursive: true });
await (await PresentationFile.exportPptx(presentation)).save(draft);
await finalizePresentation({
  workspaceDir: out,
  candidatePath: draft,
  finalPath: path.join(out, "output/fixture.pptx"),
  explicitTotalSlideCount: 1,
  requiredNativeTableOwnerSlides: [1],
  pythonExecutable: toolPaths.python,
  integrityValidatorPath: toolPaths.integrity_validator,
  layoutValidatorPath: toolPaths.layout_validator,
  layoutArgs: [
    "--expected-slide-size-emu",
    "12192000,6858000",
    "--require-native-table-slide",
    "1",
    "--validate-heading-fit",
  ],
  fontPolicy: { basis: "design", families: ["Arial"] },
  verifyArtifactToolImport: true,
  receiptPath: path.join(out, "build/fixture.validation.json"),
});
// Render the exported file, not the in-memory builder representation.
const final = await PresentationFile.importPptx(
  await FileBlob.load(path.join(out, "output/fixture.pptx")),
);
const rendered = await final.export({ slide: final.slides.items[0], format: "png", scale: 1.25 });
await fs.writeFile(
  path.join(out, "fixture-pptx.png"),
  new Uint8Array(await rendered.arrayBuffer()),
);
console.log("MAT06 PPTX: exported, finalized and rendered locally");
