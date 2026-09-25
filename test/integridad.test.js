"use strict";

// Tests de los arreglos de integridad (problemas conocidos 1-5 del README),
// del informe de escaneo y de la detección de disco/cifrado.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

const {
  DEFAULT_EXCLUDES,
  TMP_SUFFIX,
  FAT32_MAX_FILE_SIZE,
  isInside,
  atomicWriteFileSync,
  readJsonWithFallback,
  compileExcludePatterns,
  createScanReport,
  scanDirectoryRecursive,
  hashFileAsync,
  copyFileVerified,
  ContentIndex,
  copyOneTask,
  fileSystemInfo,
  parseBitLockerProtection,
  isHomeEdition,
} = require("../lib/core.js");

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "kopia-integridad-test-"));
}

function tempDirs(t, count) {
  const dirs = Array.from({ length: count }, makeTempDir);
  t.after(() => dirs.forEach((d) => fs.rmSync(d, { recursive: true, force: true })));
  return dirs;
}

// --- isInside ----------------------------------------------------------------

test("isInside acepta subrutas y la propia carpeta, sin distinguir mayúsculas", () => {
  const root = path.resolve("D:/KopiaDesk_Backup");
  assert.ok(isInside(root, path.join(root, "Fotos", "a.jpg")));
  assert.ok(isInside(root, root));
  assert.ok(isInside(root, root.toUpperCase()));
});

test("isInside rechaza hermanas con el mismo prefijo, traversal y valores inválidos", () => {
  const root = path.resolve("D:/Backup");
  assert.ok(!isInside(root, path.resolve("D:/Backup2/x.txt")));
  assert.ok(!isInside(root, path.join(root, "..", "Windows")));
  assert.ok(!isInside(root, null));
  assert.ok(!isInside(root, "a\0b"));
});

// --- Escrituras atómicas (problema 4) ------------------------------------------

test("atomicWriteFileSync escribe el contenido y no deja temporales", (t) => {
  const [dir] = tempDirs(t, 1);
  const fp = path.join(dir, "sub", "manifest.json");
  atomicWriteFileSync(fp, JSON.stringify({ a: 1 }));
  atomicWriteFileSync(fp, JSON.stringify({ a: 2 }));
  assert.deepEqual(JSON.parse(fs.readFileSync(fp, "utf-8")), { a: 2 });
  assert.ok(!fs.existsSync(fp + TMP_SUFFIX));
});

test("problema 4: readJsonWithFallback usa el .prev.json si el principal está truncado", (t) => {
  const [dir] = tempDirs(t, 1);
  const fp = path.join(dir, "m.json");
  const prev = path.join(dir, "m.prev.json");
  fs.writeFileSync(fp, JSON.stringify({ "a.txt": { size: 3 } }).slice(0, 12)); // corte a mitad
  fs.writeFileSync(prev, JSON.stringify({ "a.txt": { size: 3 } }));
  const result = readJsonWithFallback(fp, prev);
  assert.equal(result.source, "fallback");
  assert.deepEqual(result.data, { "a.txt": { size: 3 } });
  assert.ok(result.error);
});

test("readJsonWithFallback informa 'corrupt' si ninguno se puede leer y 'none' si no existe", (t) => {
  const [dir] = tempDirs(t, 1);
  const fp = path.join(dir, "m.json");
  assert.equal(readJsonWithFallback(fp, null).source, "none");
  fs.writeFileSync(fp, "[1,2]"); // JSON válido pero no es un objeto
  const result = readJsonWithFallback(fp, path.join(dir, "no-existe.json"));
  assert.equal(result.source, "corrupt");
  assert.deepEqual(result.data, {});
});

// --- Copia verificada ------------------------------------------------------------

test("copyFileVerified copia, devuelve el SHA-256, conserva la fecha y no deja temporales", async (t) => {
  const [dir] = tempDirs(t, 1);
  const src = path.join(dir, "src.bin");
  const dest = path.join(dir, "dest.bin");
  fs.writeFileSync(src, crypto.randomBytes(300 * 1024));
  const past = new Date("2020-05-01T10:00:00Z");
  fs.utimesSync(src, past, past);

  const result = await copyFileVerified(src, dest);
  assert.equal(result.hash, await hashFileAsync(src));
  assert.ok(fs.readFileSync(src).equals(fs.readFileSync(dest)));
  assert.equal(Math.round(fs.statSync(dest).mtimeMs / 1000), Math.round(past.getTime() / 1000));
  assert.ok(!fs.existsSync(dest + TMP_SUFFIX));
});

