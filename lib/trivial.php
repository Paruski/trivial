<?php
declare(strict_types=1);

const TRIVIAL_ROOT = __DIR__ . '/..';
const TRIVIAL_DATA = TRIVIAL_ROOT . '/data';
const TRIVIAL_VAR = TRIVIAL_ROOT . '/var';
const TRIVIAL_BRANCH = 'server-auto';

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
    $handle = fopen($path, 'rb');
    if (!$handle) throw new RuntimeException("No se pudo abrir $path");
    $headers = fgetcsv($handle, 0, ',', '"', '');
    if ($headers === false) { fclose($handle); return []; }
    $rows = [];
    while (($values = fgetcsv($handle, 0, ',', '"', '')) !== false) {
        if (count($values) === 1 && trim((string)$values[0]) === '') continue;
        if (count($values) !== count($headers)) {
            fclose($handle);
            throw new RuntimeException("CSV irregular: $path");
        }
        $rows[] = array_combine($headers, $values);
    }
    fclose($handle);
    return $rows;
}

function load_seed(): array {
    static $cache = null;
    if ($cache !== null) return $cache;

    $metaRows = read_csv_rows(TRIVIAL_DATA . '/meta.csv');
    $meta = [];
    foreach ($metaRows as $row) $meta[$row['key']] = $row['value'];

    $banks = array_map(fn($r) => [
        'bankId'=>$r['bank_id'], 'name'=>$r['name'], 'questionCount'=>(int)$r['question_count']
    ], read_csv_rows(TRIVIAL_DATA . '/banks.csv'));

    $categories = array_map(fn($r) => [
        'bankId'=>$r['bank_id'], 'categoryId'=>$r['category_id'], 'label'=>$r['label'], 'color'=>$r['color'], 'emoji'=>$r['emoji'], 'active'=>csv_bool($r['active'], true)
    ], read_csv_rows(TRIVIAL_DATA . '/categories.csv'));

    $levels = array_map(fn($r) => [
        'levelKey'=>$r['level_key'], 'label'=>$r['label'], 'order'=>(int)$r['order'], 'probabilityWeight'=>(int)$r['probability_weight']
    ], read_csv_rows(TRIVIAL_DATA . '/levels.csv'));

    $questions = [];
    foreach (['AL','LI','FI','HI','IN','NE'] as $category) {
        foreach (read_csv_rows(TRIVIAL_DATA . "/questions-$category.csv") as $r) {
            $questions[] = [
                'questionKey'=>$r['question_key'], 'bankId'=>$r['bank_id'], 'questionId'=>$r['question_id'], 'categoryId'=>$r['category_id'], 'levelKey'=>$r['level_key'],
                'prompt'=>$r['prompt'], 'answer'=>$r['answer'], 'explanation'=>$r['explanation'], 'status'=>$r['status'], 'randomOrder'=>(int)$r['random_order'], 'orderKey'=>$r['order_key']
            ];
        }
    }

    $players = array_map(fn($r) => [
        'playerId'=>$r['player_id'], 'name'=>$r['name'], 'active'=>csv_bool($r['active'], true)
    ], read_csv_rows(TRIVIAL_DATA . '/players.csv'));

    $attempts = [];
    foreach (['J1','J2','J3'] as $player) {
        foreach (read_csv_rows(TRIVIAL_DATA . "/attempts-$player.csv") as $r) {
            $attempts[] = [
                'attemptId'=>$r['attempt_id'], 'matchId'=>$r['match_id'], 'playerId'=>$r['player_id'], 'questionKey'=>$r['question_key'], 'categoryId'=>$r['category_id'], 'levelKey'=>$r['level_key'],
                'computable'=>csv_bool($r['computable'], true), 'correct'=>csv_nullable_bool($r['correct']), 'quesitoAttempt'=>csv_bool($r['quesito_attempt']), 'quesitoWon'=>csv_bool($r['quesito_won']), 'active'=>csv_bool($r['active'], true)
            ];
        }
    }

    $exposures = array_map(fn($r) => [
        'questionKey'=>$r['question_key'] ?: null, 'active'=>csv_bool($r['active'], true)
    ], read_csv_rows(TRIVIAL_DATA . '/exposures.csv'));

    $cache = compact('meta','banks','categories','levels','questions','players','attempts','exposures');
    return $cache;
}

