import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const sourceRoot = join(projectRoot, "site");
const outputRoot = join(projectRoot, "dist");
const pageFiles = ["index.html", ".nojekyll"];
const assetRoot = "assets";

async function filesBelow(directory, prefix = "") {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const name = join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(join(directory, entry.name), name));
    else if (entry.isFile()) files.push(name);
  }
  return files.sort();
}

async function sourceFiles() {
  const files = [...pageFiles, ...await filesBelow(join(sourceRoot, assetRoot), assetRoot)];
  for (const file of files) await stat(join(sourceRoot, file));
  return files;
}

async function copyFiles(files, destination) {
  for (const file of files) {
    const target = join(destination, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(join(sourceRoot, file), target);
  }
}

async function checkPages(files) {
  let failed = false;
  for (const file of files) {
    const expected = await readFile(join(sourceRoot, file));
    const actual = await readFile(join(projectRoot, file)).catch(() => null);
    if (!actual?.equals(expected)) {
      console.error(`发布文件与 site/ 不一致：${file}`);
      failed = true;
    }
  }
  const expectedAssets = new Set(files.filter((file) => file.startsWith(`${assetRoot}${sep}`)));
  for (const file of await filesBelow(join(projectRoot, assetRoot), assetRoot)) {
    if (!expectedAssets.has(file)) {
      console.error(`发布目录有多余文件：${file}`);
      failed = true;
    }
  }
  if (failed) process.exitCode = 1;
  else console.log(`发布文件一致：${files.length} 个文件`);
}

const files = await sourceFiles();
if (process.argv.includes("--check")) {
  await checkPages(files);
} else {
  // dist/ is generated output; a clean copy catches stale assets in previews.
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });
  await copyFiles(files, outputRoot);
  if (process.argv.includes("--pages")) await copyFiles(files, projectRoot);
  console.log(`已构建 ${files.length} 个文件到 ${relative(projectRoot, outputRoot)}/`);
  if (process.argv.includes("--pages")) await checkPages(files);
}
