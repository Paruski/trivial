<?php
declare(strict_types=1);
require_once __DIR__ . '/content.php';

function trivial_var_dir(): string {
    return trivial_path_from_env('TRIVIAL_VAR_DIR', TRIVIAL_ROOT . '/var');
}

function ensure_var_dir(): void {
    $dir = trivial_var_dir();
    if (!is_dir($dir) && !mkdir($dir, 0775, true) && !is_dir($dir)) {
        throw new RuntimeException("No se pudo crear el directorio de estado: $dir");
    }
    if (!is_writable($dir)) throw new RuntimeException("El directorio de estado no es escribible: $dir");
}

function empty_state(): array {
    return ['schemaVersion'=>1, 'revision'=>0, 'matches'=>[], 'events'=>[], 'updatedAt'=>gmdate('c')];
}

function load_state_unlocked(): array {
    ensure_var_dir();
    $path = trivial_var_dir() . '/state.json';
    if (!is_file($path)) return empty_state();
    $raw = file_get_contents($path);
    if ($raw === false) throw new RuntimeException('No se pudo leer state.json.');
    $decoded = json_decode($raw, true);
    if (!is_array($decoded) || ($decoded['schemaVersion'] ?? null) !== 1 || !is_array($decoded['matches'] ?? null) || !is_array($decoded['events'] ?? null)) {
        throw new RuntimeException('state.json no es válido o no es compatible.');
    }
    $decoded['revision'] = (int)($decoded['revision'] ?? 0);
    return $decoded;
}

function save_state_unlocked(array $state): void {
    ensure_var_dir();
    $state['schemaVersion'] = 1;
    $state['updatedAt'] = gmdate('c');
    $json = json_encode($state, JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_PRETTY_PRINT|JSON_THROW_ON_ERROR) . "\n";
    $dir = trivial_var_dir();
    $tmp = $dir . '/state.json.tmp';
    if (file_put_contents($tmp, $json, LOCK_EX) === false) throw new RuntimeException('No se pudo escribir el estado temporal.');
    if (!rename($tmp, $dir . '/state.json')) {
        @unlink($tmp);
        throw new RuntimeException('No se pudo publicar state.json de forma atómica.');
    }
}

function with_state_lock(callable $callback): mixed {
    ensure_var_dir();
    $lock = fopen(trivial_var_dir() . '/state.lock', 'c+');
    if (!$lock) throw new RuntimeException('No se pudo abrir el bloqueo de estado.');
    try {
        if (!flock($lock, LOCK_EX)) throw new RuntimeException('No se pudo bloquear el estado.');
        $state = load_state_unlocked();
        $result = $callback($state);
        save_state_unlocked($state);
        flock($lock, LOCK_UN);
        return $result;
    } finally {
        fclose($lock);
    }
}

function read_state(): array {
    ensure_var_dir();
    $lock = fopen(trivial_var_dir() . '/state.lock', 'c+');
    if (!$lock) return load_state_unlocked();
    try {
        if (!flock($lock, LOCK_SH)) return load_state_unlocked();
        $state = load_state_unlocked();
        flock($lock, LOCK_UN);
        return $state;
    } finally {
        fclose($lock);
    }
}

function sort_events(array $events): array {
    usort($events, static fn($a,$b) => (($a['seq'] ?? 0) <=> ($b['seq'] ?? 0)) ?: strcmp((string)($a['eventId'] ?? ''), (string)($b['eventId'] ?? '')));
    return $events;
}

function reverted_ids(array $events): array {
    $reverted = [];
    foreach (sort_events($events) as $event) {
        $ids = $event['payload']['targetEventIds'] ?? [];
        if (($event['type'] ?? '') === 'EVENT_REVERTED') foreach ($ids as $id) $reverted[(string)$id] = true;
        if (($event['type'] ?? '') === 'EVENT_RESTORED') foreach ($ids as $id) unset($reverted[(string)$id]);
    }
    return $reverted;
}

function active_events(array $events): array {
    $reverted = reverted_ids($events);
    return array_values(array_filter(sort_events($events), static function($event) use ($reverted) {
        return !in_array($event['type'] ?? '', ['EVENT_REVERTED','EVENT_RESTORED'], true)
            && !isset($reverted[(string)($event['eventId'] ?? '')]);
    }));
}

function events_for(array $state, string $matchId): array {
    return array_values(array_filter($state['events'], static fn($e) => ($e['matchId'] ?? null) === $matchId));
}

function find_match(array $state, string $matchId): array {
    foreach ($state['matches'] as $match) if (($match['matchId'] ?? null) === $matchId) return $match;
    throw new InvalidArgumentException('Partida no encontrada.');
}

function next_player(array $match, string $playerId): ?string {
    $ids = array_values($match['playerIds'] ?? []);
    if (!$ids) return null;
    $index = array_search($playerId, $ids, true);
    if ($index === false) $index = 0;
    return (string)$ids[($index + 1) % count($ids)];
}

function append_event(array &$state, string $matchId, string $type, array $payload, ?string $actionId = null): array {
    $seq = 1;
    foreach ($state['events'] as $event) {
        if (($event['matchId'] ?? null) === $matchId) $seq = max($seq, ((int)($event['seq'] ?? 0)) + 1);
    }
    $event = [
        'eventId'=>'E-' . bin2hex(random_bytes(8)),
        'matchId'=>$matchId,
        'seq'=>$seq,
        'timestamp'=>gmdate('c'),
        'type'=>$type,
        'actionId'=>$actionId ?? ('A-' . bin2hex(random_bytes(8))),
        'payload'=>$payload,
    ];
    $state['events'][] = $event;
    return $event;
}

function can_redo(array $events): bool {
    $reverted = reverted_ids($events);
    foreach (array_reverse($events) as $event) {
        if (($event['type'] ?? '') !== 'EVENT_REVERTED') continue;
        foreach (($event['payload']['targetEventIds'] ?? []) as $id) if (isset($reverted[(string)$id])) return true;
    }
    return false;
}

function redo_action(array &$runtime, array $match): void {
    $events = events_for($runtime, $match['matchId']);
    $reverted = reverted_ids($events);
    $target = null;
    foreach (array_reverse($events) as $event) {
        if (($event['type'] ?? '') !== 'EVENT_REVERTED') continue;
        foreach (($event['payload']['targetEventIds'] ?? []) as $id) {
            if (isset($reverted[(string)$id])) { $target = $event['payload']['targetEventIds']; break 2; }
        }
    }
    if (!$target) throw new InvalidArgumentException('No hay nada que rehacer.');
    append_event($runtime, $match['matchId'], 'EVENT_RESTORED', ['targetEventIds'=>$target]);
}