function ensure_var_dir(): void {
    if (!is_dir(TRIVIAL_VAR) && !mkdir(TRIVIAL_VAR, 0775, true) && !is_dir(TRIVIAL_VAR)) throw new RuntimeException('No se pudo crear var/.');
}

function empty_state(): array {
    return ['schemaVersion'=>1, 'revision'=>0, 'matches'=>[], 'events'=>[], 'updatedAt'=>gmdate('c')];
}

function load_state_unlocked(): array {
    ensure_var_dir();
    $path = TRIVIAL_VAR . '/state.json';
    if (!is_file($path)) return empty_state();
    $decoded = json_decode((string)file_get_contents($path), true);
    if (!is_array($decoded) || !isset($decoded['matches'], $decoded['events'])) throw new RuntimeException('state.json no es válido.');
    return $decoded;
}

function save_state_unlocked(array $state): void {
    ensure_var_dir();
    $state['updatedAt'] = gmdate('c');
    $json = json_encode($state, JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_PRETTY_PRINT|JSON_THROW_ON_ERROR);
    $tmp = TRIVIAL_VAR . '/state.json.tmp';
    file_put_contents($tmp, $json . "\n", LOCK_EX);
    rename($tmp, TRIVIAL_VAR . '/state.json');
}

function with_state_lock(callable $callback): mixed {
    ensure_var_dir();
    $lock = fopen(TRIVIAL_VAR . '/state.lock', 'c+');
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
    $lock = fopen(TRIVIAL_VAR . '/state.lock', 'c+');
    if (!$lock) return load_state_unlocked();
    try {
        flock($lock, LOCK_SH);
        $state = load_state_unlocked();
        flock($lock, LOCK_UN);
        return $state;
    } finally { fclose($lock); }
}

function sort_events(array $events): array {
    usort($events, fn($a,$b) => (($a['seq'] ?? 0) <=> ($b['seq'] ?? 0)) ?: strcmp((string)$a['eventId'], (string)$b['eventId']));
    return $events;
}

function reverted_ids(array $events): array {
    $reverted = [];
    foreach (sort_events($events) as $event) {
        $ids = $event['payload']['targetEventIds'] ?? [];
        if ($event['type'] === 'EVENT_REVERTED') foreach ($ids as $id) $reverted[$id] = true;
        if ($event['type'] === 'EVENT_RESTORED') foreach ($ids as $id) unset($reverted[$id]);
    }
    return $reverted;
}

function active_events(array $events): array {
    $reverted = reverted_ids($events);
    return array_values(array_filter(sort_events($events), fn($e) => !in_array($e['type'], ['EVENT_REVERTED','EVENT_RESTORED'], true) && !isset($reverted[$e['eventId']])));
}

function events_for(array $state, string $matchId): array {
    return array_values(array_filter($state['events'], fn($e) => $e['matchId'] === $matchId));
}

function find_match(array $state, string $matchId): array {
    foreach ($state['matches'] as $match) if ($match['matchId'] === $matchId) return $match;
    throw new InvalidArgumentException('Partida no encontrada.');
}

function next_player(array $match, string $playerId): ?string {
    $ids = $match['playerIds'];
    if (!$ids) return null;
    $index = array_search($playerId, $ids, true);
    if ($index === false) $index = 0;
    return $ids[($index + 1) % count($ids)];
}

function derive_state(array $match, array $events): array {
    $state = ['status'=>'open', 'currentPlayerId'=>$match['startingPlayerId'], 'currentDraw'=>null, 'answerRevealed'=>false, 'close'=>null, 'quesitosByPlayer'=>[]];
    foreach (active_events($events) as $event) {
        $p = $event['payload'] ?? [];
        switch ($event['type']) {
            case 'QUESTION_DRAWN':
                $state['currentPlayerId'] = $p['playerId'];
                $state['currentDraw'] = array_merge(['eventId'=>$event['eventId']], $p);
                $state['answerRevealed'] = false;
                break;
            case 'ANSWER_REVEALED':
                if (($state['currentDraw']['eventId'] ?? null) === ($p['drawEventId'] ?? null)) $state['answerRevealed'] = true;
                break;
            case 'RESULT_RECORDED':
                if (!empty($p['quesitoWon'])) $state['quesitosByPlayer'][$p['playerId']][$p['categoryId']] = true;
                if (($state['currentDraw']['eventId'] ?? null) === ($p['drawEventId'] ?? null)) {
                    $turn = $state['currentDraw']['playerId'];
                    $state['currentDraw'] = null;
                    $state['answerRevealed'] = false;
                    $state['currentPlayerId'] = next_player($match, $turn);
                }
                break;
            case 'QUESTION_EXPOSED':
                if (($state['currentDraw']['eventId'] ?? null) === ($p['drawEventId'] ?? null)) {
                    $state['currentDraw'] = null;
                    $state['answerRevealed'] = false;
                }
                break;
            case 'MATCH_CLOSED':
                $state['status'] = 'closed';
                $state['close'] = $p;
                $state['currentDraw'] = null;
                break;
        }
    }
    return $state;
}

