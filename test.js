"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  auditOutput,
  buildFilenameSnapshotIndex,
  buildUrlIndexes,
  classifyAsset,
  classifyResourceFailure,
  createZip,
  cmsAlternativeUrls,
  decodeText,
  detectSiteProfile,
  extractDependencies,
  extractStoredZip,
  failureDiagnostics,
  filenameSnapshotCandidates,
  normalizeTarget,
  isNetworkError,
  isReconstructableCmsResource,
  isReconstructableJoomla,
  outputPathFor,
  portableAssetSignature,
  projectDirectories,
  projectId,
  reportPathFor,
  repairLegacyWidgets,
  repairMissingTextImages,
  relativeLink,
  resourcePriority,
  replayUrlVariants,
  rewriteText,
  trustedVersionedCdn,
  timestampFolder,
  validateLibrarySyncFolder,
  waybackRetryDelay,
} = require("./server");

assert.equal(normalizeTarget("www.Example.com").hostname, "example.com");
const waybackTarget = normalizeTarget("https://web.archive.org/web/20240813162611/https://www.vondergeissheide.de/");
assert.equal(waybackTarget.hostname, "vondergeissheide.de");
assert.equal(waybackTarget.requestedTimestamp, "20240813162611");
assert.equal(outputPathFor("https://example.com/", "text/html", "example.com"), "index.html");
assert.equal(outputPathFor("https://example.com/about", "text/html", "example.com"), "about/index.html");
assert.match(outputPathFor("https://example.com/app.css?v=1", "text/css", "example.com"), /^app-[a-f0-9]{8}\.css$/);
assert.equal(timestampFolder("20240813162611"), "2024-08-13_16-26-11");
assert.equal(relativeLink("pages/about/index.html", "assets/site.css"), "../../assets/site.css");
assert(resourcePriority("text/html", "") < resourcePriority("image/png", ""));
assert(resourcePriority("image/png", "") < resourcePriority("text/css", ""));
assert(resourcePriority("text/css", "") < resourcePriority("application/javascript", ""));
assert(isNetworkError(Object.assign(new Error("fetch failed"), { cause: { code: "UND_ERR_CONNECT_TIMEOUT" } })));
assert.equal(classifyResourceFailure("https://example.com/a.css", [new Error("HTTP 404")]), "not_archived");
const timeoutFailure = Object.assign(new Error("The operation was aborted due to timeout"), { networkRelated: true });
assert.equal(classifyResourceFailure("https://example.com/a.css", [timeoutFailure]), "retry_later");
assert(isReconstructableJoomla("https://example.com/media/system/js/core.js"));
assert.equal(classifyResourceFailure("https://example.com/templates/site/css/main.css", [new Error("HTTP 404")]), "reconstructable");
assert(isReconstructableCmsResource("https://example.com/wp-includes/js/jquery/jquery.min.js"));
assert(isReconstructableCmsResource("https://example.com/build/assets/app.1234abcd.js"));
const xaraRows = [
  ["20200101000000", "https://example.com/index_htm_files/xr_main.css", "text/css", "200", "a", "10"],
  ["20210101000000", "https://example.com/index_htm_files/roe.js", "application/javascript", "200", "b", "10"],
];
assert.equal(detectSiteProfile(xaraRows), "xara");
assert.equal(detectSiteProfile([["20200101000000", "https://example.com/wpscripts/wpstyles.css"]]), "webplus");
assert(cmsAlternativeUrls("https://example.com/xr_main.css?v=1", "xara", "example.com")
  .some((url) => url === "https://example.com/index_htm_files/xr_main.css"));
const filenameIndex = buildFilenameSnapshotIndex(xaraRows);
assert.equal(filenameSnapshotCandidates("https://example.com/missing/xr_main.css", filenameIndex, "20200601000000")[0][1],
  "https://example.com/index_htm_files/xr_main.css");
