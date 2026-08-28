<?php
declare(strict_types=1);
require __DIR__ . '/lib/game.php';

function json_response(mixed $payload, int $status = 200): never {
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE|JSON_UNESCAPED_SLASHES|JSON_THROW_ON_ERROR);
    exit;
}

function json_error(Throwable $error, int $status = 400): never {
    json_response(['error'=>['message'=>$error->getMessage(),'type'=>get_class($error)]], $status);
}

function request_json(): array {
    $raw = file_get_contents('php://input');
    if ($raw === false || trim($raw) === '') return [];
    $decoded = json_decode($raw, true);
    if (!is_array($decoded)) throw new InvalidArgumentException('JSON inválido.');
    return $decoded;
}

function serve_public_file(string $path): never {
    $public = [
        '/styles.css'=>['styles.css','text/css; charset=utf-8'],
        '/src/bootstrap.js'=>['src/bootstrap.js','text/javascript; charset=utf-8'],
        '/src/app.js'=>['src/app.js','text/javascript; charset=utf-8'],
        '/icons/trivial.svg'=>['icons/trivial.svg','image/svg+xml'],
    ];
    if (!isset($public[$path])) {
        http_response_code(404);
        header('Content-Type: text/plain; charset=utf-8');
        echo 'No encontrado';
        exit;
    }
    [$relative,$type] = $public[$path];
    $file = __DIR__ . '/' . $relative;
    if (!is_file($file)) { http_response_code(404); exit; }
    header('Content-Type: ' . $type);
    header('Cache-Control: public, max-age=300');
    readfile($file);
    exit;
}

$queryPath = $_GET['path'] ?? null;
if ($queryPath !== null) {
    if (!is_string($queryPath) || !str_starts_with($queryPath, '/api/')) {
        http_response_code(400);
        header('Content-Type: text/plain; charset=utf-8');
        echo 'Ruta API inválida';
        exit;
    }
    $path = parse_url($queryPath, PHP_URL_PATH) ?: '/';
} else {
    $path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
}
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

if (str_starts_with($path, '/api/')) {
    try {
        $seed = load_seed();
        if ($method === 'GET' && $path === '/api/health') {
            $runtime = read_state();
            json_response(['ok'=>true,'revision'=>$runtime['revision'],'seedVersion'=>$seed['meta']['seed_version']??null,'rulesVersion'=>TRIVIAL_RULES_VERSION]);
        }
        if ($method === 'GET' && $path === '/api/revision') {
            $runtime = read_state();
            json_response(['revision'=>$runtime['revision'],'updatedAt'=>$runtime['updatedAt']??null,'contentSignature'=>$seed['signature']]);
        }
        if ($method === 'GET' && $path === '/api/bootstrap') {
            $runtime = read_state();
            json_response(bootstrap_payload($seed,$runtime));
        }
        if ($method === 'GET' && $path === '/api/diagnostics') {
            $runtime = read_state();
            json_response(diagnostics_payload($seed,$runtime));
        }
        if ($method === 'GET' && $path === '/api/statistics') {
            $runtime = read_state();
            json_response(compute_stats($seed,$runtime));
        }
        if ($method === 'GET' && $path === '/api/backup') json_response(read_state());
        if ($method === 'POST' && $path === '/api/restore') {
            $payload = request_json();
            if (($payload['schemaVersion'] ?? null) !== 1 || !is_array($payload['matches'] ?? null) || !is_array($payload['events'] ?? null)) throw new InvalidArgumentException('Copia incompatible.');
            $result = with_state_lock(function(array &$state) use ($payload) {
                $state = $payload;
                $state['revision'] = ((int)($state['revision'] ?? 0)) + 1;
                return ['ok'=>true,'revision'=>$state['revision']];
            });
            json_response($result);
        }
        if ($method === 'POST' && $path === '/api/matches') {
            $payload = request_json();
            $result = with_state_lock(function(array &$state) use ($payload) { return create_match($state,$payload); });
            json_response($result,201);
        }
        if (preg_match('#^/api/matches/([^/]+)/actions$#',$path,$m) && $method === 'POST') {
            $matchId = rawurldecode($m[1]);
            $payload = request_json();
            $result = with_state_lock(function(array &$state) use ($matchId,$payload) { return perform_action($state,$matchId,$payload); });
            json_response($result);
        }
        if (preg_match('#^/api/matches/([^/]+)$#',$path,$m) && $method === 'GET') {
            $runtime = read_state();
            $match = find_match($runtime,rawurldecode($m[1]));
            json_response(match_detail($seed,$runtime,$match));
        }
        json_response(['error'=>['message'=>'Ruta API no encontrada.']],404);
    } catch (InvalidArgumentException $error) {
        json_error($error,400);
    } catch (Throwable $error) {
        json_error($error,500);
    }
}

if ($method !== 'GET' && $method !== 'HEAD') { http_response_code(405); exit; }
if ($path === '/') {
    header('Content-Type: text/html; charset=utf-8');
    header('Cache-Control: no-cache');
    readfile(__DIR__ . '/index.html');
    exit;
}
serve_public_file($path);
