"""Cosmetic preparation uses the real game table without creating a room/match."""

from fastapi.testclient import TestClient

from online.server.app import create_app
from online.server.physics import PhysicsEngine
from .test_api import TestPhysics


def test_reference_is_detached_cached_and_does_not_create_match(tmp_path):
    class CountingPhysics(TestPhysics):
        created = 0

        def new_match(self, seed=None):
            self.created += 1
            return super().new_match(seed)

    engine = CountingPhysics()
    application = create_app(database=str(tmp_path / 'game.db'), engine=engine,
                             process_pool=False, background=False)
    with TestClient(application) as client:
        first = client.get('/api/assets/table-reference')
        assert first.status_code == 200
        snapshot = first.json()['snapshot']
        assert snapshot['table'] == {'width': 1, 'length': 2, 'pockets': []}
        snapshot['table']['width'] = 999
        assert client.get('/api/assets/table-reference').json()['snapshot']['table']['width'] == 1
        assert engine.created == 1
        db = application.state.service.store.db
        assert db.execute('SELECT count(*) FROM matches').fetchone()[0] == 0
        assert db.execute('SELECT count(*) FROM rooms').fetchone()[0] == 0


def test_production_reference_matches_actual_pooltool_geometry(tmp_path):
    application = create_app(database=str(tmp_path / 'real.db'), engine=PhysicsEngine(),
                             process_pool=False, background=False)
    with TestClient(application) as client:
        snapshot = client.get('/api/assets/table-reference').json()['snapshot']
        assert snapshot['table']['width'] == 0.9906
        assert snapshot['table']['length'] == 1.9812
        assert snapshot['table']['renderHeight'] == 0.708
        assert len(snapshot['table']['pockets']) == 6
        assert len(snapshot['balls']) == 16