assert.equal(failureDiagnostics([], ["filename-domain"]).reason, "no CDX snapshot");
assert.deepEqual(
  extractDependencies(
    '<style>.x{background:url(data:image/png;base64,iVBORw0KGgoAAA)}</style><script>x.src=\"+settings.nextButtonSrc+\"</script><a href=\"/menu.html?items=a,b\">x</a>',
    "https://example.com/"
  ),
  ["https://example.com/menu.html?items=a,b"]
);
assert(isReconstructableCmsResource("https://example.com/_next/static/chunks/main.js"));
assert(portableAssetSignature("https://a.example/jquery-3.7.1.min.js"));
assert.equal(
  portableAssetSignature("https://a.example/jquery-3.7.1.min.js"),
  portableAssetSignature("https://b.example/jquery-3.7.1.min.js")
);
assert.equal(portableAssetSignature("https://a.example/css/custom.css"), null);
assert.deepEqual([0, 1, 2, 3, 4].map(waybackRetryDelay), [1000, 2000, 4000, 8000, 16000]);
assert.equal(classifyAsset("https://example.com/wp-content/plugins/woocommerce/assets/js/frontend.js"), "WooCommerce");
assert.equal(classifyAsset("https://cdn.example.com/jquery-3.7.1.min.js"), "jQuery");
assert.equal(trustedVersionedCdn("https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js"), "https://cdn.jsdelivr.net/npm/jquery@3.7.1/dist/jquery.min.js");
assert.equal(trustedVersionedCdn("https://cdn.jsdelivr.net/npm/jquery/dist/jquery.min.js"), null);
assert(replayUrlVariants("https://www.example.com/app.css?v=1").includes("http://www.example.com/app.css"));
assert.deepEqual(
  extractDependencies('<link href="/css/site.css"><script src="https://cdn.example.com/app.js"></script>', "https://example.com/index.html"),
  ["https://example.com/css/site.css", "https://cdn.example.com/app.js"]
);
assert.deepEqual(
  extractDependencies('<img data-lazy-src="/img/lazy.webp" data-srcset="/img/lazy.webp 1x, /img/lazy-2x.webp 2x">', "https://example.com/"),
  ["https://example.com/img/lazy.webp", "https://example.com/img/lazy-2x.webp"]
);
assert.deepEqual(
  extractDependencies('<object data="/media/map.svg"></object><meta property="og:image" content="/img/share.jpg"><svg><use xlink:href="/img/icons.svg#home"></use></svg>', "https://example.com/"),
  ["https://example.com/img/icons.svg#home", "https://example.com/media/map.svg", "https://example.com/img/share.jpg"]
);

const map = new Map([
  ["https://example.com/css/site.css", "css/site.css"],
  ["https://example.com/img/hero.webp", "img/hero.webp"],
  ["https://example.com/js/app.js", "js/app.js"],
]);
const indexes = buildUrlIndexes(map);
const html = '<base href="/"><link href="https://example.com/css/site.css"><img srcset="/img/hero.webp 1x"><script src="//example.com/js/app.js"></script>';
const rewrittenHtml = rewriteText(html, "index.html", "https://example.com/", indexes, "text/html");
assert(!rewrittenHtml.includes("<base"));
assert(rewrittenHtml.includes('href="./css/site.css"'));
assert(rewrittenHtml.includes('srcset="./img/hero.webp 1x"'));
assert(rewrittenHtml.includes('src="./js/app.js"'));
const cleanArchiveHtml = rewriteText(
  '<link rel="stylesheet" href="/_static/css/banner-styles.css"><script>__wm.init("x")</script><div id="wm-ipp-base">toolbar</div><main>Site</main><!-- FILE ARCHIVED ON 12:00 -->',
  "index.html",
  "https://example.com/",
  indexes,
  "text/html"
);
assert(!/wm-ipp|__wm\.init|banner-styles|FILE ARCHIVED ON/i.test(cleanArchiveHtml));
assert(cleanArchiveHtml.includes("<main>Site</main>"));
const lazyHtml = rewriteText(
  '<img src="data:image/gif;base64,AAAA" data-lazy-src="/img/hero.webp" data-lazy-srcset="/img/hero.webp 1x"><div data-bg="/img/hero.webp"></div>',
  "index.html",
  "https://example.com/",
  indexes,
  "text/html"
);
assert(lazyHtml.includes('src="./img/hero.webp"'));
assert(lazyHtml.includes('srcset="./img/hero.webp 1x"'));
assert(lazyHtml.includes("background-image:url('./img/hero.webp')"));

