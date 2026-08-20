import math
from collections import defaultdict

from .domain import _parse_event, _parse_match, active_events


def wilson(successes, total, z=1.959963984540054):
    if not total:
        return {"low": 0.0, "high": 0.0, "confidence": 0.95}
    proportion = successes / total
    z2 = z * z
    denominator = 1 + z2 / total
    center = (proportion + z2 / (2 * total)) / denominator
    margin = z * math.sqrt((proportion * (1 - proportion) + z2 / (4 * total)) / total) / denominator
    return {"low": max(0.0, center - margin), "high": min(1.0, center + margin), "confidence": 0.95}


def fisher_exact(a, b, c, d):
    row_one = a + b
    row_two = c + d
    column_one = a + c
    total = row_one + row_two
    if not total or not row_one or not row_two:
        return 1.0

    def probability(x):
        return math.comb(column_one, x) * math.comb(total - column_one, row_one - x) / math.comb(total, row_one)

    low = max(0, row_one - (total - column_one))
    high = min(row_one, column_one)
    observed = probability(a)
    return min(1.0, sum(probability(x) for x in range(low, high + 1) if probability(x) <= observed + 1e-15))


def _gamma_q(shape, value):
    if value <= 0:
        return 1.0
    if value < shape + 1:
        term = 1 / shape
        total = term
        current = shape
        for _ in range(1, 500):
            current += 1
            term *= value / current
            total += term
            if abs(term) < abs(total) * 1e-14:
                break
        lower = total * math.exp(-value + shape * math.log(value) - math.lgamma(shape))
        return max(0.0, min(1.0, 1 - lower))
    b = value + 1 - shape
    c = 1 / 1e-300
    d = 1 / b
    result = d
    for index in range(1, 500):
        an = -index * (index - shape)
        b += 2
        d = an * d + b
        if abs(d) < 1e-300:
            d = 1e-300
        c = b + an / c
        if abs(c) < 1e-300:
            c = 1e-300
        d = 1 / d
        delta = d * c
        result *= delta
        if abs(delta - 1) < 1e-14:
            break
    return max(0.0, min(1.0, math.exp(-value + shape * math.log(value) - math.lgamma(shape)) * result))


def chi_square_p(statistic, degrees):
    return 1.0 if degrees <= 0 else _gamma_q(degrees / 2, statistic / 2)


def _attempt_row(row, match):
    return {
        "attemptId": row["attempt_id"],
        "matchId": row["match_id"],
        "bankId": row["bank_id"],
        "playerId": row["player_id"],
        "categoryId": row["category_id"],
        "levelKey": row["level_key"],
        "correct": bool(row["correct"]),
        "quesitoAttempt": bool(row["quesito_attempt"]),
        "quesitoWon": bool(row["quesito_won"]),
        "timestamp": match["createdAt"],
    }


def _increment(mapping, key, seed, attempt):
    row = mapping.setdefault(key, {**seed, "attempts": 0, "correct": 0, "wrong": 0, "quesitoAttempts": 0, "quesitosWon": 0})
    row["attempts"] += 1
    row["correct"] += int(attempt["correct"])
    row["wrong"] += int(not attempt["correct"])
    row["quesitoAttempts"] += int(attempt["quesitoAttempt"])
    row["quesitosWon"] += int(attempt["quesitoWon"])


def _finalize(rows):
    for row in rows:
        row["accuracy"] = row["correct"] / row["attempts"] if row["attempts"] else 0.0
        row["accuracyCi"] = wilson(row["correct"], row["attempts"])
        row["quesitoRate"] = row["quesitosWon"] / row["quesitoAttempts"] if row["quesitoAttempts"] else 0.0
        row["quesitoCi"] = wilson(row["quesitosWon"], row["quesitoAttempts"])
    return rows


def compute_statistics(database):
    with database.snapshot() as snapshot:
        return _compute_statistics(snapshot)