function deterministic_unit(string $seed, int $ordinal, string $playerId, string $categoryId): float {
    $text = "$seed|$ordinal|$playerId|$categoryId";
    $hash = 2166136261;
    $bytes = unpack('C*', $text);
    foreach ($bytes as $byte) {
        $hash = ($hash ^ $byte);
        $hash = ($hash * 16777619) & 0xffffffff;
    }
    return $hash / 4294967296;
}

function global_used_keys(array $seed, array $runtime): array {
    $used = [];
    foreach ($seed['questions'] as $q) if ($q['status'] !== 'active') $used[$q['questionKey']] = true;
    foreach ($seed['attempts'] as $a) if ($a['active'] && $a['questionKey']) $used[$a['questionKey']] = true;
    foreach ($seed['exposures'] as $e) if ($e['active'] && $e['questionKey']) $used[$e['questionKey']] = true;
    foreach ($runtime['events'] as $event) if (in_array($event['type'], ['QUESTION_DRAWN','QUESTION_EXPOSED'], true) && !empty($event['payload']['questionKey'])) $used[$event['payload']['questionKey']] = true;
    return $used;
}

function weights_for_match(array $seed, string $bankId, array $categoryIds, array $levelKeys): array {
    $weights = [];
    foreach ($categoryIds as $categoryId) {
        foreach ($levelKeys as $levelKey) {
            $count = 0;
            foreach ($seed['questions'] as $q) if ($q['bankId'] === $bankId && $q['categoryId'] === $categoryId && $q['levelKey'] === $levelKey) $count++;
            $weights[$categoryId][$levelKey] = $count;
        }
    }
    return $weights;
}

function select_question(array $seed, array $runtime, array $match, string $categoryId, ?string $preferredLevel = null): ?array {
    $events = events_for($runtime, $match['matchId']);
    $ordinal = 1;
    foreach ($events as $event) if ($event['type'] === 'QUESTION_DRAWN') $ordinal++;
    $used = global_used_keys($seed, $runtime);
    $byLevel = [];
    foreach ($match['levelKeys'] as $levelKey) $byLevel[$levelKey] = [];
    foreach ($seed['questions'] as $q) {
        if ($q['bankId'] !== $match['bankId'] || $q['categoryId'] !== $categoryId || $q['status'] !== 'active' || isset($used[$q['questionKey']])) continue;
        if (!array_key_exists($q['levelKey'], $byLevel)) continue;
        $byLevel[$q['levelKey']][] = $q;
    }
    foreach ($byLevel as &$questions) usort($questions, fn($a,$b) => ($a['randomOrder'] <=> $b['randomOrder']) ?: strcmp($a['questionKey'],$b['questionKey']));
    unset($questions);
    $derived = derive_state($match, $events);
    $playerId = (string)$derived['currentPlayerId'];
    if ($preferredLevel !== null && !empty($byLevel[$preferredLevel])) {
        return ['question'=>$byLevel[$preferredLevel][0], 'levelKey'=>$preferredLevel, 'unit'=>deterministic_unit($match['seed'],$ordinal,$playerId,$categoryId), 'effectiveWeights'=>[$preferredLevel=>1], 'ordinal'=>$ordinal, 'reason'=>'same_level_replacement'];
    }
    $weighted = [];
    foreach ($match['levelKeys'] as $levelKey) if (!empty($byLevel[$levelKey])) $weighted[$levelKey] = max(0, (int)($match['levelWeights'][$categoryId][$levelKey] ?? 0));
    if (!$weighted) return null;
    if (array_sum($weighted) <= 0) foreach ($weighted as $key => $_) $weighted[$key] = 1;
    $unit = deterministic_unit($match['seed'],$ordinal,$playerId,$categoryId);
    $cursor = $unit * array_sum($weighted);
    $chosen = array_key_last($weighted);
    foreach ($weighted as $key=>$weight) {
        if ($cursor < $weight) { $chosen = $key; break; }
        $cursor -= $weight;
    }
    return ['question'=>$byLevel[$chosen][0], 'levelKey'=>$chosen, 'unit'=>$unit, 'effectiveWeights'=>$weighted, 'ordinal'=>$ordinal, 'reason'=>'weighted'];
}

