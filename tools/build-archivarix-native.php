<?php
declare(strict_types=1);

if ($argc < 5) {
    fwrite(STDERR, "Usage: build-archivarix-native.php <site> <manifest> <output> <domain>\n");
    exit(2);
}

[$script, $siteRoot, $manifestFile, $outputFile, $domain] = $argv;
$siteRoot = realpath($siteRoot) ?: '';
$manifest = json_decode((string) @file_get_contents($manifestFile), true);

if (!$siteRoot || !is_dir($siteRoot)) {
    fwrite(STDERR, "Site directory does not exist.\n");
    exit(3);
}
if (!is_array($manifest) || empty($manifest['files'])) {
    fwrite(STDERR, "Restore manifest is missing or empty.\n");
    exit(4);
}
if (!extension_loaded('pdo_sqlite') || !extension_loaded('zip')) {
    fwrite(STDERR, "PHP extensions pdo_sqlite and zip are required.\n");
    exit(5);
}

$secret = strtolower(substr(bin2hex(random_bytes(8)), 0, 8));
$contentDirectory = ".content.$secret";
$temporaryDb = tempnam(sys_get_temp_dir(), 'archivarix-native-');
$pdo = new PDO("sqlite:$temporaryDb");
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->exec("CREATE TABLE structure (url TEXT, protocol TEXT, hostname TEXT, request_uri TEXT, folder TEXT, filename TEXT, mimetype TEXT, charset TEXT, filesize INTEGER, filetime INTEGER, url_original TEXT, enabled INTEGER DEFAULT 1, redirect TEXT, depth INTEGER DEFAULT 0, metrics TEXT DEFAULT '')");
$pdo->exec("CREATE UNIQUE INDEX url_index ON structure (url)");
$pdo->exec("CREATE INDEX hostname_index ON structure (hostname)");
$pdo->exec("CREATE INDEX mimetype_index ON structure (mimetype)");
$pdo->exec("CREATE INDEX request_uri_index ON structure (request_uri)");
$pdo->exec("CREATE TABLE settings (param TEXT PRIMARY KEY, value TEXT)");

$primaryDomain = strtolower(preg_replace('~^www[.]~i', '', $domain));
$settings = [
    'domain' => $primaryDomain,
    'schema' => '1.0.2',
    'uuid' => 'LOCAL-' . strtoupper(substr(hash('sha256', $domain . microtime(true)), 0, 32)),
    'https' => '1',
    'www' => '0',
];
$settingStatement = $pdo->prepare("INSERT INTO settings (param, value) VALUES (:param, :value)");
foreach ($settings as $param => $value) {
    $settingStatement->execute(['param' => $param, 'value' => $value]);
}

$insert = $pdo->prepare(
    "INSERT OR IGNORE INTO structure
    (url, protocol, hostname, request_uri, folder, filename, mimetype, charset, filesize, filetime, url_original, enabled, redirect, depth, metrics)
    VALUES
    (:url, :protocol, :hostname, :request_uri, :folder, :filename, :mimetype, :charset, :filesize, :filetime, :url_original, 1, '', 0, '')"
);

$files = [];
$latestManifestTime = 0;
foreach ($manifest['files'] as $manifestItem) {
    $candidateTime = (int) substr(preg_replace('/\D/', '', (string) ($manifestItem['timestamp'] ?? '')), 0, 14);
    if ($candidateTime > $latestManifestTime) $latestManifestTime = $candidateTime;
}
$baseTime = max((int) date('YmdHis'), $latestManifestTime);
$baseDate = DateTimeImmutable::createFromFormat('!YmdHis', (string) $baseTime, new DateTimeZone('UTC'));
$packageFiletime = (int) ($baseDate ?: new DateTimeImmutable('now', new DateTimeZone('UTC')))
    ->modify('+1 day')
    ->format('YmdHis');
