"""Diagnostics must not do NumPy formatting in the normal collision hot path."""

import logging

import numpy as np
import pytest

from pooltool.constants import sliding
from pooltool.objects import (
    Ball,
    BallParams,
    CircularCushionSegment,
    LinearCushionSegment,
    PocketTableSpecs,
)
from pooltool.physics.resolve import stronge_compliant
from pooltool.physics.resolve.ball_cushion.stronge_compliant import model


def collision(kind, angle=30.0, spin=0.0):
    """A real incoming ball with both linear and circular cushion variants."""
    specs = PocketTableSpecs()
    ball = Ball("cue", params=BallParams())
    ball.state.rvw[0] = [-ball.params.R, 0.0, ball.params.R]
    radians = np.radians(angle)
    ball.state.rvw[1] = [np.cos(radians), np.sin(radians), 0.0]
    ball.state.rvw[2] = [spin, -spin / 2, spin / 3]
    ball.state.s = sliding
    if kind == "linear":
        cushion = LinearCushionSegment(
            "rail",
            p1=np.array([0.0, -1.0, specs.cushion_height]),
            p2=np.array([0.0, 1.0, specs.cushion_height]),
            nose_radius=specs.cushion_nose_radius,
        )
        resolver = model.StrongeCompliantLinear()
    else:
        cushion = CircularCushionSegment(
            "jaw",
            center=np.array([0.0, 0.0, specs.cushion_height]),
            radius=0.01,
        )
        ball.state.rvw[0, 0] -= cushion.radius
        resolver = model.StrongeCompliantCircular()
    return ball, cushion, resolver


@pytest.mark.parametrize("kind", ["linear", "circular"])
def test_disabled_debug_never_formats_arrays(kind, caplog):
    ball, cushion, resolver = collision(kind)
    # Warm the actual numerical functions before installing the formatting trap.
    expected, _ = resolver.resolve(ball, cushion)

    def forbidden_format(value):
        raise AssertionError("NumPy debug formatting reached a disabled logger")

    with (
        caplog.at_level(logging.WARNING, logger=model.__name__),
        caplog.at_level(logging.WARNING, logger=stronge_compliant.__name__),
        np.printoptions(formatter={"float_kind": forbidden_format}),
    ):
        # Negative control: prove the trap catches the old eager f-string path.
        with pytest.raises(AssertionError, match="NumPy debug formatting"):
            str(np.array([1.0]))
        actual, _ = resolver.resolve(ball, cushion)

    np.testing.assert_array_equal(actual.state.rvw, expected.state.rvw)
    assert actual.state.s == expected.state.s
    assert actual.state.t == expected.state.t


def test_disabled_scalar_debug_skips_ratio_diagnostics(caplog, monkeypatch):
    messages = []
    monkeypatch.setattr(stronge_compliant.logger, "debug", messages.append)
    with caplog.at_level(logging.WARNING, logger=stronge_compliant.__name__):
        stronge_compliant.resolve_collinear_compliant_frictional_inelastic_collision(
            v_t_0=-2.0,
            v_n_0=-1.0,
            m=0.170097,
            beta_t=3.5,
            beta_n=1.0,
            mu=0.2,
            e_n=0.85,
            k_n=1e3,
            eta_squared=3.5 / 1.7**2,
        )
    # The cheap constant branch marker is allowed. The old eager numeric
    # diagnostic would also have been sent to this spy despite DEBUG being off.
    assert messages == ["gross slip case"]


@pytest.mark.parametrize("kind", ["linear", "circular"])
@pytest.mark.parametrize("angle", [1.0, 30.0, 89.0])
@pytest.mark.parametrize("spin", [0.0, 20.0])
def test_debug_keeps_identical_physics_and_available_diagnostics(
    kind, angle, spin, caplog
):
    ball, cushion, resolver = collision(kind, angle, spin)
    with (
        caplog.at_level(logging.WARNING, logger=model.__name__),
        caplog.at_level(logging.WARNING, logger=stronge_compliant.__name__),
    ):
        quiet, _ = resolver.resolve(ball, cushion)
    caplog.clear()
    with (
        caplog.at_level(logging.DEBUG, logger=model.__name__),
        caplog.at_level(logging.DEBUG, logger=stronge_compliant.__name__),
    ):
        debug, _ = resolver.resolve(ball, cushion)

    np.testing.assert_array_equal(debug.state.rvw, quiet.state.rvw)
    assert debug.state.s == quiet.state.s
    assert debug.state.t == quiet.state.t
    messages = [record.getMessage() for record in caplog.records]
    assert any(message.startswith("v=") for message in messages)
    assert any(message.startswith("v_c_0=") for message in messages)
    assert any(message.startswith("v_c_f=") for message in messages)
    assert any(message.startswith("v_t_0/(mu * v_n_0)=") for message in messages)
