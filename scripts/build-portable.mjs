import { execFileSync } from "node:child_process";
import {
  readFile,
  writeFile,
  mkdir,
  mkdtemp,
  readdir,
  rename,
  rm,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import JSZip from "jszip";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.resolve(scriptDirectory, "..");
const outputRoot = path.join(projectDirectory, "outputs", "portable");
const folderName = "qPCR_Plate_Layout_Planner_Portable";
const htmlFilename = "Open_qPCR_Plate_Layout_Planner.html";
const legacyFolderNames = ["RT-qPCR_Plate_Planner_Portable"];
const readmeFilename = "README_CN_EN.txt";
const versionFilename = "VERSION.txt";
const licenseFilename = "THIRD_PARTY_LICENSES.txt";
const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "qpcr-portable-"),
);
const javascriptPath = path.join(temporaryDirectory, "portable-app.js");
let pendingZipPath = null;

function dateStamp(date = new Date()) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, "0"),
    String(date.getDate()).padStart(2, "0"),
  ].join("");
}

function escapeInlineScript(source) {
  return source.replaceAll(/<\/script/gi, "<\\/script");
}

function escapeInlineStyle(source) {
  return source.replaceAll(/<\/style/gi, "<\\/style");
}

function currentCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: projectDirectory,
      encoding: "utf8",
    }).trim();
  } catch {
    return "uncommitted";
  }
}

function packageRootFromMetafileInput(inputPath) {
  const parts = inputPath.replaceAll("\\", "/").split("/");
  let nodeModulesIndex = -1;
  for (let index = 0; index < parts.length; index += 1) {
    if (parts[index] === "node_modules") nodeModulesIndex = index;
  }
  if (nodeModulesIndex < 0 || !parts[nodeModulesIndex + 1]) return null;
  const packageEnd =
    parts[nodeModulesIndex + 1].startsWith("@")
      ? nodeModulesIndex + 3
      : nodeModulesIndex + 2;
  return path.resolve(
    projectDirectory,
    parts.slice(0, packageEnd).join("/"),
  );
}

async function thirdPartyLicenseText(metafile) {
  const packageRoots = new Set(
    Object.keys(metafile.inputs)
      .map(packageRootFromMetafileInput)
      .filter(Boolean),
  );
  const packages = [];

  for (const packageRoot of packageRoots) {
    const metadata = JSON.parse(
      await readFile(path.join(packageRoot, "package.json"), "utf8"),
    );
    const licenseFiles = (await readdir(packageRoot))
      .filter((filename) => /^(licen[cs]e|notice)(\..*)?$/iu.test(filename))
      .sort((left, right) => left.localeCompare(right, "en"));
    const notices = await Promise.all(
      licenseFiles.map(async (filename) => ({
        filename,
        text: await readFile(path.join(packageRoot, filename), "utf8"),
      })),
    );
    packages.push({
      name: metadata.name,
      version: metadata.version,
      license: metadata.license ?? "Not specified",
      notices,
    });
  }

  packages.sort((left, right) =>
    `${left.name}@${left.version}`.localeCompare(
      `${right.name}@${right.version}`,
      "en",
    ),
  );

  return [
    "qPCR 板布局规划工具｜第三方软件许可",
    "qPCR Plate Layout Planner | Third-Party Notices",
    "",
    "本文件保留离线 HTML 所内嵌第三方组件的版权与许可声明。",
    "This file preserves copyright and license notices for components bundled into the offline HTML.",
    "",
    ...packages.flatMap((packageInfo) => [
      "=".repeat(78),
      `${packageInfo.name}@${packageInfo.version}`,
      `Declared license: ${packageInfo.license}`,
      "=".repeat(78),
      "",
      ...(packageInfo.notices.length > 0
        ? packageInfo.notices.flatMap((notice) => [
            `--- ${notice.filename} ---`,
            notice.text.trim(),
            "",
          ])
        : [
            "No standalone LICENSE or NOTICE file was found in the installed package.",
            "",
          ]),
    ]),
  ].join("\n");
}

function withUtf8Bom(text) {
  return `\uFEFF${text}`;
}

