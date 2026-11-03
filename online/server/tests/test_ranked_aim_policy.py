"""The presentation lock must derive from authoritative match rank, not preferences."""

import threading

from .test_api import login, receive_type, setup, shot, start_room


def ranked_match(client, first, second):
    assert client.post("/api/matchmaking", headers=first, json={"mode": "ranked"}).json()["queued"]
    paired = client.post("/api/matchmaking", headers=second, json={"mode": "ranked"}).json()
    assert paired["queued"] is False
    match = client.get(f"/api/matches/{paired['matchId']}", headers=first).json()["match"]
    assert match["ranked"] is True
    return paired["room"]["code"], match


def test_rank_flag_is_authoritative_for_players_spectators_and_finished_match(setup):
    client, _, _ = setup
    first, _ = login(client, "Ranked A")
    second, _ = login(client, "Ranked B")
    spectator, _ = login(client, "Observer")
    # Saved personal values, including a misleading rank-looking key, are not
    # match authority and must survive the render-only presentation override.
    preference = {"showAimGuide": True, "ranked": False, "volume": 0.6}
    assert client.put("/api/me/settings", headers=first, json=preference).status_code == 200
    code, match = ranked_match(client, first, second)
    assert client.patch(f"/api/rooms/{code}/settings", headers=first, json={"ranked": False}).status_code == 409
    joined = client.post(f"/api/rooms/{code}/spectate", headers=spectator).json()
    assert joined["match"]["ranked"] is True
    assert joined["match"]["status"] == "active"
    assert client.get(f"/api/matches/{match['id']}", headers=second).json()["match"]["ranked"] is True
    assert client.get("/api/me/settings", headers=first).json()["settings"] == preference
    ended = client.post(f"/api/matches/{match['id']}/commands", headers=first,
                        json={"commandId": "policy-surrender", "expectedRevision": 0, "type": "surrender"}).json()["match"]
    assert ended["status"] == "finished"
    assert ended["ranked"] is True
    assert client.get("/api/me/settings", headers=first).json()["settings"] == preference


def test_calculating_broadcast_retains_authoritative_rank(setup):
    client, engine, _ = setup
    first, first_data = login(client, "Ranked A")
    second, _ = login(client, "Ranked B")
    _, match = ranked_match(client, first, second)
    engine.block = threading.Event()
    responses = []
    with client.websocket_connect("/ws") as socket:
        socket.send_json({"type": "auth", "token": first_data["token"]})
        receive_type(socket, "authenticated")
        receive_type(socket, "restored")
        thread = threading.Thread(target=lambda: responses.append(client.post(
            f"/api/matches/{match['id']}/commands", headers=first, json=shot())))
        thread.start()
        try:
            assert engine.started.wait(3)
            calculating = receive_type(socket, "match")["match"]
            assert calculating["status"] == "calculating"
            assert calculating["ranked"] is True
            read = client.get(f"/api/matches/{match['id']}", headers=second).json()["match"]
            assert read["status"] == "calculating" and read["ranked"] is True
        finally:
            engine.block.set()
            thread.join(5)
    assert not thread.is_alive()
    assert responses[0].status_code == 200


def test_casual_room_does_not_claim_ranked_policy(setup):
    client, _, _ = setup
    first, _ = login(client, "Casual A")
    second, _ = login(client, "Casual B")
    _, match = start_room(client, first, second)
    assert match["ranked"] is False
