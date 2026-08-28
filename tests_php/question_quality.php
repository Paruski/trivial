<?php
declare(strict_types=1);
require __DIR__ . '/../lib/content.php';

function qnorm(string $text): string {
    $text = mb_strtolower($text, 'UTF-8');
    $map = ['á'=>'a','é'=>'e','í'=>'i','ó'=>'o','ú'=>'u','ü'=>'u','ñ'=>'n'];
    $text = strtr($text, $map);
    $text = preg_replace('/[^a-z0-9]+/u', ' ', $text) ?? $text;
    return trim(preg_replace('/\s+/', ' ', $text) ?? $text);
}

function answer_alternatives(string $answer): array {
    $answer = preg_replace('/\([^)]*\)/u', '', $answer) ?? $answer;
    $parts = preg_split('/\s+(?:o|u)\s+|[\/;]|\bor\b/ui', $answer) ?: [$answer];
    $out = [];
    foreach ($parts as $part) {
        $part = trim($part, " \t\n\r\0\x0B.,:;!?¿¡«»\"'");
        $part = preg_replace('/^(?:el|la|los|las|un|una|unos|unas|al|del|en)\s+/ui', '', $part) ?? $part;
        $n = qnorm($part);
        if ($n !== '' && strlen(str_replace(' ', '', $n)) >= 3) $out[] = $n;
    }
    return array_values(array_unique($out));
}

$seed = load_seed();
$failures = [];
foreach ($seed['questions'] as $q) {
    if (($q['status'] ?? '') !== 'active') continue;
    $prompt = ' ' . qnorm((string)$q['prompt']) . ' ';
    foreach (answer_alternatives((string)$q['answer']) as $answer) {
        if (str_contains($prompt, ' ' . $answer . ' ')) {
            $failures[] = $q['questionKey'] . "\t" . $q['categoryId'] . "\tANSWER=" . $q['answer'] . "\tPROMPT=" . $q['prompt'];
            break;
        }
    }
}
if ($failures) {
    fwrite(STDERR, "Active questions whose prompt contains an answer:\n" . implode("\n", $failures) . "\n");
    exit(1);
}
echo "ok - no active question contains its answer literally\n";