const css = '@import "/css/site.css"; .hero{background:url("../../img/hero.webp")}';
const rewrittenCss = rewriteText(css, "css/theme/main.css", "https://example.com/css/theme/main.css", indexes, "text/css");
assert(rewrittenCss.includes('@import "../site.css"'));
assert(rewrittenCss.includes('url("../../img/hero.webp")'));

const cp1251 = Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xb3, 0xf2]);
assert.equal(decodeText(cp1251, "text/plain; charset=windows-1251"), "Привіт");

const temp = fs.mkdtempSync(path.join(os.tmpdir(), "archivarix-test-"));
try {
  fs.mkdirSync(path.join(temp, "css"));
  fs.mkdirSync(path.join(temp, "js"));
  fs.writeFileSync(path.join(temp, "index.html"), "<h1>OK</h1>");
  fs.writeFileSync(path.join(temp, "css", "site.css"), "body{}");
  fs.writeFileSync(path.join(temp, "js", "jquery.js"), 'var src="/a"; image.src=g.src;');
  const modernProject = path.join(temp, "example.com", "2024-08-13_16-26-11_123456");
  fs.mkdirSync(path.join(modernProject, "site"), { recursive: true });
  fs.mkdirSync(path.join(modernProject, "reports"), { recursive: true });
  fs.writeFileSync(path.join(modernProject, "reports", "restore-manifest.json"), "{}");
  assert.equal(reportPathFor(modernProject), path.join(modernProject, "reports", "restore-manifest.json"));
  assert(projectDirectories(temp).includes(modernProject));
  assert.equal(projectId(temp, modernProject), "example.com/2024-08-13_16-26-11_123456");
  const audit = auditOutput(temp, [
    { status: "ok", mime: "text/html", local: "index.html" },
    { status: "ok", mime: "text/css", local: "css/site.css" },
    { status: "ok", mime: "application/javascript", local: "js/jquery.js" },
  ]);
  assert.equal(audit.brokenCount, 0);
  const legacy = path.join(temp, "legacy");
  fs.mkdirSync(legacy);
  fs.writeFileSync(
    path.join(legacy, "index.html"),
    '<html><head></head><body><div id="tc-tabber"><div class="tc-slides"><div class="tc-slide"><img class="tc-image" title="hero.jpg"></div></div></div></body></html>'
  );
  fs.writeFileSync(path.join(legacy, "hero.jpg"), "image");
  const legacyManifest = [{ status: "ok", mime: "text/html", local: "index.html" }];
  const repair = repairLegacyWidgets(legacy, legacyManifest);
  assert.equal(repair.repairedPages, 1);
  const repairedHtml = fs.readFileSync(path.join(legacy, "index.html"), "utf8");
  assert(repairedHtml.includes('src="hero.jpg"'));
  assert(repairedHtml.includes("_773/legacy-slider.js"));
  assert(fs.existsSync(path.join(legacy, "_773", "legacy-slider.css")));
  const textImageRoot = path.join(temp, "text-images");
  fs.mkdirSync(textImageRoot);
  fs.writeFileSync(path.join(textImageRoot, "index.html"),
    '<html><head></head><body><img alt="Opening hours" src="missing.png" style="width:120px;height:20px"></body></html>');
  const textRepair = repairMissingTextImages(textImageRoot);
  assert.equal(textRepair.repairedImages, 1);
  assert.deepEqual(textRepair.repairedReferences, ["missing.png"]);
  assert.equal(textRepair.fallbackImages, 1);
  assert(fs.readFileSync(path.join(textImageRoot, "index.html"), "utf8").includes("restorer-missing-text-image"));
  const syncFolder = path.join(temp, "shared-drive");
  assert.equal(validateLibrarySyncFolder(syncFolder), path.resolve(syncFolder));
  assert(fs.existsSync(syncFolder));
  const zip = path.join(temp, "site.zip");
  createZip(temp, zip);
  const data = fs.readFileSync(zip);
  assert.equal(data.readUInt32LE(0), 0x04034b50);
  assert(data.includes(Buffer.from("index.html")));
  assert(data.includes(Buffer.from("css/site.css")));
  const extracted = path.join(temp, "extracted");
  extractStoredZip(data, extracted);
  assert.equal(fs.readFileSync(path.join(extracted, "index.html"), "utf8"), "<h1>OK</h1>");
} finally {
  fs.rmSync(temp, { recursive: true, force: true });
}

console.log("Усі автоматичні тести пройдено.");