test("copyFileVerified no toca el destino anterior si la copia falla", async (t) => {
  const [dir] = tempDirs(t, 1);
  const dest = path.join(dir, "dest.txt");
  fs.writeFileSync(dest, "versión buena");
  await assert.rejects(copyFileVerified(path.join(dir, "no-existe.txt"), dest));
  assert.equal(fs.readFileSync(dest, "utf-8"), "versión buena");
  assert.ok(!fs.existsSync(dest + TMP_SUFFIX));
});

test("copyFileVerified: un origen de sólo lectura se puede respaldar dos veces", async (t) => {
  const [dir] = tempDirs(t, 1);
  const src = path.join(dir, "solo-lectura.txt");
  const dest = path.join(dir, "dest.txt");
  fs.writeFileSync(src, "v1");
  fs.chmodSync(src, 0o444);
  await copyFileVerified(src, dest);
  fs.chmodSync(src, 0o666);
  fs.writeFileSync(src, "v2 más largo");
  fs.chmodSync(src, 0o444);
  await copyFileVerified(src, dest); // no debe fallar al reemplazar el destino
  fs.chmodSync(src, 0o666);
  assert.equal(fs.readFileSync(dest, "utf-8"), "v2 más largo");
});

// --- Problema 2: sobrescribir un hardlink no altera sus otros enlaces --------------

test("problema 2: sobrescribir un archivo enlazado no cambia el contenido de sus enlaces", async (t) => {
  const [dir] = tempDirs(t, 1);
  const a = path.join(dir, "A.txt");
  const b = path.join(dir, "B.txt");
  fs.writeFileSync(a, "contenido X");
  fs.linkSync(a, b); // B comparte contenido con A (dedup)

  const src = path.join(dir, "nuevo.txt");
  fs.writeFileSync(src, "contenido Y distinto");
  await copyFileVerified(src, b);

  assert.equal(fs.readFileSync(b, "utf-8"), "contenido Y distinto");
  assert.equal(fs.readFileSync(a, "utf-8"), "contenido X", "A no debe cambiar al sobrescribir B");
});

// --- Problema 1: índice de dedup obsoleto -------------------------------------------

test("ContentIndex.record olvida los hashes viejos de una ruta sobrescrita", () => {
  const rel = path.join("KopiaDesk_Backup", "F", "A.txt");
  const index = new ContentIndex({ hashX: rel }); // formato legado: hash -> "ruta"
  assert.equal(index.get("hashX").path, rel);
  index.record("hashY", { path: rel, size: 1 });
  assert.equal(index.get("hashX"), null);
  assert.equal(index.get("hashY").size, 1);
  assert.deepEqual(Object.keys(index.toJSON()), ["hashY"]);
});

test("problema 1: A con X, A cambia a Y, aparece B con X → B termina con X", async (t) => {
  const [destRoot, srcDir] = tempDirs(t, 2);
  const index = new ContentIndex();
  const run = (srcPath, relativeDest) =>
    copyOneTask({ srcPath, destRoot, relativeDest, dedup: true }, { index, pendingWrites: new Map() });

  const srcA = path.join(srcDir, "A.txt");
  fs.writeFileSync(srcA, "contenido X");
  await run(srcA, "KopiaDesk_Backup/F/A.txt");

  fs.writeFileSync(srcA, "contenido Y"); // mismo tamaño, otro contenido
  await run(srcA, "KopiaDesk_Backup/F/A.txt");

  const srcB = path.join(srcDir, "B.txt");
  fs.writeFileSync(srcB, "contenido X");
  await run(srcB, "KopiaDesk_Backup/F/B.txt");

  assert.equal(fs.readFileSync(path.join(destRoot, "KopiaDesk_Backup/F/B.txt"), "utf-8"), "contenido X");
  assert.equal(fs.readFileSync(path.join(destRoot, "KopiaDesk_Backup/F/A.txt"), "utf-8"), "contenido Y");
});

test("problema 1: un índice legado que apunta a contenido cambiado no se usa para enlazar", async (t) => {
  const [destRoot, srcDir] = tempDirs(t, 2);
  // Índice escrito por la versión anterior: X -> A, pero A ya contiene Y.
  const relA = path.join("KopiaDesk_Backup", "F", "A.txt");
  fs.mkdirSync(path.join(destRoot, "KopiaDesk_Backup", "F"), { recursive: true });
  fs.writeFileSync(path.join(destRoot, relA), "contenido Y");
  const srcB = path.join(srcDir, "B.txt");
  fs.writeFileSync(srcB, "contenido X");
  const hashX = await hashFileAsync(srcB);
  const index = new ContentIndex({ [hashX]: relA });

  const result = await copyOneTask(
    { srcPath: srcB, destRoot, relativeDest: "KopiaDesk_Backup/F/B.txt", dedup: true },
    { index, pendingWrites: new Map() }
  );
  assert.equal(result.dedup, false, "no debe enlazar a un archivo con otro contenido");
  assert.equal(fs.readFileSync(path.join(destRoot, "KopiaDesk_Backup/F/B.txt"), "utf-8"), "contenido X");
  assert.equal(index.get(hashX).path, path.join("KopiaDesk_Backup", "F", "B.txt"));
});