function append_event(array &$state, string $matchId, string $type, array $payload, ?string $actionId = null): array {
    $seq = 1;
    foreach ($state['events'] as $e) if ($e['matchId'] === $matchId) $seq = max($seq, ((int)$e['seq']) + 1);
    $event = [
        'eventId'=>'E-' . bin2hex(random_bytes(8)), 'matchId'=>$matchId, 'seq'=>$seq, 'timestamp'=>gmdate('c'), 'type'=>$type,
        'actionId'=>$actionId ?? ('A-' . bin2hex(random_bytes(8))), 'payload'=>$payload
    ];
    $state['events'][] = $event;
    return $event;
}

function can_undo(array $events): bool {
    foreach (array_reverse(active_events($events)) as $event) if (in_array($event['type'], ['RESULT_RECORDED','QUESTION_EXPOSED','MATCH_CLOSED'], true)) return true;
    return false;
}

function can_redo(array $events): bool {
    $reverted = reverted_ids($events);
    foreach (array_reverse($events) as $event) if ($event['type'] === 'EVENT_REVERTED') foreach (($event['payload']['targetEventIds'] ?? []) as $id) if (isset($reverted[$id])) return true;
    return false;
}

function undo_action(array &$runtime, array $match): void {
    $events = events_for($runtime, $match['matchId']);
    $derived = derive_state($match, $events);
    if (!empty($derived['currentDraw']) && empty($derived['currentDraw']['replacementForEventId'])) throw new InvalidArgumentException('Resuelve la pregunta pendiente antes de deshacer.');
    $active = active_events($events);
    $candidate = null;
    foreach (array_reverse($active) as $event) if (in_array($event['type'], ['RESULT_RECORDED','QUESTION_EXPOSED','MATCH_CLOSED'], true)) { $candidate = $event; break; }
    if (!$candidate) throw new InvalidArgumentException('No hay nada que deshacer.');
    $targets = [];
    foreach ($active as $event) if ($event['actionId'] === $candidate['actionId'] && in_array($event['type'], ['RESULT_RECORDED','QUESTION_EXPOSED','QUESTION_DRAWN','MATCH_CLOSED'], true)) $targets[] = $event['eventId'];
    append_event($runtime, $match['matchId'], 'EVENT_REVERTED', ['targetEventIds'=>$targets, 'label'=>$candidate['type']]);
}

function redo_action(array &$runtime, array $match): void {
    $events = events_for($runtime, $match['matchId']);
    $reverted = reverted_ids($events);
    $target = null;
    foreach (array_reverse($events) as $event) {
        if ($event['type'] !== 'EVENT_REVERTED') continue;
        foreach (($event['payload']['targetEventIds'] ?? []) as $id) if (isset($reverted[$id])) { $target = $event['payload']['targetEventIds']; break 2; }
    }
    if (!$target) throw new InvalidArgumentException('No hay nada que rehacer.');
    append_event($runtime, $match['matchId'], 'EVENT_RESTORED', ['targetEventIds'=>$target]);
}

