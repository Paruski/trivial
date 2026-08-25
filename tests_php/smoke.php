<?php
declare(strict_types=1);
require __DIR__ . '/../lib/trivial.php';

function ok(bool $condition, string $message): void {
    if (!$condition) { fwrite(STDERR, "FAIL: $message\n"); exit(1); }
    echo "ok - $message\n";
}

$seed = load_seed();
ok(count($seed['players']) >= 3, 'players loaded');
ok(count($seed['questions']) >= 100, 'question bank loaded');
$runtime = empty_state();
$payload = [
    'name'=>'Smoke',
    'bankId'=>$seed['banks'][0]['bankId'],
    'playerIds'=>['J1','J3'],
    'startingPlayerId'=>'J3',
    'categoryIds'=>[$seed['categories'][0]['categoryId']],
    'levelKeys'=>array_column($seed['levels'],'levelKey'),
];
$detail = create_match($runtime,$payload);
ok($detail['state']['currentPlayerId']==='J3','starting player is respected');
$categoryId=$detail['match']['categoryIds'][0];
$first=select_question($seed,$runtime,$detail['match'],$categoryId);
ok($first!==null,'selector returns a question');
$again=select_question($seed,$runtime,$detail['match'],$categoryId);
ok($first['question']['questionKey']===$again['question']['questionKey'] && $first['levelKey']===$again['levelKey'],'selector is deterministic');
$detail=perform_action($runtime,$detail['match']['matchId'],['action'=>'draw','categoryId'=>$categoryId,'quesitoAttempt'=>false]);
$key=$detail['state']['currentDraw']['questionKey'];
ok(isset(global_used_keys($seed,$runtime)[$key]),'shown question is globally excluded');
$detail=perform_action($runtime,$detail['match']['matchId'],['action'=>'reveal']);
$detail=perform_action($runtime,$detail['match']['matchId'],['action'=>'result','correct'=>false]);
ok($detail['state']['currentPlayerId']==='J1','turn rotates after result');
$stats=compute_stats($seed,$runtime);
ok(count($stats['rows'])>0,'statistics merge historical and server results');
echo "All PHP smoke tests passed.\n";
