"""Indexed collision-cache dictionary; no collision-physics approximation."""

from functools import lru_cache
from itertools import combinations, product
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from pooltool.events import EventType
    from pooltool.evolution.event_based.cache import CollisionCache


@lru_cache(maxsize=128)
def _pair_order(
    first_ids: tuple[str, ...], second_ids: tuple[str, ...] | None
) -> dict[tuple[str, str], int]:
    pairs = combinations(first_ids, 2) if second_ids is None else product(first_ids, second_ids)
    return {pair: index for index, pair in enumerate(pairs)}


class PairTimes(dict):
    """Dictionary-compatible times with exact missing-pair and ball-row indexes.

    All ordinary dict mutations maintain the indexes. No collision times are
    guessed from a changed ball: deleted keys alone become missing, and their
    canonical order is restored before reinsertion, preserving equal-time ties.
    The public ``times`` mapping remains readable/copyable/serializable as before.
    """

    def __init__(self, values=(), first_ids=(), second_ids=None):
        super().__init__(values)
        self.layout = (first_ids, second_ids)
        self._order = _pair_order(first_ids, second_ids)
        self._missing = self._order.keys() - self.keys()
        self._rows: dict[str, set[tuple[str, ...]]] = {}
        self._population_started = False
        for key in self._order:
            self._index_key(key)
        self._expected_rows = {ball: keys.copy() for ball, keys in self._rows.items()}
        for key in self.keys() - self._order.keys():
            self._index_key(key)

    def _index_key(self, key):
        self._rows.setdefault(key[0], set()).add(key)
        if self.layout[1] is None:
            self._rows.setdefault(key[1], set()).add(key)

    def __setitem__(self, key, value):
        super().__setitem__(key, value)
        self._missing.discard(key)
        if key not in self._order:
            self._index_key(key)

    def __delitem__(self, key):
        super().__delitem__(key)
        if key in self._order:
            self._missing.add(key)

    def clear(self):
        super().clear()
        self._missing = set(self._order)

    def pop(self, key, *default):
        if len(default) > 1:
            raise TypeError(f"pop expected at most 2 arguments, got {len(default) + 1}")
        if key not in self:
            if default:
                return default[0]
            raise KeyError(key)
        value = self[key]
        del self[key]
        return value

    def popitem(self):
        key, value = super().popitem()
        if key in self._order:
            self._missing.add(key)
        return key, value

    def setdefault(self, key, default=None):
        if key not in self:
            self[key] = default
        return self[key]

    def update(self, *values, **kwargs):
        for key, value in dict(*values, **kwargs).items():
            self[key] = value

    def __ior__(self, other):
        self.update(other)
        return self

    def __reduce_ex__(self, protocol):
        # Rebuild indexes from values instead of serializing transient metadata.
        return type(self), (dict(self), *self.layout)

    def missing_pairs(self):
        if self._population_started:
            # A prior detector call may have raised partway through population.
            # Preserve its successful entries when that caller retries.
            self._missing.difference_update(self)
        self._population_started = True
        return sorted(self._missing, key=self._order.__getitem__)

    def complete_pairs(self):
        self._missing.clear()
        self._population_started = False

    def invalidate_balls(self, ball_ids):
        invalid = set()
        for ball_id in ball_ids:
            self._missing.update(self._expected_rows.get(ball_id, ()))
            invalid.update(self._rows.get(ball_id, ()))
        # Internal batch mutation avoids a Python override for every pair. The
        # missing index was updated above; public dict mutations still use the
        # tracked methods, including partial-fill retry handling.
        for key in invalid:
            dict.pop(self, key, None)


def pair_cache(
    collision_cache: "CollisionCache", event_type: "EventType",
    first_ids: tuple[str, ...], second_ids: tuple[str, ...] | None = None,
) -> PairTimes:
    """Wrap an actual cache (including external replacements) for this ID layout."""
    cache = collision_cache.times.setdefault(event_type, {})
    if not isinstance(cache, PairTimes) or cache.layout != (first_ids, second_ids):
        cache = PairTimes(cache, first_ids, second_ids)
        collision_cache.times[event_type] = cache
    return cache
