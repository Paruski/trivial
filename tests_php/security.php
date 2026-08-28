<?php
declare(strict_types=1);
$router=file_get_contents(__DIR__.'/../router.php');if($router===false)exit(1);if(strpos($router,'return false')!==false){fwrite(STDERR,"FAIL: router delega ficheros arbitrarios\n");exit(1);}if(strpos($router,"'/src/app.js'")===false||strpos($router,"'/styles.css'")===false||strpos($router,"'/icons/trivial.svg'")===false){fwrite(STDERR,"FAIL: falta allowlist pública\n");exit(1);}echo "ok - static files are allowlisted; internal files are not exposed\n";
