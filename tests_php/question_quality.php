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

function answer_forms(string $answer): array {
    $forms = [$answer];
    $withoutParentheses = preg_replace('/\([^)]*\)/u', '', $answer) ?? $answer;
    if ($withoutParentheses !== $answer) $forms[] = $withoutParentheses;
    $parts = preg_split('/[\/;]|\s+or\s+/ui', $withoutParentheses) ?: [];
    array_push($forms, ...$parts);
    $out = [];
    foreach ($forms as $part) {
        $part = trim($part, " \t\n\r\0\x0B.,:;!?¿¡«»\"'");
        $part = preg_replace('/^(?:el|la|los|las|un|una|unos|unas|al|del|en)\s+/ui', '', $part) ?? $part;
        $n = qnorm($part);
        if ($n !== '' && strlen(str_replace(' ', '', $n)) >= 3) $out[] = $n;
    }
    return array_values(array_unique($out));
}

$seed = load_seed();
$blocked = [];
foreach ($seed['attempts'] as $attempt) {
    if (!empty($attempt['active']) && !empty($attempt['questionKey'])) $blocked[$attempt['questionKey']] = true;
}
foreach ($seed['exposures'] as $exposure) {
    if (!empty($exposure['active']) && !empty($exposure['questionKey'])) $blocked[$exposure['questionKey']] = true;
}

$failures = [];
foreach ($seed['questions'] as $q) {
    if (($q['status'] ?? '') !== 'active') continue;
    if (isset($blocked[$q['questionKey']])) continue;
    $prompt = ' ' . qnorm((string)$q['prompt']) . ' ';
    foreach (answer_forms((string)$q['answer']) as $answer) {
        if (str_contains($prompt, ' ' . $answer . ' ')) {
            $failures[] = $q['questionKey'] . "\t" . $q['categoryId'] . "\tANSWER=" . $q['answer'] . "\tPROMPT=" . $q['prompt'];
            break;
        }
    }
}
if ($failures) {
    fwrite(STDERR, "Playable questions whose prompt contains an answer:\n" . implode("\n", $failures) . "\n");
    exit(1);
}
echo "ok - no playable question contains its answer literally\n";
