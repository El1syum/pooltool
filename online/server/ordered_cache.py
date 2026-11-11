"""Private online collision minima with exact dictionary insertion-order ties.

Only the online fast simulation creates OnlineCollisionCache. Public Pooltool
caches and custom callers retain their dict/min paths. Trusted detectors write
canonical float64 batches through record_values: a C-level bulk dict update and
a small numeric mirror keep insertion ranks for exact ties.

Ordinary mapping mutations remain supported, rebuilding the mirror when next
needed. Explicit base-class calls such as dict.update(cache, ...) bypass Python
overrides and are deliberately unsupported on this private subclass.
No collision time, root, epsilon or event ordering is approximated.
"""

import math

import numpy as np
from numba import jit

import pooltool.constants as const
from pooltool.evolution.event_based._pair_cache import PairTimes, pair_cache
from pooltool.evolution.event_based.cache import CollisionCache

_MAX_RANK = (1 << 63) - 1


@jit(nopython=True, cache=const.use_numba_cache)
def _store_values(indices, incoming, values, ranks, live, next_rank):
    for offset in range(len(indices)):
        index = indices[offset]
        if not live[index]:
            ranks[index] = next_rank
            next_rank += 1
            live[index] = True
        values[index] = incoming[offset]
    return next_rank


@jit(nopython=True, cache=const.use_numba_cache)
def _minimum_index(values, ranks, live):
    best = -1
    for index in range(len(values)):
        if not live[index]:
            continue
        value = values[index]
        if value != value:
            # Python min's NaN result can depend on its position, not just rank.
            return -2
        if (best < 0 or value < values[best]
                or value == values[best] and ranks[index] < ranks[best]):
            best = index
    return best


class OnlinePairTimes(PairTimes):
    """PairTimes plus a bounded numeric mirror for the trusted detector path."""

    def __init__(self, values=(), first_ids=(), second_ids=None):
        super().__init__(values, first_ids, second_ids)
        self._keys = tuple(self._order)
        self._values = np.full(len(self._keys), math.inf, dtype=np.float64)
        self._ranks = np.zeros(len(self._keys), dtype=np.int64)
        self._live = np.zeros(len(self._keys), dtype=np.bool_)
        self._row_indices = {
            ball: np.fromiter(map(self._order.__getitem__, keys), np.int64, len(keys))
            for ball, keys in self._expected_rows.items()
        }
        self._batch_indices = {}
        self._next_rank = 0
        self._dirty = True
        self._fallback = False
        self._rebuild()

    def _rebuild(self):
        self._live.fill(False)
        self._fallback = False
        for rank, (key, value) in enumerate(self.items()):
            index = self._order.get(key)
            # Custom numeric subclasses may override comparison, and casting
            # integers can lose their ordering above float64's exact range.
            # The trusted detector emits only these two exact float types.
            if index is None or type(value) not in (float, np.float64):
                self._fallback = True
                continue
            self._values[index] = value
            self._ranks[index] = rank
            self._live[index] = True
        self._next_rank = len(self)
        self._dirty = False

    def _prune_unknown_key(self, key):
        if key not in self._order:
            balls = (key[0], key[1]) if self.layout[1] is None else (key[0],)
            for ball in balls:
                row = self._rows.get(ball)
                if row is not None:
                    row.discard(key)
                    if not row and ball not in self._expected_rows:
                        del self._rows[ball]

    def __setitem__(self, key, value):
        self._dirty = True
        super().__setitem__(key, value)

    def __delitem__(self, key):
        super().__delitem__(key)
        self._prune_unknown_key(key)
        self._dirty = True

    def clear(self):
        super().clear()
        self._live.fill(False)
        self._next_rank = 0
        self._dirty = self._fallback = False
        self._rows = {
            ball: keys.copy() for ball, keys in self._expected_rows.items()
        }

    def popitem(self):
        key, value = super().popitem()
        self._prune_unknown_key(key)
        self._dirty = True
        return key, value

    def record_pairs(self, values):
        """Compatibility path for arbitrary iterators and partial fills."""
        self._dirty = True
        for key, value in values:
            PairTimes.__setitem__(self, key, value)

    def record_values(self, pairs, values):
        """Store a canonical float64 batch, preserving duplicate-key order."""
        if self._dirty:
            self._rebuild()
        if (self._fallback or type(values) is not np.ndarray
                or values.ndim != 1 or values.dtype != np.float64):
            self.record_pairs(zip(pairs, values))
            return
        if not isinstance(pairs, (list, tuple)):
            pairs = tuple(pairs)
        if len(pairs) != len(values):
            raise ValueError("Detector pair/value batch lengths differ")
        pattern = tuple(pairs)
        indices = self._batch_indices.get(pattern)
        if indices is None:
            try:
                indices = np.fromiter(
                    map(self._order.__getitem__, pairs), np.int64, len(pairs)
                )
            except KeyError:
                self.record_pairs(zip(pairs, values))
                return
            if len(pattern) <= len(self._keys):
                if len(self._batch_indices) >= 128:
                    del self._batch_indices[next(iter(self._batch_indices))]
                self._batch_indices[pattern] = indices
        # Renumbering is exact: only relative insertion order is meaningful.
        if self._next_rank + len(pairs) >= _MAX_RANK:
            self._rebuild()
        dict.update(self, zip(pairs, values.tolist()))
        self._missing.difference_update(pairs)
        self._next_rank = _store_values(
            indices, values, self._values, self._ranks, self._live, self._next_rank
        )

    def minimum_key(self):
        """Return exactly min(self, key=self.__getitem__) on current values."""
        if not self:
            raise ValueError("min() arg is an empty sequence")
        if self._dirty:
            self._rebuild()
        if self._fallback:
            return min(self, key=self.__getitem__)
        index = _minimum_index(self._values, self._ranks, self._live)
        if index == -2:
            return min(self, key=self.__getitem__)
        return self._keys[index]

    def invalidate_balls(self, ball_ids):
        invalid = set()
        for ball_id in ball_ids:
            self._missing.update(self._expected_rows.get(ball_id, ()))
            invalid.update(self._rows.get(ball_id, ()))
            if not self._dirty and not self._fallback:
                indices = self._row_indices.get(ball_id)
                if indices is not None:
                    self._live[indices] = False
        for key in invalid:
            dict.pop(self, key, None)
        if self._dirty or self._fallback:
            for key in invalid:
                self._prune_unknown_key(key)
            self._dirty = True

    def copy(self):
        return type(self)(self, *self.layout)


class OnlineCollisionCache(CollisionCache):
    """Opt-in cache used solely by the online fast simulation state."""

    def copy(self):
        return type(self)(times={kind: values.copy() for kind, values in self.times.items()})


def online_pair_cache(collision_cache, event_type, first_ids, second_ids=None):
    """Use numeric minima only for the explicit private online cache marker."""
    if not isinstance(collision_cache, OnlineCollisionCache):
        return pair_cache(collision_cache, event_type, first_ids, second_ids)
    cache = collision_cache.times.setdefault(event_type, {})
    if not isinstance(cache, OnlinePairTimes) or cache.layout != (first_ids, second_ids):
        cache = OnlinePairTimes(cache, first_ids, second_ids)
        collision_cache.times[event_type] = cache
    return cache


def record_pairs(cache, values):
    if isinstance(cache, OnlinePairTimes):
        cache.record_pairs(values)
    else:
        dict.update(cache, values)


def minimum_key(cache):
    if isinstance(cache, OnlinePairTimes):
        return cache.minimum_key()
    return min(cache, key=cache.__getitem__)
