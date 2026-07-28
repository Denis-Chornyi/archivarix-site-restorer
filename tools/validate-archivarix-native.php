<?php
declare(strict_types=1);

$file = $argv[1] ?? '';
$zip = new ZipArchive();
if (!$file || $zip->open($file) !== true) {
    fwrite(STDERR, "Cannot open ZIP.\n");
    exit(2);
}
$first = $zip->statIndex(0);
$directory = (string) ($first['name'] ?? '');
if (!preg_match('~^[.]content[.][0-9a-z]+/$~i', $directory) || (int) ($first['size'] ?? -1) !== 0) {
    fwrite(STDERR, "The first ZIP entry is not an Archivarix content directory.\n");
    exit(3);
}
$database = $zip->getFromName($directory . 'structure.db');
if ($database === false) {
    fwrite(STDERR, "structure.db is missing.\n");
    exit(4);
}
$temporary = tempnam(dirname(realpath($file) ?: $file), 'archivarix-check-');
if ($temporary === false) {
    fwrite(STDERR, "Cannot create a temporary validation database.\n");
    exit(5);
}
file_put_contents($temporary, $database);
$pdo = new PDO("sqlite:$temporary");
$missingPayloads = 0;
$mismatchedPayloads = 0;
$rows = $pdo->query("SELECT folder, filename FROM structure")->fetchAll(PDO::FETCH_ASSOC);
foreach ($rows as $row) {
    $index = $zip->locateName($directory . $row['folder'] . '/' . $row['filename']);
    if ($index === false) {
        $missingPayloads++;
    } else {
        $stat = $zip->statIndex($index);
        $expected = (int) $pdo->query("SELECT filesize FROM structure WHERE folder = " . $pdo->quote($row['folder']) . " AND filename = " . $pdo->quote($row['filename']) . " LIMIT 1")->fetchColumn();
        if ((int) $stat['size'] !== $expected) $mismatchedPayloads++;
    }
}
$result = [
    'valid' => true,
    'first' => $directory,
    'domain' => $pdo->query("SELECT value FROM settings WHERE param = 'domain'")->fetchColumn(),
    'schema' => $pdo->query("SELECT value FROM settings WHERE param = 'schema'")->fetchColumn(),
    'files' => (int) $pdo->query("SELECT COUNT(*) FROM structure")->fetchColumn(),
    'filetime' => $pdo->query("SELECT MIN(filetime) FROM structure")->fetchColumn(),
    'hostnames' => $pdo->query("SELECT hostname, COUNT(*) AS files FROM structure GROUP BY hostname ORDER BY hostname")->fetchAll(PDO::FETCH_ASSOC),
    'homepages' => $pdo->query("SELECT url, hostname, request_uri, folder, filename, mimetype, filesize FROM structure WHERE request_uri IN ('', '/') ORDER BY url")->fetchAll(PDO::FETCH_ASSOC),
    'missingPayloads' => $missingPayloads,
    'mismatchedPayloads' => $mismatchedPayloads,
    'css' => $pdo->query("SELECT request_uri, folder, filename, filesize FROM structure WHERE mimetype LIKE '%css%' ORDER BY request_uri")->fetchAll(PDO::FETCH_ASSOC),
    'zipFiles' => $zip->numFiles,
];
$pdo = null;
$zip->close();
@unlink($temporary);
echo json_encode($result, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES), PHP_EOL;
