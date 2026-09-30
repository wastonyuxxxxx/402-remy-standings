import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { extname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = fileURLToPath(new URL("../", import.meta.url));
const folder = process.argv[2] === "dist" ? "dist" : "site";
const root = resolve(projectRoot, folder);
const port = Number(process.env.PORT || 4173);
const liveBackend = process.argv.includes("--live-backend");
const indexSource = await readFile(join(root, "index.html"), "utf8");
const publishableKey = indexSource.match(/<meta name="supabase-publishable-key" content="([^"]+)"/)?.[1] ?? "";
const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

createServer(async (request, response) => {
  try {
    const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
    const target = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
    if (target !== root && !target.startsWith(`${root}${sep}`)) {
      response.writeHead(403).end();
      return;
    }
    if (!(await stat(target)).isFile()) throw new Error("not a file");
    let contents = await readFile(target);
    const assetPath = relative(root, target).replaceAll("\\", "/");
    if (!liveBackend && publishableKey && (assetPath === "index.html" || /^assets\/index-[^/]+\.js$/.test(assetPath))) {
      contents = Buffer.from(contents.toString("utf8").replaceAll(publishableKey, ""));
    }
    response.writeHead(200, { "content-type": types[extname(target)] || "application/octet-stream", "cache-control": "no-store" });
    response.end(contents);
  } catch {
    response.writeHead(404).end("Not found");
  }
}).listen(port, "127.0.0.1", () => {
  console.log(`本地预览：http://127.0.0.1:${port}/ （${folder}/，${liveBackend ? "连接线上数据" : "离线模式"}）`);
});
