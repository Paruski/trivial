<?php
declare(strict_types=1);

const TRIVIAL_ROOT = __DIR__ . '/..';

function trivial_path_from_env(string $name, string $fallback): string {
    $value = getenv($name);
    $path = $value !== false && trim($value) !== '' ? trim($value) : $fallback;
    if (!preg_match('~^(?:[A-Za-z]:[\\/]|/)~', $path)) {
        $path = TRIVIAL_ROOT . '/' . ltrim($path, '/\\');
    }
    return rtrim($path, '/\\');
}

function trivial_data_dir(): string {
    return trivial_path_from_env('TRIVIAL_DATA_DIR', TRIVIAL_ROOT . '/data');
}

function csv_bool(mixed $value, bool $fallback = false): bool {
    $value = strtolower(trim((string)$value));
    if (in_array($value, ['true','1','yes','si','sí'], true)) return true;
    if (in_array($value, ['false','0','no'], true)) return false;
    return $fallback;
}

function csv_nullable_bool(mixed $value): ?bool {
    $value = trim((string)$value);
    return $value === '' ? null : csv_bool($value);
}

function read_csv_rows(string $path): array {
    $handle = @fopen($path, 'rb');
    if (!$handle) throw new RuntimeException("No se pudo abrir el CSV: $path");
    try {
        $headers = fgetcsv($handle, 0, ',', '"', '');
        if ($headers === false) return [];
        $headers = array_map(static fn($v) => trim((string)$v), $headers);
        if (count(array_unique($headers)) !== count($headers)) {
            throw new RuntimeException("Cabeceras duplicadas en $path");
        }
        $rows = [];
        $line = 1;
        while (($values = fgetcsv($handle, 0, ',', '"', '')) !== false) {
            $line++;
            if (count($values) === 1 && trim((string)$values[0]) === '') continue;
            if (count($values) !== count($headers)) {
                throw new RuntimeException("CSV irregular en $path, línea $line");
            }
            $row = array_combine($headers, $values);
            if ($row === false) throw new RuntimeException("No se pudo leer $path, línea $line");
            $rows[] = $row;
        }
        return $rows;
    } finally {
        fclose($handle);
    }
}

function optional_csv_rows(string $filename): array {
    $path = trivial_data_dir() . '/' . $filename;
    return is_file($path) ? read_csv_rows($path) : [];
}

function discover_csv_files(string $prefix): array {
    $root = trivial_data_dir();
    $files = glob($root . '/' . $prefix . '-*.csv') ?: [];
    $nested = $root . '/' . $prefix;
    if (is_dir($nested)) {
        $iterator = new RecursiveIteratorIterator(
            new RecursiveDirectoryIterator($nested, FilesystemIterator::SKIP_DOTS)
        );
        foreach ($iterator as $file) {
            if ($file->isFile() && strtolower($file->getExtension()) === 'csv') {
                $files[] = $file->getPathname();
            }
        }
    }
    $files = array_values(array_unique(array_map(static fn($p) => str_replace('\\', '/', $p), $files)));
    sort($files, SORT_STRING);
    return $files;
}

function relative_data_path(string $path): string {
    $root = str_replace('\\', '/', trivial_data_dir());
    $path = str_replace('\\', '/', $path);
    return str_starts_with($path, $root . '/') ? substr($path, strlen($root) + 1) : basename($path);
}

function content_files(): array {
    $root = trivial_data_dir();
    $files = [];
    foreach (['meta.csv','banks.csv','categories.csv','levels.csv','players.csv','exposures.csv','matches.csv','participants.csv'] as $name) {
        $path = $root . '/' . $name;
        if (is_file($path)) $files[] = $path;
    }
    array_push($files, ...discover_csv_files('questions'), ...discover_csv_files('attempts'));
    $files = array_values(array_unique($files));
    sort($files, SORT_STRING);
    return $files;
}

function content_signature(): string {
    $parts = [];
    foreach (content_files() as $path) {
        $stat = @stat($path);
        $parts[] = relative_data_path($path) . ':' . ($stat['size'] ?? -1) . ':' . ($stat['mtime'] ?? -1) . ':' . ($stat['ctime'] ?? -1);
    }
    return hash('sha256', implode('|', $parts));
}

function normalized_prompt(string $text): string {
    $text = trim(preg_replace('/\s+/u', ' ', $text) ?? $text);
    return function_exists('mb_strtolower') ? mb_strtolower($text, 'UTF-8') : strtolower($text);
}

function require_fields(array $row, array $fields, string $source): void {
    foreach ($fields as $field) {
        if (!array_key_exists($field, $row) || trim((string)$row[$field]) === '') {
            throw new RuntimeException("Falta $field en $source");
        }
    }
}