def _compute_statistics(database):
    matches = {_parse_match(row)["matchId"]: _parse_match(row) for row in database.query("SELECT * FROM matches")}
    attempts = []
    for row in database.query("SELECT * FROM historical_attempts WHERE active=1 AND computable=1 AND correct IS NOT NULL"):
        attempts.append(_attempt_row(row, matches[row["match_id"]]))
    events_by_match = defaultdict(list)
    all_events_by_match = defaultdict(list)
    for row in database.query("SELECT * FROM events ORDER BY match_id,seq"):
        event = _parse_event(row)
        all_events_by_match[event["matchId"]].append(event)
    for match_id, rows in all_events_by_match.items():
        events_by_match[match_id] = active_events(rows)
        match = matches.get(match_id)
        if not match:
            continue
        for event in events_by_match[match_id]:
            if event["type"] != "RESULT_RECORDED" or not isinstance(event["payload"].get("correct"), bool):
                continue
            payload = event["payload"]
            attempts.append({
                "attemptId": f'event:{event["eventId"]}',
                "matchId": match_id,
                "bankId": match["bankId"],
                "playerId": payload["playerId"],
                "categoryId": payload["categoryId"],
                "levelKey": payload["levelKey"],
                "correct": payload["correct"],
                "quesitoAttempt": bool(payload["quesitoAttempt"]),
                "quesitoWon": bool(payload["quesitoWon"]),
                "timestamp": event["timestamp"],
            })
    maps = {name: {} for name in ["player", "player_category", "player_level", "match_player", "category", "level"]}
    for attempt in attempts:
        category_key = f'{attempt["bankId"]}|{attempt["categoryId"]}'
        _increment(maps["player"], attempt["playerId"], {"playerId": attempt["playerId"]}, attempt)
        _increment(maps["player_category"], f'{attempt["playerId"]}|{category_key}', {"playerId": attempt["playerId"], "bankId": attempt["bankId"], "categoryId": attempt["categoryId"], "categoryKey": category_key}, attempt)
        _increment(maps["player_level"], f'{attempt["playerId"]}|{attempt["levelKey"]}', {"playerId": attempt["playerId"], "levelKey": attempt["levelKey"]}, attempt)
        _increment(maps["match_player"], f'{attempt["matchId"]}|{attempt["playerId"]}', {"matchId": attempt["matchId"], "playerId": attempt["playerId"]}, attempt)
        _increment(maps["category"], category_key, {"bankId": attempt["bankId"], "categoryId": attempt["categoryId"], "categoryKey": category_key}, attempt)
        _increment(maps["level"], attempt["levelKey"], {"levelKey": attempt["levelKey"]}, attempt)
    participants = database.query("SELECT * FROM participants WHERE active=1")
    match_counts = defaultdict(int)
    potential = defaultdict(int)
    for participant in participants:
        match = matches.get(participant["match_id"])
        if not match:
            continue
        match_counts[participant["player_id"]] += 1
        potential[participant["player_id"]] += len(match["enabledCategoryIds"])
    for player_id in match_counts:
        maps["player"].setdefault(player_id, {"playerId": player_id, "attempts": 0, "correct": 0, "wrong": 0, "quesitoAttempts": 0, "quesitosWon": 0})
    player_rows = _finalize(list(maps["player"].values()))
    for row in player_rows:
        row["matches"] = match_counts[row["playerId"]]
        row["potentialQuesitos"] = potential[row["playerId"]]
        row["quesitoOpportunityRate"] = row["quesitosWon"] / row["potentialQuesitos"] if row["potentialQuesitos"] else 0.0
        row["quesitoOpportunityCi"] = wilson(row["quesitosWon"], row["potentialQuesitos"])
    player_category = _finalize(list(maps["player_category"].values()))
    comparisons = []
    categories = sorted({row["categoryKey"] for row in player_category})
    for category_key in categories:
        ranked = sorted([row for row in player_category if row["categoryKey"] == category_key and row["attempts"]], key=lambda row: (-row["accuracy"], -row["attempts"], row["playerId"]))
        if len(ranked) < 2 or ranked[0]["accuracy"] == ranked[1]["accuracy"]:
            continue
        best = ranked[0]
        for other in ranked[1:]:
            comparisons.append({
                "categoryKey": category_key,
                "categoryId": best["categoryId"],
                "bankId": best["bankId"],
                "playerId": best["playerId"],
                "otherPlayerId": other["playerId"],
                "pValue": fisher_exact(best["correct"], best["wrong"], other["correct"], other["wrong"]),
            })
    running_adjusted = 0.0
    for index, item in enumerate(sorted(comparisons, key=lambda row: row["pValue"])):
        running_adjusted = max(running_adjusted, item["pValue"] * (len(comparisons) - index))
        item["adjustedPValue"] = min(1.0, running_adjusted)
    leaders = []
    for category_key in categories:
        rows = [item for item in comparisons if item["categoryKey"] == category_key]
        if rows and len({item["playerId"] for item in rows}) == 1 and all(item["adjustedPValue"] < 0.05 for item in rows):
            leaders.append({"categoryKey": category_key, "categoryId": rows[0]["categoryId"], "bankId": rows[0]["bankId"], "playerId": rows[0]["playerId"], "adjustedPValue": max(item["adjustedPValue"] for item in rows), "alpha": 0.05})
    level_distribution = []
    for match in matches.values():
        drawn = [event for event in all_events_by_match.get(match["matchId"], []) if event["type"] == "QUESTION_DRAWN"]
        for category_id in match["enabledCategoryIds"]:
            weights = match["levelWeights"].get(category_id, {})
            total_weight = sum(float(value) for value in weights.values())
            counts = {level_key: sum(1 for event in drawn if event["payload"].get("categoryId") == category_id and event["payload"].get("levelKey") == level_key) for level_key in match["enabledLevelKeys"]}
            total = sum(counts.values())
            statistic = 0.0
            expected_counts = []
            for level_key, count in counts.items():
                target = float(weights.get(level_key, 0)) / total_weight if total_weight else 0.0
                expected = total * target
                if expected:
                    statistic += (count - expected) ** 2 / expected
                    expected_counts.append(expected)
                level_distribution.append({"matchId": match["matchId"], "bankId": match["bankId"], "categoryId": category_id, "levelKey": level_key, "observed": count, "observedShare": count / total if total else 0.0, "targetShare": target, "total": total})
            degrees = max(0, len(expected_counts) - 1)
            inference_available = degrees > 0 and min(expected_counts, default=0) >= 5
            p_value = chi_square_p(statistic, degrees) if inference_available else None
            for row in level_distribution:
                if row["matchId"] == match["matchId"] and row["categoryId"] == category_id:
                    row["goodnessOfFitPValue"] = p_value
                    row["inferenceAvailable"] = inference_available
                    row["significantDeviation"] = inference_available and p_value < 0.05
    temporal_map = {}
    for attempt in attempts:
        day = str(attempt["timestamp"] or "sin-fecha")[:10]
        key = (day, attempt["playerId"])
        row = temporal_map.setdefault(key, {"day": day, "playerId": attempt["playerId"], "attempts": 0, "correct": 0})
        row["attempts"] += 1
        row["correct"] += int(attempt["correct"])
    temporal = []
    for row in temporal_map.values():
        row["accuracy"] = row["correct"] / row["attempts"] if row["attempts"] else 0.0
        row["accuracyCi"] = wilson(row["correct"], row["attempts"])
        temporal.append(row)
    discards = sum(1 for rows in events_by_match.values() for event in rows if event["type"] == "QUESTION_DISCARDED")
    retired = database.one("SELECT COUNT(*) AS count FROM question_retirements")["count"]
    return {
        "byPlayer": sorted(player_rows, key=lambda row: row["playerId"]),
        "byPlayerCategory": sorted(player_category, key=lambda row: (row["playerId"], row["categoryKey"])),
        "byPlayerLevel": sorted(_finalize(list(maps["player_level"].values())), key=lambda row: (row["playerId"], row["levelKey"])),
        "byMatchPlayer": sorted(_finalize(list(maps["match_player"].values())), key=lambda row: (row["matchId"], row["playerId"])),
        "byCategory": sorted(_finalize(list(maps["category"].values())), key=lambda row: row["categoryKey"]),
        "byLevel": sorted(_finalize(list(maps["level"].values())), key=lambda row: row["levelKey"]),
        "significantCategoryLeaders": leaders,
        "levelDistribution": level_distribution,
        "discards": discards,
        "retiredQuestions": retired,
        "temporal": sorted(temporal, key=lambda row: (row["day"], row["playerId"])),
        "inference": {"confidence": 0.95, "alpha": 0.05, "interval": "Wilson", "comparison": "Fisher bilateral", "multiplicity": "Holm"},
    }