function match_detail(array $seed, array $runtime, array $match): array {
    $events = events_for($runtime, $match['matchId']);
    $derived = derive_state($match, $events);
    $used = global_used_keys($seed, $runtime);
    $stock = [];
    foreach ($match['categoryIds'] as $categoryId) foreach ($match['levelKeys'] as $levelKey) {
        $count = 0;
        foreach ($seed['questions'] as $q) if ($q['bankId'] === $match['bankId'] && $q['categoryId'] === $categoryId && $q['levelKey'] === $levelKey && $q['status'] === 'active' && !isset($used[$q['questionKey']])) $count++;
        $stock[] = ['categoryId'=>$categoryId,'levelKey'=>$levelKey,'count'=>$count];
    }
    $results = [];
    foreach (active_events($events) as $event) if ($event['type'] === 'RESULT_RECORDED') $results[] = $event['payload'];
    $marker = [];
    foreach ($match['playerIds'] as $playerId) {
        $playerResults = array_values(array_filter($results, fn($r)=>$r['playerId']===$playerId));
        $marker[] = [
            'playerId'=>$playerId,
            'correct'=>count(array_filter($playerResults, fn($r)=>!empty($r['correct']))),
            'wrong'=>count(array_filter($playerResults, fn($r)=>empty($r['correct']))),
            'quesitos'=>array_keys($derived['quesitosByPlayer'][$playerId] ?? [])
        ];
    }
    return ['match'=>$match,'state'=>$derived,'stock'=>$stock,'marker'=>$marker,'events'=>$events,'canUndo'=>can_undo($events),'canRedo'=>can_redo($events),'revision'=>$runtime['revision']];
}

function create_match(array &$runtime, array $payload): array {
    $seed = load_seed();
    $bankId = trim((string)($payload['bankId'] ?? ''));
    $playerIds = array_values(array_unique(array_map('strval', $payload['playerIds'] ?? [])));
    $categoryIds = array_values(array_unique(array_map('strval', $payload['categoryIds'] ?? [])));
    $levelKeys = array_values(array_unique(array_map('strval', $payload['levelKeys'] ?? [])));
    $startingPlayerId = (string)($payload['startingPlayerId'] ?? '');
    if (count($playerIds) < 1 || count($playerIds) > 3) throw new InvalidArgumentException('Selecciona entre uno y tres jugadores.');
    if (!in_array($startingPlayerId, $playerIds, true)) throw new InvalidArgumentException('Elige qué jugador empieza.');
    if (!$categoryIds) throw new InvalidArgumentException('Selecciona al menos una categoría.');
    if (!$levelKeys) throw new InvalidArgumentException('Selecciona al menos un nivel.');
    $validBank = false; foreach ($seed['banks'] as $b) if ($b['bankId'] === $bankId) $validBank = true;
    if (!$validBank) throw new InvalidArgumentException('Banco no válido.');
    $validPlayers = array_column(array_filter($seed['players'], fn($p)=>$p['active']), 'playerId');
    foreach ($playerIds as $id) if (!in_array($id,$validPlayers,true)) throw new InvalidArgumentException("Jugador no válido: $id");
    $validCategories = array_column(array_filter($seed['categories'], fn($c)=>$c['active'] && $c['bankId']===$bankId), 'categoryId');
    foreach ($categoryIds as $id) if (!in_array($id,$validCategories,true)) throw new InvalidArgumentException("Categoría no válida: $id");
    $validLevels = array_column($seed['levels'],'levelKey');
    foreach ($levelKeys as $id) if (!in_array($id,$validLevels,true)) throw new InvalidArgumentException("Nivel no válido: $id");
    $used = global_used_keys($seed,$runtime);
    foreach ($categoryIds as $categoryId) {
        $count=0; foreach ($seed['questions'] as $q) if ($q['bankId']===$bankId && $q['categoryId']===$categoryId && in_array($q['levelKey'],$levelKeys,true) && $q['status']==='active' && !isset($used[$q['questionKey']])) $count++;
        if (!$count) throw new InvalidArgumentException("No queda stock compatible en $categoryId.");
    }
    $now = gmdate('c');
    $matchId = 'M' . gmdate('Ymd') . '-' . bin2hex(random_bytes(4));
    $name = trim((string)($payload['name'] ?? '')) ?: ('Partida ' . date('d/m/Y'));
    $playerMap=[]; foreach($seed['players'] as $p) $playerMap[$p['playerId']]=$p;
    $categoryMap=[]; foreach($seed['categories'] as $c) if($c['bankId']===$bankId) $categoryMap[$c['categoryId']]=$c;
    $levelMap=[]; foreach($seed['levels'] as $l) $levelMap[$l['levelKey']]=$l;
    $match = [
        'matchId'=>$matchId,'name'=>$name,'bankId'=>$bankId,'playerIds'=>$playerIds,'categoryIds'=>$categoryIds,'levelKeys'=>$levelKeys,'startingPlayerId'=>$startingPlayerId,
        'seed'=>bin2hex(random_bytes(16)),'levelWeights'=>weights_for_match($seed,$bankId,$categoryIds,$levelKeys),'createdAt'=>$now,
        'snapshot'=>[
            'players'=>array_map(fn($id)=>['playerId'=>$id,'name'=>$playerMap[$id]['name']],$playerIds),
            'categories'=>array_map(fn($id)=>['categoryId'=>$id,'label'=>$categoryMap[$id]['label'],'color'=>$categoryMap[$id]['color'],'emoji'=>$categoryMap[$id]['emoji']],$categoryIds),
            'levels'=>array_map(fn($id)=>['levelKey'=>$id,'label'=>$levelMap[$id]['label']],$levelKeys)
        ]
    ];
    $runtime['matches'][] = $match;
    append_event($runtime,$matchId,'MATCH_CREATED',['matchId'=>$matchId,'bankId'=>$bankId,'playerIds'=>$playerIds,'categoryIds'=>$categoryIds,'levelKeys'=>$levelKeys,'startingPlayerId'=>$startingPlayerId,'seed'=>$match['seed'],'levelWeights'=>$match['levelWeights']]);
    $runtime['revision'] = ((int)$runtime['revision']) + 1;
    return match_detail($seed,$runtime,$match);
}

