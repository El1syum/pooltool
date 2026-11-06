"""Bounded warm full-shot benchmark/profile. Never changes live match data.

Use the exact same physical input before/after an optimization. Every timed
result must equal the first warm result; timings include rules and trajectory.
The optional cProfile run is separate from the uninstrumented measurements.
"""
from __future__ import annotations

import argparse
import cProfile
import hashlib
import json
import platform
import pstats
import statistics
import sys
import time
from pathlib import Path
from unittest.mock import patch

import pooltool as pt

from online.server.physics import PhysicsEngine
from online.tests.test_detection_pairs import recorded_case


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--case-json', required=True)
    parser.add_argument('--repeats', type=int, default=3)
    parser.add_argument('--profile', action='store_true')
    parser.add_argument('--compare-stock', action='store_true', help='Alternate with the original Python simulation loop')
    parser.add_argument('--out', help='New output report; never overwrites an existing file')
    args = parser.parse_args()
    if not 1 <= args.repeats <= 5:
        parser.error('--repeats must be 1..5')
    destination = Path(args.out).resolve() if args.out else None
    if destination and destination.exists():
        parser.error('Output already exists; choose a new report path')
    engine = PhysicsEngine()
    print('Warming physics kernels...', file=sys.stderr, flush=True)
    engine.warmup()
    fixture, state = recorded_case(engine, args.case_json)
    print('Warming the exact recorded shot...', file=sys.stderr, flush=True)
    reference = engine.simulate(state, fixture['shot'])
    stock_timings = []
    if args.compare_stock:
        with patch('online.server.physics.simulate_online', pt.simulate):
            assert engine.simulate(state, fixture['shot']) == reference
    timings = []
    for index in range(args.repeats):
        for stock in ([True, False] if index % 2 == 0 else [False, True]) if args.compare_stock else [False]:
            started = time.perf_counter()
            if stock:
                with patch('online.server.physics.simulate_online', pt.simulate):
                    result = engine.simulate(state, fixture['shot'])
            else:
                result = engine.simulate(state, fixture['shot'])
            (stock_timings if stock else timings).append(time.perf_counter() - started)
            print(f'{"Stock" if stock else "Online"} warm sample: {(stock_timings if stock else timings)[-1]:.6f}s', file=sys.stderr, flush=True)
            assert result == reference, 'A repeated physical input produced a different result'
    encoded = json.dumps(reference, sort_keys=True, separators=(',', ':'), allow_nan=False).encode()
    output = {
        'python': platform.python_version(), 'platform': platform.platform(),
        'case': Path(args.case_json).name, 'repeats': args.repeats,
        'warmSeconds': timings, 'medianSeconds': statistics.median(timings),
        'maxSeconds': max(timings), 'events': len(reference['events']),
        'physicalSeconds': reference['duration'],
        'frames': len(reference['trajectory']['frames']),
        'resultSha256': hashlib.sha256(encoded).hexdigest(),
        'exactRepeatEquality': True,
        'scope': 'Warm isolated full PhysicsEngine.simulate; excludes live queue/network/playback lead',
    }
    if stock_timings:
        output['stockWarmSeconds'] = stock_timings
        output['stockMedianSeconds'] = statistics.median(stock_timings)
        output['speedup'] = statistics.median(stock_timings) / statistics.median(timings)
    if args.profile:
        print('Collecting a separate cProfile sample...', file=sys.stderr, flush=True)
        profiler = cProfile.Profile()
        result = profiler.runcall(engine.simulate, state, fixture['shot'])
        assert result == reference, 'Profiler changed physical results'
        stats = pstats.Stats(profiler)
        output['profileTotalSeconds'] = stats.total_tt
        for order, position in [('cumulative', 3), ('self', 2)]:
            output[f'profileBy{order.title()}'] = [
                {'file': filename, 'line': line, 'function': name,
                 'primitiveCalls': values[0], 'calls': values[1],
                 'selfSeconds': values[2], 'cumulativeSeconds': values[3]}
                for (filename, line, name), values in
                sorted(stats.stats.items(), key=lambda item: item[1][position], reverse=True)[:45]
            ]
    if destination:
        with destination.open('x', encoding='utf8') as stream:
            json.dump(output, stream, indent=2)
            stream.write('\n')
    print(json.dumps(output, indent=2))


if __name__ == '__main__':
    main()
