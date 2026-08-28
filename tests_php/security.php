<?php
declare(strict_types=1);
$router=file_get_contents(__DIR__.'/../router.php');
if($router===false)exit(1);
if(strpos($router,'return false')!==false){fwrite(STDERR,"FAIL: router delega ficheros arbitrarios\n");exit(1);}
foreach(["'/src/bootstrap.js'","'/src/app.js'","'/styles.css'","'/icons/trivial.svg'"] as $allowed){
    if(strpos($router,$allowed)===false){fwrite(STDERR,"FAIL: falta allowlist pública: $allowed\n");exit(1);}
}
if(strpos($router,"$_GET['path']")===false && strpos($router,"$_GET[\"path\"]")===false){
    fwrite(STDERR,"FAIL: falta routing API sin rewrite\n");exit(1);
}
echo "ok - static files are allowlisted; internal files are not exposed; API supports direct router.php calls\n";
