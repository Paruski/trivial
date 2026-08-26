<?php
declare(strict_types=1);
require __DIR__ . '/../lib/v2.php';

function ok_v2(bool $condition, string $message): void {
    if (!$condition) { fwrite(STDERR, "FAIL: $message\n"); exit(1); }
    echo "ok - $message\n";
}

$seed = load_seed();
$bankId = $seed['banks'][0]['bankId'];
$levelKeys = array_column($seed['levels'],'levelKey');
$categoryId = $seed['categories'][0]['categoryId'];

// Acierto conserva turno; fallo rota.
$runtime = empty_state();
$detail = create_match_v2($runtime,[
    'name'=>'Turnos v2',
    'bankId'=>$bankId,
    'playerIds'=>['J1','J3'],
    'startingPlayerId'=>'J3',
    'categoryIds'=>[$categoryId],
    'levelKeys'=>$levelKeys,
]);
$matchId = $detail['match']['matchId'];
$detail = perform_action_v2($runtime,$matchId,['action'=>'draw','categoryId'=>$categoryId,'quesitoAttempt'=>false]);
$detail = perform_action_v2($runtime,$matchId,['action'=>'reveal']);
$detail = perform_action_v2($runtime,$matchId,['action'=>'result','correct'=>true]);
ok_v2($detail['state']['currentPlayerId']==='J3','correct answer keeps the turn');
$detail = perform_action_v2($runtime,$matchId,['action'=>'draw','categoryId'=>$categoryId,'quesitoAttempt'=>false]);
$detail = perform_action_v2($runtime,$matchId,['action'=>'reveal']);
$detail = perform_action_v2($runtime,$matchId,['action'=>'result','correct'=>false]);
ok_v2($detail['state']['currentPlayerId']==='J1','wrong answer rotates the turn');

// Tener todos los quesitos no cierra: hay que llegar al centro y acertar allí.
$runtime2 = empty_state();
$detail2 = create_match_v2($runtime2,[
    'name'=>'Centro v2',
    'bankId'=>$bankId,
    'playerIds'=>['J1','J2'],
    'startingPlayerId'=>'J1',
    'categoryIds'=>[$categoryId],
    'levelKeys'=>$levelKeys,
]);
$matchId2 = $detail2['match']['matchId'];
$detail2 = perform_action_v2($runtime2,$matchId2,['action'=>'draw','categoryId'=>$categoryId,'quesitoAttempt'=>true]);
$detail2 = perform_action_v2($runtime2,$matchId2,['action'=>'reveal']);
$detail2 = perform_action_v2($runtime2,$matchId2,['action'=>'result','correct'=>true]);
ok_v2($detail2['state']['status']==='open','all configured quesitos do not close the match');
ok_v2($detail2['marker'][0]['hasAllQuesitos']===true,'marker reports all quesitos obtained');
ok_v2($detail2['state']['currentPlayerId']==='J1','quesito answer also keeps the turn when correct');
$detail2 = perform_action_v2($runtime2,$matchId2,['action'=>'center_reached']);
ok_v2($detail2['state']['centerReadyPlayerId']==='J1','reaching center is a separate persisted state');
$detail2 = perform_action_v2($runtime2,$matchId2,['action'=>'draw','categoryId'=>$categoryId,'centerAttempt'=>true]);
ok_v2(!empty($detail2['state']['currentDraw']['centerAttempt']),'center question is explicitly marked');
$detail2 = perform_action_v2($runtime2,$matchId2,['action'=>'reveal']);
$detail2 = perform_action_v2($runtime2,$matchId2,['action'=>'result','correct'=>true]);
ok_v2($detail2['state']['status']==='closed','correct center answer closes the match');
ok_v2(($detail2['state']['close']['reason']??null)==='victoria_centro','center victory has its own close reason');

// En una partida estándar con seis categorías, el marcador exige seis quesitos.
$allCategoryIds = array_values(array_unique(array_column(array_filter($seed['categories'],fn($c)=>$c['active']&&$c['bankId']===$bankId),'categoryId')));
if (count($allCategoryIds) >= 6) {
    $runtime3 = empty_state();
    $detail3 = create_match_v2($runtime3,[
        'name'=>'Seis quesitos',
        'bankId'=>$bankId,
        'playerIds'=>['J1'],
        'startingPlayerId'=>'J1',
        'categoryIds'=>array_slice($allCategoryIds,0,6),
        'levelKeys'=>$levelKeys,
    ]);
    ok_v2($detail3['marker'][0]['requiredQuesitos']===6,'standard six-category match requires six quesitos');
}

echo "All v2 PHP tests passed.\n";
