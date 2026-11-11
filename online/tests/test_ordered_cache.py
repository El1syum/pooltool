"""Exact mapping/minimum regressions for the opt-in online collision cache."""

import copy
import math
import pickle
import random
import unittest
from types import SimpleNamespace

import numpy as np

from online.server.ordered_cache import (
    OnlineCollisionCache,
    OnlinePairTimes,
    minimum_key,
    online_pair_cache,
    record_pairs,
)
from pooltool.events import EventType
from pooltool.evolution.event_based._pair_cache import PairTimes
from pooltool.evolution.event_based.cache import CollisionCache


BALLS = ("a", "b", "c", "d")
OBJECTS = ("left", "right", "middle")


class OrderedCacheTests(unittest.TestCase):
    def assert_same(self, actual, reference, *, missing=True):
        self.assertEqual(list(actual), list(reference))
        for key in reference:
            value, expected = actual[key], reference[key]
            if isinstance(expected, float) and math.isnan(expected):
                self.assertTrue(math.isnan(value))
            else:
                self.assertEqual(value, expected)
        if not reference:
            with self.assertRaises(ValueError):
                actual.minimum_key()
        else:
            try:
                expected = min(reference, key=reference.__getitem__)
            except TypeError:
                with self.assertRaises(TypeError):
                    actual.minimum_key()
            else:
                self.assertEqual(actual.minimum_key(), expected)
        if missing:
            self.assertEqual(actual.missing_pairs(), reference.missing_pairs())

    def test_initial_values_and_equal_times_keep_actual_insertion_order(self):
        values = [(('c', 'd'), 2.), (('a', 'b'), 2.), (('a', 'd'), 3.)]
        reference = PairTimes(values, BALLS)
        actual = OnlinePairTimes(values, BALLS)
        self.assert_same(actual, reference)
        self.assertEqual(actual.minimum_key(), ('c', 'd'))
        actual[('c', 'd')] = 2.
        reference[('c', 'd')] = 2.
        self.assert_same(actual, reference)

    def test_delete_and_reinsert_moves_a_tied_key_to_the_back(self):
        values = [(('a', 'b'), 1.), (('a', 'c'), 1.)]
        actual, reference = OnlinePairTimes(values, BALLS), PairTimes(values, BALLS)
        del actual[('a', 'b')]
        del reference[('a', 'b')]
        actual[('a', 'b')] = reference[('a', 'b')] = 1.
        self.assert_same(actual, reference)
        self.assertEqual(actual.minimum_key(), ('a', 'c'))

    def test_overwrite_revision_rejects_stale_smaller_heap_value(self):
        values = [(('a', 'b'), 1.), (('a', 'c'), 2.)]
        actual, reference = OnlinePairTimes(values, BALLS), PairTimes(values, BALLS)
        for value in (5., math.inf, -math.inf, 2., math.inf):
            actual[('a', 'b')] = reference[('a', 'b')] = value
            self.assert_same(actual, reference)

    def test_positive_infinity_zero_and_negative_infinity_ties(self):
        values = [(('c', 'd'), math.inf), (('a', 'b'), math.inf)]
        actual, reference = OnlinePairTimes(values, BALLS), PairTimes(values, BALLS)
        self.assert_same(actual, reference)
        for key, value in [(('a', 'b'), 0.), (('c', 'd'), -0.),
                           (('a', 'b'), -math.inf), (('c', 'd'), -math.inf)]:
            actual[key] = reference[key] = value
            self.assert_same(actual, reference)

    def test_nan_preserves_builtin_min_position_dependent_semantics(self):
        for values in (
            [(('a', 'b'), math.nan), (('a', 'c'), 1.), (('b', 'c'), 0.)],
            [(('a', 'b'), 1.), (('a', 'c'), math.nan), (('b', 'c'), 0.)],
        ):
            actual, reference = OnlinePairTimes(values, BALLS), PairTimes(values, BALLS)
            self.assert_same(actual, reference)
            actual[('a', 'c')] = reference[('a', 'c')] = math.inf
            self.assert_same(actual, reference)

    def test_default_none_is_not_rejected_before_min_is_requested(self):
        actual, reference = OnlinePairTimes(first_ids=BALLS), PairTimes(first_ids=BALLS)
        for key in [('a', 'b'), ('a', 'c')]:
            self.assertEqual(actual.setdefault(key), reference.setdefault(key))
            self.assert_same(actual, reference)
        actual[('a', 'c')] = reference[('a', 'c')] = 1.
        self.assert_same(actual, reference)
        del actual[('a', 'b')]
        del reference[('a', 'b')]
        self.assert_same(actual, reference)

    def test_ordinary_mapping_mutations_match_pairtimes(self):
        actual, reference = OnlinePairTimes(first_ids=BALLS), PairTimes(first_ids=BALLS)
        for mapping in (actual, reference):
            mapping.update({('a', 'b'): 3., ('a', 'c'): 2.})
            mapping |= {('c', 'd'): 2., ('a', 'b'): 4.}
            mapping.setdefault(('b', 'c'), 5.)
            mapping.setdefault(('a', 'b'), -1.)
        self.assert_same(actual, reference)
        self.assertEqual(actual.popitem(), reference.popitem())
        self.assert_same(actual, reference)
        self.assertEqual(actual.pop(('a', 'c')), reference.pop(('a', 'c')))
        self.assertEqual(actual.pop(('missing', 'value'), 99), 99)
        with self.assertRaises(KeyError):
            actual.pop(('missing', 'value'))
        with self.assertRaises(TypeError):
            actual.pop(('a', 'b'), 1, 2)
        self.assert_same(actual, reference)
        actual.clear()
        reference.clear()
        self.assert_same(actual, reference)
        self.assertFalse(actual._live.any())

    def test_partial_detector_fill_survives_an_interrupted_iterator_and_retry(self):
        actual, reference = OnlinePairTimes(first_ids=BALLS), PairTimes(first_ids=BALLS)
        pairs = actual.missing_pairs()
        self.assertEqual(pairs, reference.missing_pairs())

        def interrupted():
            yield pairs[0], 2.
            raise RuntimeError('interrupted detector fill')

        with self.assertRaises(RuntimeError):
            actual.record_pairs(interrupted())
        with self.assertRaises(RuntimeError):
            dict.update(reference, interrupted())
        self.assert_same(actual, reference)
        self.assertNotIn(pairs[0], actual.missing_pairs())
        actual.record_pairs((key, 3.) for key in actual.missing_pairs())
        dict.update(reference, ((key, 3.) for key in reference.missing_pairs()))
        actual.complete_pairs()
        reference.complete_pairs()
        self.assert_same(actual, reference)

    def test_invalidation_and_repopulation_preserve_existing_before_reinserted_ties(self):
        for objects in (None, OBJECTS):
            actual = OnlinePairTimes(first_ids=BALLS, second_ids=objects)
            reference = PairTimes(first_ids=BALLS, second_ids=objects)
            actual.record_pairs((key, 2.) for key in actual.missing_pairs())
            dict.update(reference, ((key, 2.) for key in reference.missing_pairs()))
            actual.complete_pairs()
            reference.complete_pairs()
            for changed in [('b',), ('a', 'c'), ('not-a-ball',), BALLS]:
                actual.invalidate_balls(changed)
                reference.invalidate_balls(changed)
                self.assert_same(actual, reference)
                actual.record_pairs((key, 2.) for key in actual.missing_pairs())
                dict.update(reference, ((key, 2.) for key in reference.missing_pairs()))
                actual.complete_pairs()
                reference.complete_pairs()
                self.assert_same(actual, reference)

    def test_unknown_keys_are_indexed_and_discarded_without_unbounded_rows(self):
        actual, reference = OnlinePairTimes(first_ids=BALLS), PairTimes(first_ids=BALLS)
        for number in range(300):
            key = ('external', str(number))
            actual[key] = reference[key] = float(number)
            actual.invalidate_balls(('external',))
            reference.invalidate_balls(('external',))
            self.assert_same(actual, reference)
        self.assertNotIn('external', actual._rows)
        self.assertFalse(actual._live.any())

    def test_copy_deepcopy_and_pickle_rebuild_private_indexes(self):
        actual = OnlinePairTimes(
            [(('a', 'c'), math.inf), (('a', 'b'), 3.), (('c', 'd'), 3.)], BALLS
        )
        actual._shape_identity = ('transient',)
        for duplicate in [actual.copy(), copy.copy(actual), copy.deepcopy(actual),
                          *[pickle.loads(pickle.dumps(actual, protocol=p)) for p in (0, 2, pickle.HIGHEST_PROTOCOL)]]:
            self.assertIsInstance(duplicate, OnlinePairTimes)
            self.assertEqual(duplicate.layout, actual.layout)
            self.assert_same(duplicate, PairTimes(actual, BALLS))
            self.assertIsNot(duplicate._values, actual._values)
            self.assertFalse(hasattr(duplicate, '_shape_identity'))
            duplicate[('a', 'b')] = -1.
            self.assertEqual(actual[('a', 'b')], 3.)

    def test_numeric_mirror_size_is_fixed_across_updates_and_deletes(self):
        keys = [('a', str(number)) for number in range(90)]
        actual = OnlinePairTimes(
            ((key, float(index)) for index, key in enumerate(keys)),
            ('a',), tuple(key[1] for key in keys),
        )
        reference = PairTimes(actual, *actual.layout)
        for number in range(5000):
            key = keys[number % len(keys)]
            if number % 17 == 0:
                del actual[key]
                del reference[key]
            value = math.inf if number % 5 == 0 else float(number % 13)
            actual[key] = reference[key] = value
            self.assertEqual(len(actual._values), len(keys))
            self.assertEqual(len(actual._ranks), len(keys))
            self.assertEqual(len(actual._live), len(keys))
            if number % 31 == 0:
                self.assert_same(actual, reference)
        self.assert_same(actual, reference)

    def test_minimum_does_not_call_getitem_for_every_live_pair(self):
        class Probe(OnlinePairTimes):
            reads = 0

            def __getitem__(self, key):
                self.reads += 1
                return super().__getitem__(key)

        actual = Probe(
            [(('a', 'b'), math.inf), (('a', 'c'), 1.), (('c', 'd'), 2.)], BALLS
        )
        for _ in range(100):
            self.assertEqual(actual.minimum_key(), ('a', 'c'))
        self.assertEqual(actual.reads, 0)

    def test_bulk_float64_records_keep_overwrite_and_reinsert_ties(self):
        actual, reference = OnlinePairTimes(first_ids=BALLS), PairTimes(first_ids=BALLS)
        pairs = [('c', 'd'), ('a', 'b'), ('a', 'c')]
        values = np.array([2., 2., math.inf], dtype=np.float64)
        actual.record_values(pairs, values)
        reference.update(zip(pairs, values.tolist()))
        self.assert_same(actual, reference)
        for incoming in [np.array([3., 1., -math.inf]), np.array([math.inf] * 3)]:
            actual.record_values(pairs, incoming)
            reference.update(zip(pairs, incoming.tolist()))
            self.assert_same(actual, reference)
        del actual[pairs[0]]
        del reference[pairs[0]]
        actual.record_values([pairs[0]], np.array([math.inf]))
        reference.update([(pairs[0], math.inf)])
        self.assert_same(actual, reference)
        self.assertEqual(actual.minimum_key(), pairs[1])

    def test_bulk_duplicate_keys_keep_first_rank_and_last_value(self):
        pairs = [('a', 'b'), ('a', 'c'), ('a', 'b'), ('c', 'd'), ('a', 'c')]
        values = np.array([3., 2., 1., 1., 1.])
        actual, reference = OnlinePairTimes(first_ids=BALLS), PairTimes(first_ids=BALLS)
        actual.record_values(pairs, values)
        reference.update(zip(pairs, values.tolist()))
        self.assert_same(actual, reference)
        self.assertEqual(actual.minimum_key(), ('a', 'b'))

    def test_bulk_nan_and_infinity_use_original_minimum_semantics(self):
        pairs = [('a', 'b'), ('a', 'c'), ('c', 'd')]
        for values in [np.array([math.nan, 1., 0.]),
                       np.array([1., math.nan, 0.]),
                       np.array([math.inf] * 3),
                       np.array([-0., 0., math.inf])]:
            actual, reference = OnlinePairTimes(first_ids=BALLS), PairTimes(first_ids=BALLS)
            actual.record_values(pairs, values)
            reference.update(zip(pairs, values.tolist()))
            self.assert_same(actual, reference)

    def test_bulk_recovers_after_normal_mutation_and_unknown_key_fallback(self):
        actual, reference = OnlinePairTimes(first_ids=BALLS), PairTimes(first_ids=BALLS)
        actual[('a', 'b')] = reference[('a', 'b')] = 4.
        for pair, values in [([('a', 'c')], np.array([2.])),
                             ([('outside', 'outside')], np.array([1.])),
                             ([('a', 'b')], np.array([1.]))]:
            actual.record_values(pair, values)
            reference.update(zip(pair, values.tolist()))
            self.assert_same(actual, reference)
        actual.invalidate_balls(('outside',))
        reference.invalidate_balls(('outside',))
        actual.record_values([('c', 'd')], np.array([0.]))
        reference.update([(('c', 'd'), 0.)])
        self.assert_same(actual, reference)
        self.assertFalse(actual._fallback)

    def test_non_float64_bulk_inputs_and_large_integers_remain_exact(self):
        pairs = [('a', 'b'), ('a', 'c')]
        for values in [[2**60 + 1, 2**60],
                       np.array([2**60 + 1, 2**60], dtype=np.int64),
                       np.array([2., 1.], dtype=np.float32)]:
            actual, reference = OnlinePairTimes(first_ids=BALLS), PairTimes(first_ids=BALLS)
            actual.record_values(pairs, values)
            reference.update(zip(pairs, values))
            self.assert_same(actual, reference)
            self.assertEqual(actual.minimum_key(), ('a', 'c'))

    def test_bulk_pair_index_pattern_cache_is_bounded_and_not_copied(self):
        actual = OnlinePairTimes(first_ids=BALLS)
        keys = tuple(actual._order)
        rng = random.Random(87611)
        for _ in range(500):
            pairs = rng.sample(keys, rng.randrange(1, len(keys) + 1))
            actual.record_values(pairs, np.ones(len(pairs)))
            self.assertLessEqual(len(actual._batch_indices), 128)
            self.assertTrue(all(len(indices) <= len(keys) for indices in actual._batch_indices.values()))
        self.assertEqual(actual.copy()._batch_indices, {})
        self.assertEqual(pickle.loads(pickle.dumps(actual))._batch_indices, {})

    def test_custom_numeric_comparison_uses_original_mapping_minimum(self):
        class ReverseFloat(float):
            def __lt__(self, other):
                return float(self) > float(other)

        values = [(('a', 'b'), ReverseFloat(1.)),
                  (('a', 'c'), ReverseFloat(2.))]
        actual = OnlinePairTimes(values, BALLS)
        self.assert_same(actual, PairTimes(values, BALLS))
        self.assertTrue(actual._fallback)
        self.assertEqual(actual.minimum_key(), ('a', 'c'))

    def test_bulk_rejects_length_mismatch_before_mutation_and_handles_empty_batch(self):
        actual = OnlinePairTimes(first_ids=BALLS)
        with self.assertRaises(ValueError):
            actual.record_values([('a', 'b')], np.array([1., 2.]))
        self.assertFalse(actual)
        actual.record_values([], np.array([], dtype=np.float64))
        self.assertFalse(actual)
        with self.assertRaises(ValueError):
            actual.minimum_key()

    def test_bulk_renumbers_before_int64_insertion_rank_overflow(self):
        actual = OnlinePairTimes({('a', 'b'): 1.}, BALLS)
        actual._next_rank = np.iinfo(np.int64).max - 1
        actual.record_values([('a', 'c'), ('c', 'd')], np.array([1., 1.]))
        self.assertEqual(actual.minimum_key(), ('a', 'b'))
        self.assertEqual(actual._next_rank, 3)

    def test_bulk_invalidation_randomized_realistic_detector_batches(self):
        rng = random.Random(17135)
        for objects in (None, OBJECTS):
            actual = OnlinePairTimes(first_ids=BALLS, second_ids=objects)
            reference = PairTimes(first_ids=BALLS, second_ids=objects)
            for number in range(600):
                changed = tuple(rng.sample(BALLS, rng.choice([1, 2])))
                actual.invalidate_balls(changed)
                reference.invalidate_balls(changed)
                pairs = actual.missing_pairs()
                self.assertEqual(pairs, reference.missing_pairs())
                values = np.array([rng.choice([0., -0., 1., 2., math.inf]) for _ in pairs])
                actual.record_values(pairs, values)
                dict.update(reference, zip(pairs, values.tolist()))
                actual.complete_pairs()
                reference.complete_pairs()
                with self.subTest(objects=objects, step=number):
                    self.assert_same(actual, reference)

    def test_only_explicit_online_cache_uses_mirror_and_layout_replacement_rewraps(self):
        ordinary = CollisionCache.create()
        public_pairs = online_pair_cache(ordinary, EventType.BALL_BALL, BALLS)
        self.assertIs(type(public_pairs), PairTimes)
        record_pairs(public_pairs, ((key, 1.) for key in public_pairs.missing_pairs()))
        self.assertEqual(minimum_key(public_pairs), ('a', 'b'))
        public_pairs.complete_pairs()
        private = OnlineCollisionCache.create()
        private.times[EventType.BALL_BALL] = {('c', 'd'): 2., ('a', 'b'): 2.}
        pairs = online_pair_cache(private, EventType.BALL_BALL, BALLS)
        self.assertIsInstance(pairs, OnlinePairTimes)
        self.assertEqual(pairs.minimum_key(), ('c', 'd'))
        replaced = online_pair_cache(private, EventType.BALL_BALL, tuple(reversed(BALLS)))
        self.assertIsNot(replaced, pairs)
        self.assertEqual(list(replaced), list(pairs))
        self.assertEqual(replaced.minimum_key(), pairs.minimum_key())

    def test_collision_cache_invalidation_copy_and_pickle_keep_fast_mapping(self):
        cache = OnlineCollisionCache.create()
        for kind, objects in [(EventType.BALL_BALL, None),
                              (EventType.BALL_LINEAR_CUSHION, OBJECTS)]:
            values = online_pair_cache(cache, kind, BALLS, objects)
            values.record_pairs((key, 1.) for key in values.missing_pairs())
            values.complete_pairs()
        event = SimpleNamespace(event_type=EventType.BALL_BALL, ids=('b', 'c'))
        cache.invalidate(event)
        for duplicate in [cache.copy(), copy.copy(cache), copy.deepcopy(cache),
                          pickle.loads(pickle.dumps(cache))]:
            self.assertIsInstance(duplicate, OnlineCollisionCache)
            for kind, values in duplicate.times.items():
                self.assertIsInstance(values, OnlinePairTimes)
                self.assert_same(values, PairTimes(cache.times[kind], *values.layout))

    def test_randomized_mutations_match_reference_order_minimum_and_missing_pairs(self):
        rng = random.Random(719317)
        for objects in (None, OBJECTS):
            actual = OnlinePairTimes(first_ids=BALLS, second_ids=objects)
            reference = PairTimes(first_ids=BALLS, second_ids=objects)
            keys = list(actual._order) + [('outside', 'outside')]
            for number in range(1800):
                key = rng.choice(keys)
                operation = rng.randrange(7)
                value = rng.choice([0., -0., 1., 2., math.inf, -math.inf])
                if operation == 0:
                    actual[key] = reference[key] = value
                elif operation == 1:
                    actual.update({key: value})
                    reference.update({key: value})
                elif operation == 2:
                    self.assertEqual(actual.pop(key, None), reference.pop(key, None))
                elif operation == 3 and actual:
                    self.assertEqual(actual.popitem(), reference.popitem())
                elif operation == 4:
                    changed = (rng.choice(BALLS),)
                    actual.invalidate_balls(changed)
                    reference.invalidate_balls(changed)
                elif operation == 5:
                    self.assertEqual(actual.setdefault(key, value), reference.setdefault(key, value))
                else:
                    actual.clear()
                    reference.clear()
                with self.subTest(objects=objects, step=number, operation=operation):
                    self.assert_same(actual, reference)
                    self.assertEqual(len(actual._values), len(actual._order))


if __name__ == '__main__':
    unittest.main()
