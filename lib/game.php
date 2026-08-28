<?php
declare(strict_types=1);
require_once __DIR__ . '/content.php';
require_once __DIR__ . '/storage.php';

const TRIVIAL_RULES_VERSION = 'server-auto-v2.1';

function player_has_all_quesitos(array $match, array $owned): bool {
    if (empty($match['categoryIds'])) return false;
    foreach ($match['categoryIds'] as $categoryId) if (empty($owned[$categoryId])) return false;
    return true;
}

function derive_state(array $match, array $events): array {
    $state = [
        'status'=>'open',
        'currentPlayerId'=>$match['startingPlayerId'],
        'currentDraw'=>null,
        'answerRevealed'=>false,
        'close'=>null,
        'quesitosByPlayer'=>[],
        'centerReachedByPlayer'=>[],
        'centerReadyPlayerId'=>null,
    ];

    foreach (active_events($events) as $event) {
        $p = $event['payload'] ?? [];
        switch ($event['type'] ?? '') {
            case 'QUESTION_DRAWN':
                $state['currentPlayerId'] = $p['playerId'];
                $state['currentDraw'] = array_merge(['eventId'=>$event['eventId']], $p);
                $state['answerRevealed'] = false;
                break;
            case 'ANSWER_REVEALED':
                if (($state['currentDraw']['eventId'] ?? null) === ($p['drawEventId'] ?? null)) $state['answerRevealed'] = true;
                break;
            case 'CENTER_REACHED':
                $playerId = (string)($p['playerId'] ?? '');
                if ($playerId !== '') {
                    $state['centerReachedByPlayer'][$playerId] = true;
                    $state['currentPlayerId'] = $playerId;
                }
                break;
            case 'RESULT_RECORDED':
                if (!empty($p['quesitoWon'])) $state['quesitosByPlayer'][$p['playerId']][$p['categoryId']] = true;
                if (($state['currentDraw']['eventId'] ?? null) === ($p['drawEventId'] ?? null)) {
                    $turn = (string)$state['currentDraw']['playerId'];
                    $correct = !empty($p['correct']);
                    $state['currentDraw'] = null;
                    $state['answerRevealed'] = false;
                    $state['currentPlayerId'] = $correct ? $turn : next_player($match, $turn);
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
                $state['answerRevealed'] = false;
                break;
        }
    }

    $current = (string)($state['currentPlayerId'] ?? '');
    $state['centerReadyPlayerId'] = $current !== '' && !empty($state['centerReachedByPlayer'][$current]) ? $current : null;
    return $state;
}

function deterministic_unit(string $seed, int $ordinal, string $playerId, string $categoryId): float {
    $text = "$seed|$ordinal|$playerId|$categoryId";
    $hash = 2166136261;
    $bytes = unpack('C*', $text);
    foreach ($bytes as $byte) {
        $hash ^= $byte;
        $hash = ($hash * 16777619) & 0xffffffff;
    }
    return $hash / 4294967296;
}

function global_used_keys(array $seed, array $runtime): array {
    $used = [];
    foreach ($seed['questions'] as $q) if ($q['status'] !== 'active') $used[$q['questionKey']] = true;
    foreach ($seed['attempts'] as $attempt) if ($attempt['active'] && $attempt['questionKey']) $used[$attempt['questionKey']] = true;
    foreach ($seed['exposures'] as $exposure) if ($exposure['active'] && $exposure['questionKey']) $used[$exposure['questionKey']] = true;
    foreach ($runtime['events'] as $event) {
        if (in_array($event['type'] ?? '', ['QUESTION_DRAWN','QUESTION_EXPOSED'], true) && !empty($event['payload']['questionKey'])) {
            $used[$event['payload']['questionKey']] = true;
        }
    }
    return $used;
}

function question_bucket(array $seed, string $bankId, string $categoryId, string $levelKey): array {
    return $seed['questionBuckets'][$bankId][$categoryId][$levelKey] ?? [];
}

function weights_for_match(array $seed, string $bankId, array $categoryIds, array $levelKeys): array {
    $weights = [];
    foreach ($categoryIds as $categoryId) {
        foreach ($levelKeys as $levelKey) {
            $weights[$categoryId][$levelKey] = count(question_bucket($seed, $bankId, $categoryId, $levelKey));
        }
    }
    return $weights;
}

function select_question(array $seed, array $runtime, array $match, string $categoryId, ?string $preferredLevel = null): ?array {
    $events = events_for($runtime, $match['matchId']);
    $ordinal = 1;
    foreach ($events as $event) if (($event['type'] ?? '') === 'QUESTION_DRAWN') $ordinal++;
    $used = global_used_keys($seed, $runtime);
    $availableByLevel = [];

    foreach ($match['levelKeys'] as $levelKey) {
        $availableByLevel[$levelKey] = [];
        foreach (question_bucket($seed, $match['bankId'], $categoryId, $levelKey) as $q) {
            if ($q['status'] === 'active' && !isset($used[$q['questionKey']])) $availableByLevel[$levelKey][] = $q;
        }
    }

    $derived = derive_state($match, $events);
    $playerId = (string)$derived['currentPlayerId'];
    if ($preferredLevel !== null && !empty($availableByLevel[$preferredLevel])) {
        return [
            'question'=>$availableByLevel[$preferredLevel][0],
            'levelKey'=>$preferredLevel,
            'unit'=>deterministic_unit($match['seed'],$ordinal,$playerId,$categoryId),
            'effectiveWeights'=>[$preferredLevel=>1],
            'ordinal'=>$ordinal,
            'reason'=>'same_level_replacement',
        ];
    }

    $weighted = [];
    foreach ($match['levelKeys'] as $levelKey) {
        if (!empty($availableByLevel[$levelKey])) $weighted[$levelKey] = max(0, (int)($match['levelWeights'][$categoryId][$levelKey] ?? 0));
    }
    if (!$weighted) return null;
    if (array_sum($weighted) <= 0) foreach ($weighted as $key => $_) $weighted[$key] = 1;

    $unit = deterministic_unit($match['seed'],$ordinal,$playerId,$categoryId);
    $cursor = $unit * array_sum($weighted);
    $chosen = array_key_last($weighted);
    foreach ($weighted as $key => $weight) {
        if ($cursor < $weight) { $chosen = $key; break; }
        $cursor -= $weight;
    }
    return [
        'question'=>$availableByLevel[$chosen][0],
        'levelKey'=>$chosen,
        'unit'=>$unit,
        'effectiveWeights'=>$weighted,
        'ordinal'=>$ordinal,
        'reason'=>'weighted',
    ];
}

function can_undo(array $events): bool {
    foreach (array_reverse(active_events($events)) as $event) {
        if (in_array($event['type'] ?? '', ['RESULT_RECORDED','QUESTION_EXPOSED','MATCH_CLOSED','CENTER_REACHED'], true)) return true;
    }
    return false;
}

function undo_action(array &$runtime, array $match): void {
    $events = events_for($runtime, $match['matchId']);
    $derived = derive_state($match, $events);
    if (!empty($derived['currentDraw']) && empty($derived['currentDraw']['replacementForEventId'])) {
        throw new InvalidArgumentException('Resuelve la pregunta pendiente antes de deshacer.');
    }
    $active = active_events($events);
    $candidate = null;
    foreach (array_reverse($active) as $event) {
        if (in_array($event['type'] ?? '', ['RESULT_RECORDED','QUESTION_EXPOSED','MATCH_CLOSED','CENTER_REACHED'], true)) { $candidate = $event; break; }
    }
    if (!$candidate) throw new InvalidArgumentException('No hay nada que deshacer.');
    $targets = [];
    foreach ($active as $event) {
        if (($event['actionId'] ?? null) === ($candidate['actionId'] ?? null)
            && in_array($event['type'] ?? '', ['RESULT_RECORDED','QUESTION_EXPOSED','QUESTION_DRAWN','MATCH_CLOSED','CENTER_REACHED'], true)) {
            $targets[] = $event['eventId'];
        }
    }
    append_event($runtime, $match['matchId'], 'EVENT_REVERTED', ['targetEventIds'=>$targets, 'label'=>$candidate['type']]);
}

function stock_for(array $seed, array $runtime, array $match): array {
    $used = global_used_keys($seed, $runtime);
    $stock = [];
    foreach ($match['categoryIds'] as $categoryId) {
        foreach ($match['levelKeys'] as $levelKey) {
            $count = 0;
            foreach (question_bucket($seed, $match['bankId'], $categoryId, $levelKey) as $q) {
                if ($q['status'] === 'active' && !isset($used[$q['questionKey']])) $count++;
            }
            $stock[] = ['categoryId'=>$categoryId,'levelKey'=>$levelKey,'count'=>$count];
        }
    }
    return $stock;
}

function match_detail(array $seed, array $runtime, array $match): array {
    $events = events_for($runtime, $match['matchId']);
    $derived = derive_state($match, $events);
    $results = [];
    foreach (active_events($events) as $event) if (($event['type'] ?? '') === 'RESULT_RECORDED') $results[] = $event['payload'];

    $marker = [];
    $eligible = [];
    foreach ($match['playerIds'] as $playerId) {
        $playerResults = array_values(array_filter($results, static fn($r) => ($r['playerId'] ?? null) === $playerId));
        $owned = $derived['quesitosByPlayer'][$playerId] ?? [];
        $hasAll = player_has_all_quesitos($match, $owned);
        if ($hasAll) $eligible[] = $playerId;
        $marker[] = [
            'playerId'=>$playerId,
            'correct'=>count(array_filter($playerResults, static fn($r) => !empty($r['correct']))),
            'wrong'=>count(array_filter($playerResults, static fn($r) => empty($r['correct']))),
            'quesitos'=>array_keys($owned),
            'quesitoCount'=>count($owned),
            'requiredQuesitos'=>count($match['categoryIds']),
            'hasAllQuesitos'=>$hasAll,
            'atCenter'=>!empty($derived['centerReachedByPlayer'][$playerId]),
            'centerTurnReady'=>$derived['centerReadyPlayerId'] === $playerId,
        ];
    }
    $derived['centerEligiblePlayerIds'] = $eligible;

    return [
        'rulesVersion'=>TRIVIAL_RULES_VERSION,
        'match'=>$match,
        'state'=>$derived,
        'stock'=>stock_for($seed,$runtime,$match),
        'marker'=>$marker,
        'events'=>$events,
        'canUndo'=>can_undo($events),
        'canRedo'=>can_redo($events),
        'revision'=>$runtime['revision'],
    ];
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

    $bankMap = []; foreach ($seed['banks'] as $bank) $bankMap[$bank['bankId']] = $bank;
    if (!isset($bankMap[$bankId])) throw new InvalidArgumentException('Banco no válido.');
    $playerMap = []; foreach ($seed['players'] as $player) if ($player['active']) $playerMap[$player['playerId']] = $player;
    foreach ($playerIds as $id) if (!isset($playerMap[$id])) throw new InvalidArgumentException("Jugador no válido: $id");
    $categoryMap = []; foreach ($seed['categories'] as $category) if ($category['active'] && $category['bankId'] === $bankId) $categoryMap[$category['categoryId']] = $category;
    foreach ($categoryIds as $id) if (!isset($categoryMap[$id])) throw new InvalidArgumentException("Categoría no válida: $id");
    $levelMap = []; foreach ($seed['levels'] as $level) $levelMap[$level['levelKey']] = $level;
    foreach ($levelKeys as $id) if (!isset($levelMap[$id])) throw new InvalidArgumentException("Nivel no válido: $id");

    $used = global_used_keys($seed,$runtime);
    foreach ($categoryIds as $categoryId) {
        $count = 0;
        foreach ($levelKeys as $levelKey) {
            foreach (question_bucket($seed,$bankId,$categoryId,$levelKey) as $q) {
                if ($q['status'] === 'active' && !isset($used[$q['questionKey']])) $count++;
            }
        }
        if ($count === 0) throw new InvalidArgumentException("No queda stock compatible en $categoryId.");
    }

    $matchId = 'M' . gmdate('Ymd') . '-' . bin2hex(random_bytes(4));
    $name = trim((string)($payload['name'] ?? '')) ?: ('Partida ' . date('d/m/Y'));
    $match = [
        'matchId'=>$matchId,
        'name'=>$name,
        'bankId'=>$bankId,
        'playerIds'=>$playerIds,
        'categoryIds'=>$categoryIds,
        'levelKeys'=>$levelKeys,
        'startingPlayerId'=>$startingPlayerId,
        'seed'=>bin2hex(random_bytes(16)),
        'levelWeights'=>weights_for_match($seed,$bankId,$categoryIds,$levelKeys),
        'rulesVersion'=>TRIVIAL_RULES_VERSION,
        'contentSignature'=>$seed['signature'],
        'createdAt'=>gmdate('c'),
        'snapshot'=>[
            'players'=>array_map(static fn($id) => ['playerId'=>$id,'name'=>$playerMap[$id]['name']], $playerIds),
            'categories'=>array_map(static fn($id) => [
                'categoryId'=>$id,
                'label'=>$categoryMap[$id]['label'],
                'color'=>$categoryMap[$id]['color'],
                'colorCss'=>$categoryMap[$id]['colorCss'],
                'emoji'=>$categoryMap[$id]['emoji'],
            ], $categoryIds),
            'levels'=>array_map(static fn($id) => ['levelKey'=>$id,'label'=>$levelMap[$id]['label']], $levelKeys),
        ],
    ];

    $runtime['matches'][] = $match;
    append_event($runtime,$matchId,'MATCH_CREATED',[
        'matchId'=>$matchId,'bankId'=>$bankId,'playerIds'=>$playerIds,'categoryIds'=>$categoryIds,
        'levelKeys'=>$levelKeys,'startingPlayerId'=>$startingPlayerId,'seed'=>$match['seed'],
        'levelWeights'=>$match['levelWeights'],'rulesVersion'=>TRIVIAL_RULES_VERSION,
    ]);
    $runtime['revision'] = ((int)$runtime['revision']) + 1;
    return match_detail($seed,$runtime,$match);
}

function perform_action(array &$runtime, string $matchId, array $payload): array {
    $seed = load_seed();
    $match = find_match($runtime,$matchId);
    $events = events_for($runtime,$matchId);
    $derived = derive_state($match,$events);
    $action = (string)($payload['action'] ?? '');

    if ($derived['status'] === 'closed' && !in_array($action,['undo','redo'],true)) throw new InvalidArgumentException('La partida está cerrada.');

    if ($action === 'draw') {
        if ($derived['currentDraw']) throw new InvalidArgumentException('Ya hay una pregunta pendiente.');
        $centerAttempt = !empty($payload['centerAttempt']);
        if ($derived['centerReadyPlayerId'] !== null && !$centerAttempt) {
            throw new InvalidArgumentException('El jugador está en el centro: los demás jugadores deben elegir la categoría de la pregunta final.');
        }
        if ($derived['centerReadyPlayerId'] === null && $centerAttempt) {
            throw new InvalidArgumentException('El jugador no está en el centro.');
        }
        $categoryId = (string)($payload['categoryId'] ?? '');
        if (!in_array($categoryId,$match['categoryIds'],true)) throw new InvalidArgumentException('Categoría no válida.');
        $selected = select_question($seed,$runtime,$match,$categoryId);
        if (!$selected) throw new InvalidArgumentException('No queda stock para esa categoría.');
        $q = $selected['question'];
        append_event($runtime,$matchId,'QUESTION_DRAWN',[
            'drawOrdinal'=>$selected['ordinal'],'randomUnit'=>$selected['unit'],'effectiveWeights'=>$selected['effectiveWeights'],
            'playerId'=>$derived['currentPlayerId'],'categoryId'=>$categoryId,'levelKey'=>$selected['levelKey'],
            'questionKey'=>$q['questionKey'],'quesitoAttempt'=>$centerAttempt ? false : !empty($payload['quesitoAttempt']),
            'centerAttempt'=>$centerAttempt,'selectionReason'=>$selected['reason'],'prompt'=>$q['prompt'],
            'answer'=>$q['answer'],'explanation'=>$q['explanation'],
        ]);
    } elseif ($action === 'center_reached') {
        if ($derived['currentDraw']) throw new InvalidArgumentException('Resuelve o descarta la pregunta pendiente antes de entrar al centro.');
        $playerId = (string)$derived['currentPlayerId'];
        if (!empty($derived['centerReachedByPlayer'][$playerId])) throw new InvalidArgumentException('El jugador ya está en el centro.');
        $owned = $derived['quesitosByPlayer'][$playerId] ?? [];
        if (!player_has_all_quesitos($match,$owned)) throw new InvalidArgumentException('El jugador todavía no tiene todos los quesitos de esta partida.');
        append_event($runtime,$matchId,'CENTER_REACHED',['playerId'=>$playerId]);
    } elseif ($action === 'reveal') {
        if (!$derived['currentDraw']) throw new InvalidArgumentException('No hay pregunta pendiente.');
        if (!$derived['answerRevealed']) append_event($runtime,$matchId,'ANSWER_REVEALED',[
            'drawEventId'=>$derived['currentDraw']['eventId'],'questionKey'=>$derived['currentDraw']['questionKey'],
        ]);
    } elseif ($action === 'result') {
        $draw = $derived['currentDraw'];
        if (!$draw || !$derived['answerRevealed']) throw new InvalidArgumentException('Muestra primero la respuesta.');
        if (!array_key_exists('correct',$payload) || !is_bool($payload['correct'])) throw new InvalidArgumentException('Resultado inválido.');
        $correct = $payload['correct'];
        $playerId = $draw['playerId'];
        $owned = $derived['quesitosByPlayer'][$playerId] ?? [];
        $centerAttempt = !empty($draw['centerAttempt']);
        $quesitoWon = !$centerAttempt && $correct && !empty($draw['quesitoAttempt']) && empty($owned[$draw['categoryId']]);
        $actionId = 'A-' . bin2hex(random_bytes(8));
        append_event($runtime,$matchId,'RESULT_RECORDED',[
            'drawEventId'=>$draw['eventId'],'questionKey'=>$draw['questionKey'],'playerId'=>$playerId,
            'categoryId'=>$draw['categoryId'],'levelKey'=>$draw['levelKey'],'correct'=>$correct,
            'quesitoAttempt'=>!empty($draw['quesitoAttempt']),'quesitoWon'=>$quesitoWon,'centerAttempt'=>$centerAttempt,
        ],$actionId);
        if ($centerAttempt && $correct) append_event($runtime,$matchId,'MATCH_CLOSED',[
            'reason'=>'victoria_centro','winners'=>[$playerId],
        ],$actionId);
    } elseif ($action === 'discard') {
        $draw = $derived['currentDraw'];
        if (!$draw) throw new InvalidArgumentException('No hay pregunta pendiente.');
        $actionId = 'A-' . bin2hex(random_bytes(8));
        append_event($runtime,$matchId,'QUESTION_EXPOSED',[
            'drawEventId'=>$draw['eventId'],'questionKey'=>$draw['questionKey'],'playerId'=>$draw['playerId'],
            'categoryId'=>$draw['categoryId'],'levelKey'=>$draw['levelKey'],'quesitoAttempt'=>!empty($draw['quesitoAttempt']),
            'centerAttempt'=>!empty($draw['centerAttempt']),'reason'=>(string)($payload['reason'] ?? 'otro'),
            'note'=>substr(trim((string)($payload['note'] ?? '')),0,500),
        ],$actionId);
        $selected = select_question($seed,$runtime,$match,$draw['categoryId'],$draw['levelKey']);
        if ($selected) {
            $q = $selected['question'];
            append_event($runtime,$matchId,'QUESTION_DRAWN',[
                'drawOrdinal'=>$selected['ordinal'],'randomUnit'=>$selected['unit'],'effectiveWeights'=>$selected['effectiveWeights'],
                'playerId'=>$draw['playerId'],'categoryId'=>$draw['categoryId'],'levelKey'=>$selected['levelKey'],
                'questionKey'=>$q['questionKey'],'quesitoAttempt'=>!empty($draw['quesitoAttempt']),
                'centerAttempt'=>!empty($draw['centerAttempt']),'replacementForEventId'=>$draw['eventId'],
                'selectionReason'=>$selected['reason'],'prompt'=>$q['prompt'],'answer'=>$q['answer'],'explanation'=>$q['explanation'],
            ],$actionId);
        }
    } elseif ($action === 'undo') {
        undo_action($runtime,$match);
    } elseif ($action === 'redo') {
        redo_action($runtime,$match);
    } elseif ($action === 'close') {
        if ($derived['currentDraw']) throw new InvalidArgumentException('Resuelve o descarta la pregunta pendiente.');
        append_event($runtime,$matchId,'MATCH_CLOSED',['reason'=>'manual','winners'=>[]]);
    } else {
        throw new InvalidArgumentException('Acción desconocida.');
    }

    $runtime['revision'] = ((int)$runtime['revision']) + 1;
    return match_detail($seed,$runtime,find_match($runtime,$matchId));
}

function compute_stats(array $seed, array $runtime): array {
    $rows = [];
    foreach ($seed['attempts'] as $a) {
        if ($a['active'] && $a['computable'] && $a['correct'] !== null) $rows[] = [
            'matchId'=>$a['matchId'],'playerId'=>$a['playerId'],'categoryId'=>$a['categoryId'],'levelKey'=>$a['levelKey'],
            'correct'=>$a['correct'],'quesitoAttempt'=>$a['quesitoAttempt'],'quesitoWon'=>$a['quesitoWon'],
        ];
    }
    foreach ($runtime['matches'] as $match) {
        foreach (active_events(events_for($runtime,$match['matchId'])) as $event) {
            if (($event['type'] ?? '') === 'RESULT_RECORDED') $rows[] = array_merge(['matchId'=>$match['matchId']],$event['payload']);
        }
    }
    $aggregate = static function(callable $keyFn) use ($rows): array {
        $map = [];
        foreach ($rows as $r) {
            $key = (string)$keyFn($r);
            if (!isset($map[$key])) $map[$key] = ['key'=>$key,'attempts'=>0,'correct'=>0,'wrong'=>0,'quesitoAttempts'=>0,'quesitosWon'=>0];
            $map[$key]['attempts']++;
            $map[$key]['correct'] += $r['correct'] ? 1 : 0;
            $map[$key]['wrong'] += $r['correct'] ? 0 : 1;
            $map[$key]['quesitoAttempts'] += !empty($r['quesitoAttempt']) ? 1 : 0;
            $map[$key]['quesitosWon'] += !empty($r['quesitoWon']) ? 1 : 0;
        }
        foreach ($map as &$x) $x['accuracy'] = $x['attempts'] ? $x['correct'] / $x['attempts'] : 0;
        unset($x);
        return array_values($map);
    };
    return [
        'rows'=>$rows,
        'byPlayer'=>$aggregate(static fn($r) => $r['playerId']),
        'byPlayerCategory'=>$aggregate(static fn($r) => ($r['playerId'] ?? '') . '|' . ($r['categoryId'] ?? '')),
        'byPlayerLevel'=>$aggregate(static fn($r) => ($r['playerId'] ?? '') . '|' . ($r['levelKey'] ?? '')),
    ];
}

function bootstrap_payload(array $seed, array $runtime): array {
    $used = global_used_keys($seed,$runtime);
    $stock = [];
    foreach ($seed['categories'] as $category) {
        if (!$category['active']) continue;
        foreach ($seed['levels'] as $level) {
            $count = 0;
            foreach (question_bucket($seed,$category['bankId'],$category['categoryId'],$level['levelKey']) as $q) {
                if ($q['status'] === 'active' && !isset($used[$q['questionKey']])) $count++;
            }
            $stock[] = ['bankId'=>$category['bankId'],'categoryId'=>$category['categoryId'],'levelKey'=>$level['levelKey'],'count'=>$count];
        }
    }
    $matches = [];
    foreach (array_reverse($runtime['matches']) as $match) {
        $state = derive_state($match,events_for($runtime,$match['matchId']));
        $matches[] = [
            'matchId'=>$match['matchId'],'name'=>$match['name'],'playerIds'=>$match['playerIds'],
            'startingPlayerId'=>$match['startingPlayerId'],'status'=>$state['status'],'createdAt'=>$match['createdAt'],
            'rulesVersion'=>$match['rulesVersion'] ?? null,
        ];
    }
    return [
        'rulesVersion'=>TRIVIAL_RULES_VERSION,
        'seedVersion'=>$seed['meta']['seed_version'] ?? null,
        'contentSignature'=>$seed['signature'],
        'banks'=>$seed['banks'],'categories'=>$seed['categories'],'levels'=>$seed['levels'],'players'=>$seed['players'],
        'matches'=>$matches,
        'base'=>[
            'questionCount'=>count($seed['questions']),
            'availableQuestionCount'=>count(array_filter($seed['questions'], static fn($q) => $q['status'] === 'active' && !isset($used[$q['questionKey']]))),
            'usedQuestionCount'=>count($used),
            'stock'=>$stock,
        ],
        'revision'=>$runtime['revision'],
    ];
}

function diagnostics_payload(array $seed, array $runtime): array {
    return [
        'ok'=>true,
        'rulesVersion'=>TRIVIAL_RULES_VERSION,
        'content'=>content_diagnostics($seed),
        'runtime'=>[
            'schemaVersion'=>$runtime['schemaVersion'] ?? null,
            'revision'=>$runtime['revision'] ?? 0,
            'matches'=>count($runtime['matches'] ?? []),
            'events'=>count($runtime['events'] ?? []),
            'updatedAt'=>$runtime['updatedAt'] ?? null,
        ],
    ];
}