try {
  const buildResult = await esbuild.build({
    entryPoints: [path.join(projectDirectory, "portable", "entry.tsx")],
    outfile: javascriptPath,
    bundle: true,
    splitting: false,
    format: "iife",
    platform: "browser",
    target: ["chrome100", "edge100", "firefox100", "safari15.4"],
    jsx: "automatic",
    jsxImportSource: "react",
    minify: true,
    sourcemap: false,
    legalComments: "none",
    metafile: true,
    define: {
      "process.env.NODE_ENV": '"production"',
    },
    plugins: [
      {
        name: "project-alias",
        setup(build) {
          build.onResolve({ filter: /^@\// }, (args) =>
            build.resolve(`./${args.path.slice(2)}`, {
              resolveDir: projectDirectory,
              kind: args.kind,
            }),
          );
        },
      },
    ],
  });

  const [javascript, rawCss] = await Promise.all([
    readFile(javascriptPath, "utf8"),
    readFile(path.join(projectDirectory, "app", "globals.css"), "utf8"),
  ]);
  const css = rawCss.replace(/^@import\s+["']tailwindcss["'];\s*/u, "");
  const thirdPartyLicenses = await thirdPartyLicenseText(
    buildResult.metafile,
  );
  const buildDate = dateStamp();
  const commit = currentCommit();
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light" />
    <title>qPCR 板布局规划工具</title>
    <style>${escapeInlineStyle(css)}</style>
  </head>
  <body>
    <noscript>请启用浏览器 JavaScript 后使用本工具。</noscript>
    <div id="qpcr-planner-root"></div>
    <script>${escapeInlineScript(javascript)}</script>
  </body>
</html>
`;
  const readme = `qPCR 板布局规划工具｜离线便携版
qPCR Plate Layout Planner | Offline Portable Edition

使用方法 / How to use
1. 请保留并拷贝解压后的整个文件夹。Keep the entire extracted folder together.
2. 双击“${htmlFilename}”即可打开。
   Double-click "${htmlFilename}" to open the app.
3. 推荐使用最新版 Chrome、Edge 或 Safari。无需安装 Node、Python，也无需启动服务器。
   Use a current Chrome, Edge, or Safari. Node, Python, a server, and an internet connection are not required.
4. 单板 Excel 和批量 ZIP 会保存到浏览器的默认下载目录。
   Excel workbooks and batch ZIP files are saved to the browser's Downloads folder.

重要说明 / Notes
- 核心排板、反应用量计算和 Excel 导出均可离线使用。
  Layout planning, reaction calculations, and Excel export work offline.
- 384 孔板默认使用固定 9 mm 八道排枪隔行路径：先 A/C/E/G/I/K/M/O，再 B/D/F/H/J/L/N/P；使用 4.5 mm、自动化或单道设备时可切换为连续孔位。
  The 384-well default follows a fixed 9 mm 8-channel route: A/C/E/G/I/K/M/O, then B/D/F/H/J/L/N/P. Select sequential loading for 4.5 mm, automated, or single-channel workflows.
- 上样组以八连排为单位，不足八位留空；下一组从新八连排的首位开始。Z/N 切换整组行进顺序，技术复孔仍在同一行从左到右连续。
  Loading groups use eight-position strips, leaving unused positions empty. Each new group starts a new strip. Z/N changes strip traversal, while technical replicates remain contiguous left to right in one row.
- 可使用滚轮或百分比调整板子视图，支持框选、拖动画布、调整视窗高度和全屏。技术复孔设置位于板布局预览旁。
  Zoom the plate with the wheel or percentage input; box-select, pan, resize the viewport, or use fullscreen. Technical replicate settings are beside the layout preview.
- Sample_cDNA 表按当前样本输入列表排序；仅手动添加到孔板、未出现在输入列表中的样本排在末尾。
  Sample_cDNA follows the current sample input order; samples assigned manually only on the plate are appended.
- 反应计算器默认按实际移取的 10 µM 引物液计算终浓度；默认 10 µL 体系、每条引物 0.2 µL 时，终浓度为 200 nM，配液余量为 12%。
  The calculator defaults to 10 µM primer solutions as pipetted. At 0.2 µL per primer in a 10 µL reaction, each primer is 200 nM final, with 12% pipetting overage.
- 384 孔隔行布局可选择 A–H 八连排 gene mix 分装；每管按该通道实际孔数计算，Blank 替代水另行加入。
  For 384-well interleaved layouts, assay mix can be aliquoted across an A–H 8-tube strip using each channel's actual destination-well count; Blank replacement water is added separately.
- Thermo Fisher 与 Bio-Rad 的来源链接需要联网时才能打开，不影响其他功能。
  The Thermo Fisher and Bio-Rad source links require internet access; all other features remain available offline.
- “保存”使用当前电脑、当前浏览器的本地存储。更换浏览器、移动或重命名 HTML 后，原先保存的草稿可能不会自动出现。
  Save uses browser-local storage on the current computer. Drafts may not follow the file if you rename or move it, or switch browsers/computers.
- 只有点击“保存”后方案才会在下次打开时恢复；“重置工具”会清除本机保存记录并恢复初始状态。
  A plan is restored on the next visit only after you click Save. Reset tool clears the browser-saved plan and restores the defaults.
- 请使用脱敏样本名称；本工具不会主动上传样本名称。
  Use de-identified sample names. The tool does not actively upload sample names.
- 仅供科研使用。上机前请按试剂说明书和本地 SOP 人工核对。
  For research use only. Verify the final setup against the reagent instructions and local SOP before running the plate.
`;
  const version = `构建日期：${buildDate}
源码版本：${commit}
格式：单文件离线 HTML（CSS、JavaScript 及 Excel 导出组件均已内嵌）
`;

  const zip = new JSZip();
  const zipFolder = zip.folder(folderName);
  zipFolder.file(htmlFilename, html);
  zipFolder.file(readmeFilename, withUtf8Bom(readme));
  zipFolder.file(versionFilename, withUtf8Bom(version));
  zipFolder.file(
    licenseFilename,
    withUtf8Bom(thirdPartyLicenses),
  );
  const zipBuffer = await zip.generateAsync({
    type: "nodebuffer",
    compression: "DEFLATE",
    compressionOptions: { level: 9 },
  });
  const expectedEntries = [
    `${folderName}/`,
    `${folderName}/${htmlFilename}`,
    `${folderName}/${readmeFilename}`,
    `${folderName}/${versionFilename}`,
    `${folderName}/${licenseFilename}`,
  ];
  const verifiedZip = await JSZip.loadAsync(zipBuffer);
  const archivedEntries = Object.keys(verifiedZip.files);
  if (JSON.stringify(archivedEntries) !== JSON.stringify(expectedEntries)) {
    throw new Error("Portable ZIP validation failed: unexpected file list.");
  }

  await mkdir(outputRoot, { recursive: true });
  const zipFilename = `${folderName}_${buildDate}.zip`;
  const zipPath = path.join(outputRoot, zipFilename);
  pendingZipPath = path.join(
    outputRoot,
    `.${zipFilename}.${process.pid}.tmp`,
  );
  await writeFile(pendingZipPath, zipBuffer);
  await rename(pendingZipPath, zipPath);
  pendingZipPath = null;

  const datedZipPattern = new RegExp(
    `^${folderName}_\\d{8}\\.zip$`,
    "u",
  );
  const staleTemporaryPattern = new RegExp(
    `^\\.${folderName}_\\d{8}\\.zip\\.\\d+\\.tmp$`,
    "u",
  );
  const outputEntries = await readdir(outputRoot, { withFileTypes: true });
  for (const entry of outputEntries) {
    const entryPath = path.join(outputRoot, entry.name);
    const isKnownPortableFolder = [folderName, ...legacyFolderNames].includes(
      entry.name,
    );
    const isLegacyDatedZip = legacyFolderNames.some((legacyFolderName) =>
      new RegExp(`^${legacyFolderName}_\\d{8}\\.zip$`, "u").test(
        entry.name,
      ),
    );
    const isLegacyTemporaryZip = legacyFolderNames.some((legacyFolderName) =>
      new RegExp(
        `^\\.${legacyFolderName}_\\d{8}\\.zip\\.\\d+\\.tmp$`,
        "u",
      ).test(entry.name),
    );
    if (isKnownPortableFolder && entry.isDirectory()) {
      await rm(entryPath, { recursive: true, force: true });
    } else if (entry.name === ".DS_Store" && entry.isFile()) {
      await rm(entryPath, { force: true });
    } else if (
      entry.isFile() &&
      datedZipPattern.test(entry.name) &&
      entry.name !== zipFilename
    ) {
      await rm(entryPath, { force: true });
    } else if (entry.isFile() && isLegacyDatedZip) {
      await rm(entryPath, { force: true });
    } else if (
      entry.isFile() &&
      (staleTemporaryPattern.test(entry.name) || isLegacyTemporaryZip)
    ) {
      await rm(entryPath, { force: true });
    }
  }

  console.log(
    JSON.stringify(
      {
        package: zipPath,
        htmlBytes: Buffer.byteLength(html),
      },
      null,
      2,
    ),
  );
} finally {
  if (pendingZipPath) {
    await rm(pendingZipPath, { force: true });
  }
  await rm(temporaryDirectory, { recursive: true, force: true });
}
