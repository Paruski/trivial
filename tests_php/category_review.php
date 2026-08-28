<?php
declare(strict_types=1);
require __DIR__ . '/../lib/content.php';

function cnorm(string $s): string {
    $s = mb_strtolower($s, 'UTF-8');
    return strtr($s, ['á'=>'a','é'=>'e','í'=>'i','ó'=>'o','ú'=>'u','ü'=>'u']);
}
$rules = [
    'AL' => ['target'=>'LI','terms'=>['morfem','fonem','sintaxis','fonologia','fonetica','lexicograf','sociolingu','pragmatica','hiperonim','hiponim']],
    'LI' => ['target'=>'AL','terms'=>['pintor','escultor','arquitecto','novelista','quien escribio','poeta']],
    'FI' => ['target'=>'NE','terms'=>['hipocamp','amigdala','corteza prefrontal','sinaps','neurona','neurotransmis','memoria de trabajo','dopamina','serotonina','psicolog','cognit']],
    'NE' => ['target'=>'FI','terms'=>['fotosintesis','mitocondri','placas tectonicas','tectonica de placas','tabla periodica','numero atomico','enlace covalente','ecosistema','seleccion natural']],
];
$seed = load_seed();
foreach ($seed['questions'] as $q) {
    if (($q['status'] ?? '') !== 'active') continue;
    $cat = $q['categoryId'];
    if (!isset($rules[$cat])) continue;
    $text = cnorm((string)$q['prompt']);
    foreach ($rules[$cat]['terms'] as $term) {
        if (str_contains($text, $term)) {
            echo $q['questionKey'], "\t", $cat, "->", $rules[$cat]['target'], "\t", $q['prompt'], "\n";
            break;
        }
    }
}