$assetPrefix = '/_asr_' . $packageFiletime;
$normalizePath = static function (string $path): string {
    $parts = [];
    foreach (explode('/', str_replace('\\', '/', $path)) as $part) {
        if ($part === '' || $part === '.') continue;
        if ($part === '..') {
            array_pop($parts);
            continue;
        }
        $parts[] = $part;
    }
    return '/' . implode('/', $parts);
};
foreach ($manifest['files'] as $item) {
    if (!in_array(($item['status'] ?? ''), ['ok', 'downloaded', 'archived'], true) || empty($item['local']) || empty($item['original'])) {
        continue;
    }
    $local = str_replace('\\', '/', ltrim((string) $item['local'], '/'));
    if ($local === '' || str_contains($local, '../')) {
        continue;
    }
    $absolute = realpath($siteRoot . DIRECTORY_SEPARATOR . str_replace('/', DIRECTORY_SEPARATOR, $local));
    if (!$absolute || !is_file($absolute) || !str_starts_with($absolute, $siteRoot . DIRECTORY_SEPARATOR)) {
        continue;
    }
    $url = parse_url((string) $item['original']);
    if (empty($url['host'])) {
        continue;
    }
    $protocol = strtolower((string) ($url['scheme'] ?? 'https'));
    $hostname = strtolower((string) $url['host']);
    if (preg_replace('~^www[.]~i', '', $hostname) === $primaryDomain) {
        $hostname = $primaryDomain;
    }
    $requestUri = (string) ($url['path'] ?? '/');
    if ($requestUri === '') {
        $requestUri = '/';
    }
    if (!empty($url['query'])) {
        $requestUri .= '?' . $url['query'];
    }
    $isHtml = preg_match('~(?:text/html|xhtml)~i', (string) ($item['mime'] ?? '')) === 1;
    if (!$isHtml) {
        $requestUri = $assetPrefix . ($requestUri[0] === '/' ? $requestUri : '/' . $requestUri);
    }
    $canonicalUrl = $protocol . '://' . $hostname . $requestUri;
    $storageHash = hash('sha256', $canonicalUrl);
    $folder = 'files/' . substr($storageHash, 0, 2);
    $extension = pathinfo($local, PATHINFO_EXTENSION);
    $filename = substr($storageHash, 2, 30) . ($extension !== '' ? '.' . strtolower($extension) : '');
    $insert->execute([
        'url' => $canonicalUrl,
        'protocol' => $protocol,
        'hostname' => $hostname,
        'request_uri' => $requestUri,
        'folder' => $folder,
        'filename' => $filename,
        'mimetype' => (string) ($item['mime'] ?? 'application/octet-stream'),
        'charset' => preg_match('~(?:html|css|javascript|json|xml|svg|text)~i', (string) ($item['mime'] ?? '')) ? 'utf-8' : '',
        'filesize' => filesize($absolute),
        'filetime' => $packageFiletime,
        'url_original' => (string) $item['original'],
    ]);
    $payload = null;
    if ($isHtml) {
        $html = file_get_contents($absolute);
        $pagePath = (string) ($url['path'] ?? '/');
        $pageDirectory = rtrim(str_replace('\\', '/', dirname($pagePath)), '/');
        $payload = preg_replace_callback(
            '~\b(src|href|poster|data-src|data-lazy-src|data-original)\s*=\s*(["\'])([^"\']+)\2~i',
            static function (array $match) use ($assetPrefix, $pageDirectory, $normalizePath): string {
                $value = html_entity_decode($match[3], ENT_QUOTES | ENT_HTML5);
                if (preg_match('~^(?:[a-z]+:|//|#|data:|blob:|mailto:|tel:)~i', $value)) return $match[0];
                $fragment = '';
                if (($position = strpos($value, '#')) !== false) {
                    $fragment = substr($value, $position);
                    $value = substr($value, 0, $position);
                }
                $query = '';
                if (($position = strpos($value, '?')) !== false) {
                    $query = substr($value, $position);
                    $value = substr($value, 0, $position);
                }
                if (!preg_match('~[.](?:css|m?js|json|xml|svg|png|jpe?g|gif|webp|avif|ico|woff2?|ttf|otf|eot|mp4|webm|mp3|ogg|pdf)$~i', $value)) {
                    return $match[0];
                }
                $resolved = str_starts_with($value, '/')
                    ? $normalizePath($value)
                    : $normalizePath($pageDirectory . '/' . $value);
                $updated = $assetPrefix . $resolved . $query . $fragment;
                return $match[1] . '=' . $match[2] . htmlspecialchars($updated, ENT_QUOTES | ENT_HTML5) . $match[2];
            },
            $html
        );
    } elseif (preg_match('~text/css~i', (string) ($item['mime'] ?? ''))) {
        $css = file_get_contents($absolute);
        $payload = preg_replace(
            '~(url\(\s*["\']?|@import\s+(?:url\(\s*)?["\'])/(?!/)~i',
            '$1' . $assetPrefix . '/',
            $css
        );
    }
    if ($payload !== null) {
        $updateSize = $pdo->prepare("UPDATE structure SET filesize = :filesize WHERE url = :url");
        $updateSize->execute(['filesize' => strlen($payload), 'url' => $canonicalUrl]);
    }
    $files["$folder/$filename"] = ['path' => $absolute, 'content' => $payload];
}

if (!$files) {
    @unlink($temporaryDb);
    fwrite(STDERR, "No restored files are available for packaging.\n");
    exit(6);
}

$pdo->exec("VACUUM");
$pdo = null;
@unlink($outputFile);
$zip = new ZipArchive();
if ($zip->open($outputFile, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
    @unlink($temporaryDb);
    fwrite(STDERR, "Cannot create ZIP file.\n");
    exit(7);
}
$zip->addEmptyDir($contentDirectory);
$zip->addFile($temporaryDb, "$contentDirectory/structure.db");
foreach ($files as $local => $file) {
    if ($file['content'] !== null) {
        $zip->addFromString("$contentDirectory/$local", $file['content']);
    } else {
        $zip->addFile($file['path'], "$contentDirectory/$local");
    }
}
$zip->close();
@unlink($temporaryDb);

echo json_encode([
    'ok' => true,
    'files' => count($files),
    'output' => $outputFile,
    'contentDirectory' => $contentDirectory,
], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
