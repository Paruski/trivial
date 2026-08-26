<?php
declare(strict_types=1);
require_once __DIR__ . '/trivial.php';

function player_has_all_quesitos_v2(array $match, array $owned): bool {
    if (empty($match['categoryIds'])) return false;
    foreach ($match['categoryIds'] as $categoryId) {
        if (empty($owned[$categoryId])) return false;
    }
    return true;
}

function derive_state_v2(array $match, array $events): array {
    $state = [
        'status'=>'open',
        'currentPlayerId'=>$match['startingPlayerId'],
        'currentDraw'=>null,
        'answerRevealed'=>false,
        'close'=>null,
        'quesitosByPlayer'=>[],
        'centerReadyPlayerId'=>null,
    ];

    foreach (active_events($events) as $event) {
        $p = $event['payload'] ?? [];
        switch ($event['type']) {
            case 'QUESTION_DRAWN':
                $state['currentPlayerId'] = $p['playerId'];
                $state['currentDraw'] = array_merge(['eventId'=>$event['eventId']], $p);
                $state['answerRevealed'] = false;
                break;

            case 'ANSWER_REVEALED':
                if (($state['currentDraw']['eventId'] ?? null) === ($p['drawEventId'] ?? null)) {
                    $state['answerRevealed'] = true;
                }
                break;

            case 'CENTER_REACHED':
                $state['currentPlayerId'] = $p['playerId'];
                $state['centerReadyPlayerId'] = $p['playerId'];
                break;

            case 'RESULT_RECORDED':
                if (!empty($p['quesitoWon'])) {
                    $state['quesitosByPlayer'][$p['playerId']][$p['categoryId']] = true;
                }
                if (($state['currentDraw']['eventId'] ?? null) === ($p['drawEventId'] ?? null)) {
                    $turn = $state['currentDraw']['playerId'];
                    $centerAttempt = !empty($state['currentDraw']['centerAttempt']) || !empty($p['centerAttempt']);
                    $correct = !empty($p['correct']);
                    $state['currentDraw'] = null;
                    $state['answerRevealed'] = false;

                    if ($centerAttempt) {
                        if ($correct) {
                            $state['currentPlayerId'] = $turn;
                            $state['centerReadyPlayerId'] = $turn;
                        } else {
                            $state['currentPlayerId'] = next_player($match, $turn);
                            $state['centerReadyPlayerId'] = null;
                        }
                    } else {
                        $state['currentPlayerId'] = $correct ? $turn : next_player($match, $turn);
                    }
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

function select_question_v2(array $seed, array $runtime, array $match, string $categoryId, ?string $preferredLevel = null): ?array {
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
    foreach ($byLevel as &$questions) {
        usort($questions, fn($a,$b) => ($a['randomOrder'] <=> $b['randomOrder']) ?: strcmp($a['questionKey'],$b['questionKey']));
    }
    unset($questions);

    $derived = derive_state_v2($match, $events);
    $playerId = (string)$derived['currentPlayerId'];

    if ($preferredLevel !== null && !empty($byLevel[$preferredLevel])) {
        return [
            'question'=>$byLevel[$preferredLevel][0],
            'levelKey'=>$preferredLevel,
            'unit'=>deterministic_unit($match['seed'],$ordinal,$playerId,$categoryId),
            'effectiveWeights'=>[$preferredLevel=>1],
            'ordinal'=>$ordinal,
            'reason'=>'same_level_replacement',
        ];
    }

    $weighted = [];
    foreach ($match['levelKeys'] as $levelKey) {
        if (!empty($byLevel[$levelKey])) {
            $weighted[$levelKey] = max(0, (int)($match['levelWeights'][$categoryId][$levelKey] ?? 0));
        }
    }
    if (!$weighted) return null;
    if (array_sum($weighted) <= 0) foreach ($weighted as $key => $_) $weighted[$key] = 1;

    $unit = deterministic_unit($match['seed'],$ordinal,$playerId,$categoryId);
    $cursor = $unit * array_sum($weighted);
    $chosen = array_key_last($weighted);
    foreach ($weighted as $key=>$weight) {
        if ($cursor < $weight) { $chosen = $key; break; }
        $cursor -= $weight;
    }

    return [
        'question'=>$byLevel[$chosen][0],
        'levelKey'=>$chosen,
        'unit'=>$unit,
        'effectiveWeights'=>$weighted,
        'ordinal'=>$ordinal,
        'reason'=>'weighted',
    ];
}

function can_undo_v2(array $events): bool {
    foreach (array_reverse(active_events($events)) as $event) {
        if (in_array($event['type'], ['RESULT_RECORDED','QUESTION_EXPOSED','MATCH_CLOSED','CENTER_REACHED'], true)) return true;
    }
    return false;
}

function undo_action_v2(array &$runtime, array $match): void {
    $events = events_for($runtime, $match['matchId']);
    $derived = derive_state_v2($match, $events);
    if (!empty($derived['currentDraw']) && empty($derived['currentDraw']['replacementForEventId'])) {
        throw new InvalidArgumentException('Resuelve la pregunta pendiente antes de deshacer.');
    }

    $active = active_events($events);
    $candidate = null;
    foreach (array_reverse($active) as $event) {
        if (in_array($event['type'], ['RESULT_RECORDED','QUESTION_EXPOSED','MATCH_CLOSED','CENTER_REACHED'], true)) {
            $candidate = $event;
            break;
        }
    }
    if (!$candidate) throw new InvalidArgumentException('No hay nada que deshacer.');

    $targets = [];
    foreach ($active as $event) {
        if ($event['actionId'] === $candidate['actionId'] && in_array($event['type'], ['RESULT_RECORDED','QUESTION_EXPOSED','QUESTION_DRAWN','MATCH_CLOSED','CENTER_REACHED'], true)) {
            $targets[] = $event['eventId'];
        }
    }
    append_event($runtime, $match['matchId'], 'EVENT_REVERTED', ['targetEventIds'=>$targets, 'label'=>$candidate['type']]);
}

function match_detail_v2(array $seed, array $runtime, array $match): array {
    $events = events_for($runtime, $match['matchId']);
    $derived = derive_state_v2($match, $events);
    $used = global_used_keys($seed, $runtime);

    $stock = [];
    foreach ($match['categoryIds'] as $categoryId) foreach ($match['levelKeys'] as $levelKey) {
        $count = 0;
        foreach ($seed['questions'] as $q) {
            if ($q['bankId'] === $match['bankId'] && $q['categoryId'] === $categoryId && $q['levelKey'] === $levelKey && $q['status'] === 'active' && !isset($used[$q['questionKey']])) $count++;
        }
        $stock[] = ['categoryId'=>$categoryId,'levelKey'=>$levelKey,'count'=>$count];
    }

    $results = [];
    foreach (active_events($events) as $event) if ($event['type'] === 'RESULT_RECORDED') $results[] = $event['payload'];

    $marker = [];
    $eligible = [];
    foreach ($match['playerIds'] as $playerId) {
        $playerResults = array_values(array_filter($results, fn($r)=>$r['playerId']===$playerId));
        $owned = $derived['quesitosByPlayer'][$playerId] ?? [];
        $hasAll = player_has_all_quesitos_v2($match, $owned);
        if ($hasAll) $eligible[] = $playerId;
        $marker[] = [
            'playerId'=>$playerId,
            'correct'=>count(array_filter($playerResults, fn($r)=>!empty($r['correct']))),
            'wrong'=>count(array_filter($playerResults, fn($r)=>empty($r['correct']))),
            'quesitos'=>array_keys($owned),
            'quesitoCount'=>count($owned),
            'requiredQuesitos'=>count($match['categoryIds']),
            'hasAllQuesitos'=>$hasAll,
            'atCenter'=>$derived['centerReadyPlayerId'] === $playerId,
        ];
    }
    $derived['centerEligiblePlayerIds'] = $eligible;

    return [
        'rulesVersion'=>'server-auto-v2',
        'match'=>$match,
        'state'=>$derived,
        'stock'=>$stock,
        'marker'=>$marker,
        'events'=>$events,
        'canUndo'=>can_undo_v2($events),
        'canRedo'=>can_redo($events),
        'revision'=>$runtime['revision'],
    ];
}

function create_match_v2(array &$runtime, array $payload): array {
    $legacy = create_match($runtime, $payload);
    $match = find_match($runtime, $legacy['match']['matchId']);
    return match_detail_v2(load_seed(), $runtime, $match);
}

function perform_action_v2(array &$runtime, string $matchId, array $payload): array {
    $seed = load_seed();
    $match = find_match($runtime,$matchId);
    $events = events_for($runtime,$matchId);
    $derived = derive_state_v2($match,$events);
    $action = (string)($payload['action'] ?? '');

    if ($derived['status']==='closed' && !in_array($action,['undo','redo'],true)) {
        throw new InvalidArgumentException('La partida está cerrada.');
    }

    if ($action === 'draw') {
        if ($derived['currentDraw']) throw new InvalidArgumentException('Ya hay una pregunta pendiente.');
        $centerAttempt = !empty($payload['centerAttempt']);
        if ($derived['centerReadyPlayerId'] !== null) {
            if ($derived['centerReadyPlayerId'] !== $derived['currentPlayerId']) throw new RuntimeException('Estado de centro incoherente.');
            if (!$centerAttempt) throw new InvalidArgumentException('El jugador está en el centro: los demás jugadores deben elegir la categoría de la pregunta final.');
        } elseif ($centerAttempt) {
            throw new InvalidArgumentException('Marca primero que el jugador ha llegado al centro.');
        }

        $categoryId=(string)($payload['categoryId']??'');
        if(!in_array($categoryId,$match['categoryIds'],true)) throw new InvalidArgumentException('Categoría no válida.');
        $selected=select_question_v2($seed,$runtime,$match,$categoryId);
        if(!$selected) throw new InvalidArgumentException('No queda stock para esa categoría.');
        $q=$selected['question'];
        append_event($runtime,$matchId,'QUESTION_DRAWN',[
            'drawOrdinal'=>$selected['ordinal'],
            'randomUnit'=>$selected['unit'],
            'effectiveWeights'=>$selected['effectiveWeights'],
            'playerId'=>$derived['currentPlayerId'],
            'categoryId'=>$categoryId,
            'levelKey'=>$selected['levelKey'],
            'questionKey'=>$q['questionKey'],
            'quesitoAttempt'=>$centerAttempt ? false : !empty($payload['quesitoAttempt']),
            'centerAttempt'=>$centerAttempt,
            'selectionReason'=>$selected['reason'],
            'prompt'=>$q['prompt'],
            'answer'=>$q['answer'],
            'explanation'=>$q['explanation'],
        ]);

    } elseif ($action === 'center_reached') {
        if ($derived['currentDraw']) throw new InvalidArgumentException('Resuelve o descarta la pregunta pendiente antes de entrar al centro.');
        if ($derived['centerReadyPlayerId'] !== null) throw new InvalidArgumentException('El jugador ya está marcado en el centro.');
        $playerId = (string)$derived['currentPlayerId'];
        $owned = $derived['quesitosByPlayer'][$playerId] ?? [];
        if (!player_has_all_quesitos_v2($match, $owned)) {
            throw new InvalidArgumentException('El jugador todavía no tiene todos los quesitos de esta partida.');
        }
        append_event($runtime,$matchId,'CENTER_REACHED',['playerId'=>$playerId]);

    } elseif ($action === 'reveal') {
        if(!$derived['currentDraw']) throw new InvalidArgumentException('No hay pregunta pendiente.');
        if(!$derived['answerRevealed']) {
            append_event($runtime,$matchId,'ANSWER_REVEALED',[
                'drawEventId'=>$derived['currentDraw']['eventId'],
                'questionKey'=>$derived['currentDraw']['questionKey'],
            ]);
        }

    } elseif ($action === 'result') {
        $draw=$derived['currentDraw'];
        if(!$draw || !$derived['answerRevealed']) throw new InvalidArgumentException('Muestra primero la respuesta.');
        if(!array_key_exists('correct',$payload) || !is_bool($payload['correct'])) throw new InvalidArgumentException('Resultado inválido.');

        $correct=$payload['correct'];
        $playerId=$draw['playerId'];
        $owned=$derived['quesitosByPlayer'][$playerId]??[];
        $centerAttempt=!empty($draw['centerAttempt']);
        $quesitoWon=!$centerAttempt && $correct && !empty($draw['quesitoAttempt']) && empty($owned[$draw['categoryId']]);
        $actionId='A-'.bin2hex(random_bytes(8));

        append_event($runtime,$matchId,'RESULT_RECORDED',[
            'drawEventId'=>$draw['eventId'],
            'questionKey'=>$draw['questionKey'],
            'playerId'=>$playerId,
            'categoryId'=>$draw['categoryId'],
            'levelKey'=>$draw['levelKey'],
            'correct'=>$correct,
            'quesitoAttempt'=>!empty($draw['quesitoAttempt']),
            'quesitoWon'=>$quesitoWon,
            'centerAttempt'=>$centerAttempt,
        ],$actionId);

        if($centerAttempt && $correct) {
            append_event($runtime,$matchId,'MATCH_CLOSED',[
                'reason'=>'victoria_centro',
                'winners'=>[$playerId],
            ],$actionId);
        }

    } elseif ($action === 'discard') {
        $draw=$derived['currentDraw'];
        if(!$draw) throw new InvalidArgumentException('No hay pregunta pendiente.');
        $actionId='A-'.bin2hex(random_bytes(8));
        append_event($runtime,$matchId,'QUESTION_EXPOSED',[
            'drawEventId'=>$draw['eventId'],
            'questionKey'=>$draw['questionKey'],
            'playerId'=>$draw['playerId'],
            'categoryId'=>$draw['categoryId'],
            'levelKey'=>$draw['levelKey'],
            'quesitoAttempt'=>!empty($draw['quesitoAttempt']),
            'centerAttempt'=>!empty($draw['centerAttempt']),
            'reason'=>(string)($payload['reason']??'otro'),
            'note'=>substr(trim((string)($payload['note']??'')),0,500),
        ],$actionId);

        $selected=select_question_v2($seed,$runtime,$match,$draw['categoryId'],$draw['levelKey']);
        if($selected){
            $q=$selected['question'];
            append_event($runtime,$matchId,'QUESTION_DRAWN',[
                'drawOrdinal'=>$selected['ordinal'],
                'randomUnit'=>$selected['unit'],
                'effectiveWeights'=>$selected['effectiveWeights'],
                'playerId'=>$draw['playerId'],
                'categoryId'=>$draw['categoryId'],
                'levelKey'=>$selected['levelKey'],
                'questionKey'=>$q['questionKey'],
                'quesitoAttempt'=>!empty($draw['quesitoAttempt']),
                'centerAttempt'=>!empty($draw['centerAttempt']),
                'replacementForEventId'=>$draw['eventId'],
                'selectionReason'=>$selected['reason'],
                'prompt'=>$q['prompt'],
                'answer'=>$q['answer'],
                'explanation'=>$q['explanation'],
            ],$actionId);
        }

    } elseif ($action === 'undo') {
        undo_action_v2($runtime,$match);

    } elseif ($action === 'redo') {
        redo_action($runtime,$match);

    } elseif ($action === 'close') {
        if($derived['currentDraw']) throw new InvalidArgumentException('Resuelve o descarta la pregunta pendiente.');
        append_event($runtime,$matchId,'MATCH_CLOSED',['reason'=>'manual','winners'=>[]]);

    } else {
        throw new InvalidArgumentException('Acción desconocida.');
    }

    $runtime['revision']=((int)$runtime['revision'])+1;
    $match=find_match($runtime,$matchId);
    return match_detail_v2($seed,$runtime,$match);
}