function load_seed(): array {
    static $cachedSignature = null;
    static $cache = null;

    $signature = content_signature();
    if ($cache !== null && $cachedSignature === $signature) return $cache;

    $root = trivial_data_dir();
    foreach (['meta.csv','banks.csv','categories.csv','levels.csv','players.csv'] as $required) {
        if (!is_file($root . '/' . $required)) {
            throw new RuntimeException("Falta el catálogo obligatorio: $required en " . trivial_data_dir());
        }
    }

    $meta = [];
    foreach (read_csv_rows($root . '/meta.csv') as $row) {
        require_fields($row, ['key','value'], 'meta.csv');
        $meta[$row['key']] = $row['value'];
    }

    $banks = [];
    foreach (read_csv_rows($root . '/banks.csv') as $row) {
        require_fields($row, ['bank_id','name'], 'banks.csv');
        $banks[] = [
            'bankId'=>$row['bank_id'],
            'name'=>$row['name'],
            'seedVersion'=>$row['seed_version'] ?? null,
            'declaredQuestionCount'=>(int)($row['question_count'] ?? 0),
            'questionCount'=>0,
            'levelWeightsPolicy'=>$row['level_weights_policy'] ?? null,
        ];
    }

    $categories = [];
    foreach (read_csv_rows($root . '/categories.csv') as $row) {
        require_fields($row, ['bank_id','category_id','label'], 'categories.csv');
        $categories[] = [
            'bankId'=>$row['bank_id'],
            'categoryId'=>$row['category_id'],
            'label'=>$row['label'],
            'color'=>$row['color'] ?? '',
            'colorCss'=>trim((string)($row['color_css'] ?? '')) ?: '#6b7280',
            'emoji'=>$row['emoji'] ?? '',
            'active'=>csv_bool($row['active'] ?? 'true', true),
            'quesitoDefault'=>csv_bool($row['quesito_default'] ?? 'true', true),
        ];
    }

    $levels = [];
    foreach (read_csv_rows($root . '/levels.csv') as $row) {
        require_fields($row, ['level_key','label'], 'levels.csv');
        $levels[] = [
            'levelKey'=>$row['level_key'],
            'label'=>$row['label'],
            'order'=>(int)($row['order'] ?? 0),
            'probabilityWeight'=>(int)($row['probability_weight'] ?? 0),
        ];
    }
    usort($levels, static fn($a,$b) => ($a['order'] <=> $b['order']) ?: strcmp($a['levelKey'],$b['levelKey']));

    $players = [];
    foreach (read_csv_rows($root . '/players.csv') as $row) {
        require_fields($row, ['player_id','name'], 'players.csv');
        $players[] = [
            'playerId'=>$row['player_id'],
            'name'=>$row['name'],
            'active'=>csv_bool($row['active'] ?? 'true', true),
        ];
    }

    $questions = [];
    $questionFiles = discover_csv_files('questions');
    if (!$questionFiles) throw new RuntimeException('No se encontró ningún CSV de preguntas (questions-*.csv o questions/*.csv).');
    foreach ($questionFiles as $path) {
        $source = relative_data_path($path);
        foreach (read_csv_rows($path) as $row) {
            require_fields($row, ['question_key','bank_id','question_id','category_id','level_key','prompt','answer'], $source);
            $questions[] = [
                'questionKey'=>$row['question_key'],
                'bankId'=>$row['bank_id'],
                'questionId'=>$row['question_id'],
                'categoryId'=>$row['category_id'],
                'levelKey'=>$row['level_key'],
                'prompt'=>$row['prompt'],
                'answer'=>$row['answer'],
                'explanation'=>$row['explanation'] ?? '',
                'status'=>trim((string)($row['status'] ?? 'active')) ?: 'active',
                'randomOrder'=>(int)($row['random_order'] ?? 0),
                'orderKey'=>$row['order_key'] ?? '',
                'sourceFile'=>$source,
            ];
        }
    }

    $attempts = [];
    foreach (discover_csv_files('attempts') as $path) {
        $source = relative_data_path($path);
        foreach (read_csv_rows($path) as $row) {
            require_fields($row, ['attempt_id','match_id','player_id'], $source);
            $attempts[] = [
                'attemptId'=>$row['attempt_id'],
                'matchId'=>$row['match_id'],
                'playerId'=>$row['player_id'],
                'questionKey'=>trim((string)($row['question_key'] ?? '')) ?: null,
                'categoryId'=>$row['category_id'] ?? null,
                'levelKey'=>$row['level_key'] ?? null,
                'computable'=>csv_bool($row['computable'] ?? 'true', true),
                'correct'=>csv_nullable_bool($row['correct'] ?? ''),
                'quesitoAttempt'=>csv_bool($row['quesito_attempt'] ?? 'false'),
                'quesitoWon'=>csv_bool($row['quesito_won'] ?? 'false'),
                'active'=>csv_bool($row['active'] ?? 'true', true),
            ];
        }
    }

    $exposures = [];
    foreach (optional_csv_rows('exposures.csv') as $row) {
        $exposures[] = [
            'questionKey'=>trim((string)($row['question_key'] ?? '')) ?: null,
            'active'=>csv_bool($row['active'] ?? 'true', true),
        ];
    }

    $historicalMatches = optional_csv_rows('matches.csv');
    $historicalParticipants = optional_csv_rows('participants.csv');

    $bankIds = [];
    foreach ($banks as $bank) {
        if (isset($bankIds[$bank['bankId']])) throw new RuntimeException('bank_id duplicado: ' . $bank['bankId']);
        $bankIds[$bank['bankId']] = true;
    }
    $levelIds = [];
    foreach ($levels as $level) {
        if (isset($levelIds[$level['levelKey']])) throw new RuntimeException('level_key duplicado: ' . $level['levelKey']);
        $levelIds[$level['levelKey']] = true;
    }
    $playerIds = [];
    foreach ($players as $player) {
        if (isset($playerIds[$player['playerId']])) throw new RuntimeException('player_id duplicado: ' . $player['playerId']);
        $playerIds[$player['playerId']] = true;
    }
    $categoryIds = [];
    foreach ($categories as $category) {
        if (!isset($bankIds[$category['bankId']])) throw new RuntimeException('Categoría con banco inexistente: ' . $category['bankId']);
        $key = $category['bankId'] . '|' . $category['categoryId'];
        if (isset($categoryIds[$key])) throw new RuntimeException('Categoría duplicada: ' . $key);
        $categoryIds[$key] = true;
    }

    $questionIds = [];
    $activePrompts = [];
    $questionBuckets = [];
    $questionCountByBank = [];
    foreach ($questions as $question) {
        $qKey = $question['questionKey'];
        if (isset($questionIds[$qKey])) throw new RuntimeException('question_key duplicado: ' . $qKey);
        $questionIds[$qKey] = true;
        if (!isset($bankIds[$question['bankId']])) throw new RuntimeException("Pregunta $qKey con banco inexistente");
        if (!isset($categoryIds[$question['bankId'].'|'.$question['categoryId']])) throw new RuntimeException("Pregunta $qKey con categoría inexistente");
        if (!isset($levelIds[$question['levelKey']])) throw new RuntimeException("Pregunta $qKey con nivel inexistente");
        if ($question['status'] === 'active') {
            $promptKey = normalized_prompt($question['prompt']);
            if ($promptKey !== '' && isset($activePrompts[$promptKey])) {
                throw new RuntimeException("Pregunta activa duplicada por enunciado: {$activePrompts[$promptKey]} y $qKey");
            }
            $activePrompts[$promptKey] = $qKey;
        }
        $questionBuckets[$question['bankId']][$question['categoryId']][$question['levelKey']][] = $question;
        $questionCountByBank[$question['bankId']] = ($questionCountByBank[$question['bankId']] ?? 0) + 1;
    }
    foreach ($questionBuckets as &$byCategory) {
        foreach ($byCategory as &$byLevel) {
            foreach ($byLevel as &$bucket) {
                usort($bucket, static fn($a,$b) => ($a['randomOrder'] <=> $b['randomOrder']) ?: strcmp($a['questionKey'],$b['questionKey']));
            }
            unset($bucket);
        }
        unset($byLevel);
    }
    unset($byCategory);

    $warnings = [];
    foreach ($banks as &$bank) {
        $actual = $questionCountByBank[$bank['bankId']] ?? 0;
        $bank['questionCount'] = $actual;
        if ($bank['declaredQuestionCount'] > 0 && $bank['declaredQuestionCount'] !== $actual) {
            $warnings[] = "{$bank['bankId']}: question_count declara {$bank['declaredQuestionCount']} y los CSV contienen $actual";
        }
    }
    unset($bank);

    $cache = compact(
        'meta','banks','categories','levels','players','questions','attempts','exposures',
        'historicalMatches','historicalParticipants','questionBuckets','warnings'
    );
    $cache['signature'] = $signature;
    $cache['sourceFiles'] = array_map('relative_data_path', content_files());
    $cachedSignature = $signature;
    return $cache;
}

function content_diagnostics(array $seed): array {
    return [
        'signature'=>$seed['signature'],
        'sourceFiles'=>$seed['sourceFiles'],
        'banks'=>count($seed['banks']),
        'categories'=>count($seed['categories']),
        'levels'=>count($seed['levels']),
        'players'=>count($seed['players']),
        'questions'=>count($seed['questions']),
        'attempts'=>count($seed['attempts']),
        'warnings'=>$seed['warnings'],
    ];
}
