"""Web eight-ball variant: actual pots count, without compulsory shot calls.

Keep the upstream/native ruleset unchanged. Its contact, cushion, scratch and
early-eight checks still apply; only declaring a ball/pocket is not required.
Client target markers never decide legality, group assignment or continuation.
"""

from collections import Counter

import attrs

from pooltool.events.datatypes import EventType
from pooltool.ruleset.datatypes import BallInHandOptions, ShotConstraints, ShotInfo
from pooltool.ruleset.eight_ball import (
    BallGroup,
    _EightBall,
    decide_winner,
    is_game_over,
    is_legal as upstream_is_legal,
    is_turn_over,
)
from pooltool.ruleset.utils import get_pocketed_ball_ids


def is_legal(shot, constraints, break_shot):
    # Upstream checks the eight's pocket even when call_shot=False. Supply its
    # actual physical pocket for that comparison only. The existing early-eight
    # and all ordinary foul checks are still authoritative.
    eight_pocket = next((event.ids[1] for event in shot.events
                         if event.event_type == EventType.BALL_POCKET
                         and event.ids[0] == "8"), None)
    return upstream_is_legal(
        shot, attrs.evolve(constraints, call_shot=False, pocket_call=eight_pocket),
        break_shot,
    )


class OnlineEightBall(_EightBall):
    def __init__(self, players, groups=None):
        self.groups = list(groups) if groups is not None else [None, None]
        super().__init__(players)

    def build_shot_info(self, shot):
        legal, reason = is_legal(shot, self.shot_constraints, self.shot_number == 0)
        turn_over = is_turn_over(shot, self.shot_constraints, legal)
        game_over = is_game_over(shot)
        if self.shot_number > 0 and legal and not turn_over and self.groups[self.active_idx] is None:
            first = next(event.ids[0] for event in shot.events
                         if event.event_type == EventType.BALL_POCKET
                         and event.ids[0] in self.shot_constraints.hittable)
            group = BallGroup.SOLIDS if first in BallGroup.SOLIDS.balls else BallGroup.STRIPES
            self.groups[self.active_idx] = str(group)
            self.groups[1 - self.active_idx] = str(
                BallGroup.STRIPES if group == BallGroup.SOLIDS else BallGroup.SOLIDS
            )
        return ShotInfo(
            player=self.active_player, legal=legal, reason=reason,
            turn_over=turn_over, game_over=game_over,
            winner=decide_winner(game_over, legal, self.active_player, self.last_player),
            score=self._score(shot, legal, game_over),
        )

    def _score(self, shot, legal, game_over):
        # Persisted group identity also disambiguates the case where BOTH groups
        # are down. Never infer the eight-shooter's group from remaining balls.
        pocketed = set(get_pocketed_ball_ids(shot))
        score = Counter()
        for index, group in enumerate(self.groups):
            if group is not None:
                score[self.players[index].name] = sum(ball in pocketed for ball in BallGroup(group).balls)
        if game_over and legal:
            score[self.active_player.name] += 1
        return score

    def next_shot_constraints(self, shot):
        legal = self.shot_info.legal
        next_index = 1 - self.active_idx if self.shot_info.turn_over else self.active_idx
        target = self.groups[next_index]
        group = BallGroup.UNDECIDED if target is None else BallGroup(target)
        pocketed = set(get_pocketed_ball_ids(shot))
        if group in (BallGroup.SOLIDS, BallGroup.STRIPES) and all(ball in pocketed for ball in group.balls):
            group = BallGroup.EIGHT
        return ShotConstraints(
            ball_in_hand=BallInHandOptions.NONE if legal else BallInHandOptions.ANYWHERE,
            movable=[] if legal else ["cue"], cueable=["cue"],
            hittable=group.balls, call_shot=False,
        )
