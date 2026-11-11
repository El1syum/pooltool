from itertools import combinations, product
import copy
import json
import pickle

import pytest

from pooltool.evolution.event_based._pair_cache import PairTimes, _pair_order, pair_cache
from pooltool.evolution.event_based.cache import CollisionCache
from pooltool.events import EventType


@pytest.mark.parametrize("second", [None, (), ("corner", "side", "end")])
def test_missing_pairs_match_nested_loop_and_reinsertion_order(second):
    first = ("cue", "10", "2", "1")
    pairs = list(combinations(first, 2) if second is None else product(first, second))
    # Every subset exercises partially populated caches, arbitrary deletions and
    # equal-time cache minima, not only the simulator's normal invalidation path.
    for mask in range(1 << len(pairs)):
        cached = PairTimes({pair: 1.0 for index, pair in enumerate(pairs) if mask & (1 << index)}, first, second)
        expected = [pair for pair in pairs if pair not in cached]
        assert cached.missing_pairs() == expected
        original = cached.copy()
        for pair in expected:
            original[pair] = 1.0
        for pair in cached.missing_pairs():
            cached[pair] = 1.0
        assert list(cached) == list(original)
        if cached:
            assert min(cached, key=cached.__getitem__) == min(original, key=original.__getitem__)


def test_pair_layout_changes_and_foreign_cache_entries_are_not_assumed_away():
    cache = CollisionCache(times={EventType.BALL_LINEAR_CUSHION: {("cue", "left"): 0.0, ("old-ball", "old-cushion"): 0.0}})
    assert pair_cache(cache, EventType.BALL_LINEAR_CUSHION, ("cue", "2"), ("right", "left")).missing_pairs() == [
        ("cue", "right"), ("2", "right"), ("2", "left")
    ]
    assert pair_cache(cache, EventType.BALL_LINEAR_CUSHION, ("2", "cue"), ("left",)).missing_pairs() == [("2", "left")]
    assert pair_cache(cache, EventType.BALL_LINEAR_CUSHION, (), ("left",)).missing_pairs() == []
    assert PairTimes({}, ("cue",)).missing_pairs() == []


def test_pair_layout_cache_is_bounded_and_never_contains_physical_values():
    for index in range(140):
        PairTimes({}, (f"ball-{index}", "cue"))
    assert _pair_order.cache_info().currsize <= 128


def test_all_dict_mutations_keep_missing_pairs_and_invalidation_exact():
    first, second = ("cue", "1"), ("left", "right")
    expected = list(product(first, second))
    times = PairTimes({}, first, second)

    def check():
        assert times.missing_pairs() == [key for key in expected if key not in times]

    times[expected[0]] = 1.; check()
    times.setdefault(expected[1], 2.); check()
    times.update({expected[2]: 3.}); check()
    times |= {expected[3]: 4.}; check()
    del times[expected[1]]; check()
    times.pop(expected[2]); check()
    times.popitem(); check()
    assert times.pop(("missing", "key"), None) is None
    with pytest.raises(KeyError):
        times.pop(("missing", "key"))
    with pytest.raises(TypeError):
        times.pop(("missing", "key"), 1, 2)
    times.update(zip(expected, range(4))); check()
    times[("retired", "rail")] = 1.
    times.invalidate_balls({"cue", "retired"}); check()
    assert ("retired", "rail") not in times
    times.clear(); check()


def test_copy_pickle_and_json_keep_values_without_aliasing_transient_indexes():
    times = PairTimes({("cue", "1"): 0.5}, ("cue", "1", "2"))
    for clone in (copy.copy(times), copy.deepcopy(times), pickle.loads(pickle.dumps(times))):
        assert clone == times
        assert list(clone) == list(times)
        assert clone.missing_pairs() == times.missing_pairs()
        clone[("cue", "2")] = 1.
        assert ("cue", "2") not in times
    assert json.dumps({"|".join(key): value for key, value in times.items()}) == '{"cue|1": 0.5}'


def test_partial_internal_population_retry_and_external_cache_replacement():
    first = ("cue", "1", "2")
    times = PairTimes({}, first)
    pending = times.missing_pairs()
    dict.__setitem__(times, pending[0], .25)
    # Simulate an exception before complete_pairs(): already-computed values
    # retain their order/value, while the remaining pairs can be retried.
    assert times.missing_pairs() == pending[1:]
    for key in times.missing_pairs():
        dict.__setitem__(times, key, .5)
    times.complete_pairs()
    assert times.missing_pairs() == []
    cache = CollisionCache(times={EventType.BALL_BALL: times})
    copied = cache.copy()
    assert copied.times == cache.times
    copied.times[EventType.BALL_BALL].pop(pending[0])
    assert pending[0] in times
    wrapped = pair_cache(copied, EventType.BALL_BALL, first)
    assert wrapped.missing_pairs() == [pending[0]]