function perform_action(array &$runtime, string $matchId, array $payload): array {
    $seed = load_seed();
    $match = find_match($runtime,$matchId);
    $events = events_for($runtime,$matchId);
    $derived = derive_state($match,$events);
    $action = (string)($payload['action'] ?? '');
    if ($derived['status']==='closed' && !in_array($action,['undo','redo'],true)) throw new InvalidArgumentException('La partida está cerrada.');
    if ($action === 'draw') {
        if ($derived['currentDraw']) throw new InvalidArgumentException('Ya hay una pregunta pendiente.');
        $categoryId=(string)($payload['categoryId']??''); if(!in_array($categoryId,$match['categoryIds'],true)) throw new InvalidArgumentException('Categoría no válida.');
        $selected=select_question($seed,$runtime,$match,$categoryId); if(!$selected) throw new InvalidArgumentException('No queda stock para esa categoría.');
        $q=$selected['question'];
        append_event($runtime,$matchId,'QUESTION_DRAWN',['drawOrdinal'=>$selected['ordinal'],'randomUnit'=>$selected['unit'],'effectiveWeights'=>$selected['effectiveWeights'],'playerId'=>$derived['currentPlayerId'],'categoryId'=>$categoryId,'levelKey'=>$selected['levelKey'],'questionKey'=>$q['questionKey'],'quesitoAttempt'=>!empty($payload['quesitoAttempt']),'selectionReason'=>$selected['reason'],'prompt'=>$q['prompt'],'answer'=>$q['answer'],'explanation'=>$q['explanation']]);
    } elseif ($action === 'reveal') {
        if(!$derived['currentDraw']) throw new InvalidArgumentException('No hay pregunta pendiente.');
        if(!$derived['answerRevealed']) append_event($runtime,$matchId,'ANSWER_REVEALED',['drawEventId'=>$derived['currentDraw']['eventId'],'questionKey'=>$derived['currentDraw']['questionKey']]);
    } elseif ($action === 'result') {
        $draw=$derived['currentDraw']; if(!$draw || !$derived['answerRevealed']) throw new InvalidArgumentException('Muestra primero la respuesta.');
        if(!array_key_exists('correct',$payload) || !is_bool($payload['correct'])) throw new InvalidArgumentException('Resultado inválido.');
        $correct=$payload['correct']; $playerId=$draw['playerId']; $owned=$derived['quesitosByPlayer'][$playerId]??[];
        $quesitoWon=$correct && !empty($draw['quesitoAttempt']) && empty($owned[$draw['categoryId']]);
        $actionId='A-'.bin2hex(random_bytes(8));
        append_event($runtime,$matchId,'RESULT_RECORDED',['drawEventId'=>$draw['eventId'],'questionKey'=>$draw['questionKey'],'playerId'=>$playerId,'categoryId'=>$draw['categoryId'],'levelKey'=>$draw['levelKey'],'correct'=>$correct,'quesitoAttempt'=>!empty($draw['quesitoAttempt']),'quesitoWon'=>$quesitoWon],$actionId);
        if($quesitoWon) $owned[$draw['categoryId']]=true;
        $won=true; foreach($match['categoryIds'] as $categoryId) if(empty($owned[$categoryId])) $won=false;
        if($won) append_event($runtime,$matchId,'MATCH_CLOSED',['reason'=>'victoria','winners'=>[$playerId]],$actionId);
    } elseif ($action === 'discard') {
        $draw=$derived['currentDraw']; if(!$draw) throw new InvalidArgumentException('No hay pregunta pendiente.');
        $actionId='A-'.bin2hex(random_bytes(8));
        append_event($runtime,$matchId,'QUESTION_EXPOSED',['drawEventId'=>$draw['eventId'],'questionKey'=>$draw['questionKey'],'playerId'=>$draw['playerId'],'categoryId'=>$draw['categoryId'],'levelKey'=>$draw['levelKey'],'quesitoAttempt'=>!empty($draw['quesitoAttempt']),'reason'=>(string)($payload['reason']??'otro'),'note'=>substr(trim((string)($payload['note']??'')),0,500)],$actionId);
        $selected=select_question($seed,$runtime,$match,$draw['categoryId'],$draw['levelKey']);
        if($selected){$q=$selected['question'];append_event($runtime,$matchId,'QUESTION_DRAWN',['drawOrdinal'=>$selected['ordinal'],'randomUnit'=>$selected['unit'],'effectiveWeights'=>$selected['effectiveWeights'],'playerId'=>$draw['playerId'],'categoryId'=>$draw['categoryId'],'levelKey'=>$selected['levelKey'],'questionKey'=>$q['questionKey'],'quesitoAttempt'=>!empty($draw['quesitoAttempt']),'replacementForEventId'=>$draw['eventId'],'selectionReason'=>$selected['reason'],'prompt'=>$q['prompt'],'answer'=>$q['answer'],'explanation'=>$q['explanation']],$actionId);}
    } elseif ($action === 'undo') {
        undo_action($runtime,$match);
    } elseif ($action === 'redo') {
        redo_action($runtime,$match);
    } elseif ($action === 'close') {
        if($derived['currentDraw']) throw new InvalidArgumentException('Resuelve o descarta la pregunta pendiente.');
        append_event($runtime,$matchId,'MATCH_CLOSED',['reason'=>'manual','winners'=>[]]);
    } else throw new InvalidArgumentException('Acción desconocida.');
    $runtime['revision']=((int)$runtime['revision'])+1;
    $match=find_match($runtime,$matchId);
    return match_detail($seed,$runtime,$match);
}

