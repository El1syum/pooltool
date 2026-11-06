"""Stock-layout optimization is private to one guarded online solve."""
from unittest.mock import patch

import attrs

from online.server import evolution
from online.server.detection import OnlineEventDetector
from online.server.physics import PhysicsEngine, _restore_system
from pooltool.evolution.engine import SimulationEngine
from pooltool.objects.table.components import CircularCushionSegment, CushionSegments, LinearCushionSegment, Pocket
from pooltool.objects.table.datatypes import Table
from pooltool.physics.resolve.resolver import default_resolver


class CustomMapping(dict):
    pass


def _system():
    return _restore_system(PhysicsEngine.new_match(20261106))


def _engine():
    engine = SimulationEngine(resolver=default_resolver())
    engine.detector = OnlineEventDetector()
    return engine


def _subclass_instance(instance, base):
    custom = type("Custom" + base.__name__, (base,), {})
    return custom(**{field.alias: getattr(instance, field.name) for field in attrs.fields(base) if field.init})


def test_fixed_layout_requires_exact_stock_mapping_and_container_types():
    assert evolution._fixed_layout(_system())
    for target in ("balls", "linear", "circular", "pockets", "table", "cushion_segments"):
        shot = _system()
        if target == "balls":
            shot.balls = CustomMapping(shot.balls)
        elif target in ("linear", "circular"):
            segments = shot.table.cushion_segments
            shot.table.cushion_segments = attrs.evolve(segments, **{target: CustomMapping(getattr(segments, target))})
        elif target == "pockets":
            shot.table.pockets = CustomMapping(shot.table.pockets)
        elif target == "table":
            shot.table = _subclass_instance(shot.table, Table)
        else:
            shot.table.cushion_segments = _subclass_instance(shot.table.cushion_segments, CushionSegments)
        assert not evolution._fixed_layout(shot), target


def test_fixed_layout_rejects_custom_components_even_inside_plain_dictionaries():
    for kind, base in (("linear", LinearCushionSegment), ("circular", CircularCushionSegment), ("pockets", Pocket)):
        shot = _system()
        mapping = shot.table.pockets if kind == "pockets" else getattr(shot.table.cushion_segments, kind)
        key = next(iter(mapping))
        mapping[key] = _subclass_instance(mapping[key], base)
        assert type(mapping) is dict
        assert not evolution._fixed_layout(shot), kind


def test_only_wrapper_owned_stock_solve_receives_fixed_layout_identity_tag():
    shot = _system()
    direct = evolution._OnlineSimulationState(shot, _engine())
    assert getattr(direct.collision_cache, "_online_fixed_layout", None) is None
    real_state = evolution._OnlineSimulationState
    for custom in (False, True):
        source = _system()
        if custom:
            source.balls = CustomMapping(source.balls)
        captured = []

        def capture(*args, **kwargs):
            state = real_state(*args, **kwargs)
            captured.append(state)
            return state

        # In-place is deliberate: a System.copy can normalize custom mappings.
        if custom:
            # A mapping may have behavioral __getitem__/values hooks, not just
            # a different concrete type. Do not snapshot such a collection in
            # the online state at all: preserve the public simulator contract.
            assert not evolution._supports_batch(source, _engine())
            with patch.object(evolution, "_OnlineSimulationState", side_effect=capture), \
                    patch.object(evolution, "simulate", return_value=source) as fallback:
                assert evolution.simulate_online(source, engine=_engine(), inplace=True) is source
            assert not captured
            fallback.assert_called_once()
            assert fallback.call_args.kwargs["inplace"] is True
        else:
            with patch.object(evolution, "_OnlineSimulationState", side_effect=capture):
                assert evolution.simulate_online(source, engine=_engine(), inplace=True) is source
            assert len(captured) == 1
            tag = getattr(captured[0].collision_cache, "_online_fixed_layout", None)
            assert tag[0] == tuple(source.balls)
            assert all(left is right for left, right in zip(tag[1], source.balls.values()))