test("dedup: dos archivos iguales en el mismo lote se guardan una sola vez (hardlink)", async (t) => {
  const [destRoot, srcDir] = tempDirs(t, 2);
  const index = new ContentIndex();
  const pendingWrites = new Map();
  const names = ["uno.txt", "dos.txt"];
  for (const name of names) fs.writeFileSync(path.join(srcDir, name), "igual");
  const results = await Promise.all(
    names.map((name) =>
      copyOneTask(
        { srcPath: path.join(srcDir, name), destRoot, relativeDest: "KopiaDesk_Backup/F/" + name, dedup: true },
        { index, pendingWrites }
      )
    )
  );
  assert.equal(results.filter((r) => r.dedup).length, 1);
  assert.equal(fs.statSync(path.join(destRoot, "KopiaDesk_Backup/F/uno.txt")).nlink, 2);
});

test("copyOneTask sin dedup igual mantiene el índice al día", async (t) => {
  const [destRoot, srcDir] = tempDirs(t, 2);
  const rel = path.join("KopiaDesk_Backup", "F", "A.txt");
  const index = new ContentIndex({ hashViejo: rel });
  const src = path.join(srcDir, "A.txt");
  fs.writeFileSync(src, "nuevo");
  const result = await copyOneTask({ srcPath: src, destRoot, relativeDest: rel }, { index });
  assert.equal(index.get("hashViejo"), null);
  assert.equal(index.get(result.hash).path, rel);
});

test("copyOneTask rechaza archivos más grandes que el límite del sistema de archivos", async (t) => {
  const [destRoot] = tempDirs(t, 1);
  const src = path.join(destRoot, "grande.bin");
  fs.writeFileSync(src, "0123456789");
  await assert.rejects(
    copyOneTask({ srcPath: src, destRoot, relativeDest: "KopiaDesk_Backup/g.bin" }, { maxFileSize: 5 }),
    (err) => err.code === "FILE_TOO_LARGE"
  );
  assert.ok(!fs.existsSync(path.join(destRoot, "KopiaDesk_Backup", "g.bin")));
});

// --- Informe de escaneo ---------------------------------------------------------

test("scanDirectoryRecursive informa excluidos y enlaces (junctions) sin seguirlos", async (t) => {
  const [dir, outside] = tempDirs(t, 2);
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  fs.writeFileSync(path.join(dir, "b.tmp"), "b");
  fs.writeFileSync(path.join(outside, "fuera.txt"), "x");
  fs.symlinkSync(outside, path.join(dir, "enlace"), "junction");

  const report = createScanReport();
  const files = await scanDirectoryRecursive(dir, "", compileExcludePatterns(DEFAULT_EXCLUDES), report);
  assert.deepEqual(Object.keys(files), ["a.txt"]);
  assert.equal(report.excluded, 1);
  assert.deepEqual(report.skipped, [{ path: "enlace", reason: "enlace" }]);
});

// --- Sistema de archivos y BitLocker ---------------------------------------------

test("fileSystemInfo: FAT32 limita a 4 GB y no tiene hardlinks; NTFS sin límite", () => {
  assert.equal(fileSystemInfo("FAT32").maxFileSize, FAT32_MAX_FILE_SIZE);
  assert.equal(fileSystemInfo("FAT32").supportsHardlinks, false);
  assert.equal(fileSystemInfo("exFAT").maxFileSize, null);
  assert.equal(fileSystemInfo("exFAT").journaled, false);
  assert.equal(fileSystemInfo("NTFS").supportsHardlinks, true);
  assert.equal(fileSystemInfo("NTFS").maxFileSize, null);
});

test("parseBitLockerProtection traduce los valores de la propiedad de shell", () => {
  assert.equal(parseBitLockerProtection(1), "on");
  assert.equal(parseBitLockerProtection(2), "off");
  assert.equal(parseBitLockerProtection("3"), "encrypting");
  assert.equal(parseBitLockerProtection(6), "locked");
  assert.equal(parseBitLockerProtection(null), "unknown");
  assert.equal(parseBitLockerProtection(99), "unknown");
});

test("isHomeEdition reconoce las variantes de Windows Home", () => {
  assert.ok(isHomeEdition("Core"));
  assert.ok(isHomeEdition("CoreSingleLanguage"));
  assert.ok(!isHomeEdition("Professional"));
  assert.ok(!isHomeEdition(null));
});