function compute_stats(array $seed, array $runtime): array {
    $rows=[];
    foreach($seed['attempts'] as $a) if($a['active']&&$a['computable']&&$a['correct']!==null) $rows[]=['matchId'=>$a['matchId'],'playerId'=>$a['playerId'],'categoryId'=>$a['categoryId'],'levelKey'=>$a['levelKey'],'correct'=>$a['correct'],'quesitoAttempt'=>$a['quesitoAttempt'],'quesitoWon'=>$a['quesitoWon']];
    foreach($runtime['matches'] as $match) foreach(active_events(events_for($runtime,$match['matchId'])) as $event) if($event['type']==='RESULT_RECORDED') $rows[]=array_merge(['matchId'=>$match['matchId']],$event['payload']);
    $aggregate=function(callable $keyFn) use($rows){$map=[];foreach($rows as $r){$key=$keyFn($r);if(!isset($map[$key]))$map[$key]=['key'=>$key,'attempts'=>0,'correct'=>0,'wrong'=>0,'quesitoAttempts'=>0,'quesitosWon'=>0];$map[$key]['attempts']++;$map[$key]['correct']+=$r['correct']?1:0;$map[$key]['wrong']+=$r['correct']?0:1;$map[$key]['quesitoAttempts']+=!empty($r['quesitoAttempt'])?1:0;$map[$key]['quesitosWon']+=!empty($r['quesitoWon'])?1:0;}foreach($map as &$x)$x['accuracy']=$x['attempts']?$x['correct']/$x['attempts']:0;return array_values($map);};
    return ['rows'=>$rows,'byPlayer'=>$aggregate(fn($r)=>$r['playerId']),'byPlayerCategory'=>$aggregate(fn($r)=>$r['playerId'].'|'.$r['categoryId']),'byPlayerLevel'=>$aggregate(fn($r)=>$r['playerId'].'|'.$r['levelKey'])];
}

function bootstrap_payload(array $seed, array $runtime): array {
    $used=global_used_keys($seed,$runtime);$stock=[];
    foreach($seed['categories'] as $category) if($category['active']) foreach($seed['levels'] as $level){$count=0;foreach($seed['questions'] as $q)if($q['bankId']===$category['bankId']&&$q['categoryId']===$category['categoryId']&&$q['levelKey']===$level['levelKey']&&$q['status']==='active'&&!isset($used[$q['questionKey']]))$count++;$stock[]=['bankId'=>$category['bankId'],'categoryId'=>$category['categoryId'],'levelKey'=>$level['levelKey'],'count'=>$count];}
    $matches=[];foreach(array_reverse($runtime['matches']) as $match){$state=derive_state($match,events_for($runtime,$match['matchId']));$matches[]=['matchId'=>$match['matchId'],'name'=>$match['name'],'playerIds'=>$match['playerIds'],'startingPlayerId'=>$match['startingPlayerId'],'status'=>$state['status'],'createdAt'=>$match['createdAt']];}
    return ['seedVersion'=>$seed['meta']['seed_version']??null,'banks'=>$seed['banks'],'categories'=>$seed['categories'],'levels'=>$seed['levels'],'players'=>$seed['players'],'matches'=>$matches,'base'=>['questionCount'=>count($seed['questions']),'availableQuestionCount'=>count($seed['questions'])-count($used),'usedQuestionCount'=>count($used),'stock'=>$stock],'revision'=>$runtime['revision'],'update'=>auto_update_status()];
}

function auto_update_status(): array {
    ensure_var_dir();
    $path=TRIVIAL_VAR.'/auto-update.json';
    if(!is_file($path)) return ['enabled'=>true,'lastCheck'=>null,'ok'=>null,'message'=>'Aún no comprobado'];
    $data=json_decode((string)file_get_contents($path),true);return is_array($data)?$data:['enabled'=>true,'lastCheck'=>null,'ok'=>false,'message'=>'Estado de actualización ilegible'];
}

function maybe_auto_update(int $intervalSeconds=300): void {
    if (getenv('TRIVIAL_AUTO_UPDATE') === '0') return;
    ensure_var_dir();
    $status=auto_update_status();
    $last=$status['lastCheck']??null;
    if($last && time()-strtotime((string)$last)<$intervalSeconds) return;
    $lock=fopen(TRIVIAL_VAR.'/update.lock','c+'); if(!$lock||!flock($lock,LOCK_EX|LOCK_NB)){if($lock)fclose($lock);return;}
    try{
        $status=auto_update_status();$last=$status['lastCheck']??null;if($last&&time()-strtotime((string)$last)<$intervalSeconds)return;
        if(!is_dir(TRIVIAL_ROOT.'/.git')||!function_exists('exec')){$result=['enabled'=>true,'lastCheck'=>gmdate('c'),'ok'=>false,'message'=>'Sin checkout Git o exec; se omite la autoactualización.'];}
        else{
            $cmd='git -C '.escapeshellarg(realpath(TRIVIAL_ROOT)).' pull --ff-only origin '.escapeshellarg(TRIVIAL_BRANCH).' 2>&1';$output=[];$code=0;exec($cmd,$output,$code);
            $result=['enabled'=>true,'lastCheck'=>gmdate('c'),'ok'=>$code===0,'message'=>implode("\n",array_slice($output,-6)) ?: ($code===0?'Actualizado':'git pull falló')];
        }
        file_put_contents(TRIVIAL_VAR.'/auto-update.json',json_encode($result,JSON_UNESCAPED_UNICODE|JSON_PRETTY_PRINT)."\n",LOCK_EX);
    }finally{flock($lock,LOCK_UN);fclose($lock);}
}
