"""Regression checks use isolated data, never the store's inventory."""
import importlib
import sys
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

@pytest.fixture
def backend(tmp_path, monkeypatch):
    monkeypatch.setenv('DATA_DIR', str(tmp_path))
    import main
    module = importlib.reload(main)
    return module, TestClient(module.app)


def test_workspace_assets_and_unique_ids(backend):
    from bs4 import BeautifulSoup
    _, client = backend
    response = client.get('/')
    assert response.status_code == 200
    soup = BeautifulSoup(response.text, 'html.parser')
    ids = [el['id'] for el in soup.select('[id]')]
    assert len(ids) == len(set(ids))
    for asset in ['/assets/config.js', '/assets/app.js', '/assets/dialogs.js', '/assets/legacy.css', '/assets/workspace.css']:
        assert client.get(asset).status_code == 200


def test_inventory_cache_is_reused_and_copies_are_isolated(backend, monkeypatch):
    main, _ = backend
    calls = 0
    original = main._read_inventory
    def read():
        nonlocal calls
        calls += 1
        return original()
    monkeypatch.setattr(main, '_read_inventory', read)
    first = main.get_db()
    second = main.get_db()
    assert calls == 1
    first.loc[0, 'Stock'] = 999999
    assert second.loc[0, 'Stock'] != 999999
    assert main.get_db().loc[0, 'Stock'] != 999999
    main.save_db(first)
    assert main.get_db().loc[0, 'Stock'] == 999999
    assert calls == 2


def test_product_receive_and_bill_roundtrip(backend):
    _, client = backend
    data = {'part_number':'UX-TEST', 'part_name':'Test part', 'brand':'LEO', 'series':'TEST', 'price':100, 'stock':10}
    assert client.post('/api/inventory', data=data).status_code == 200
    assert client.post('/api/inventory/receive', data={'part_number':'UX-TEST','qty':3}).status_code == 200
    response = client.post('/api/orders', json={'date':'2026-10-19','name':'Test sale','items':[{'part_number':'UX-TEST','quantity':2,'unit_price':100,'type':'new','payment_method':'cash'}]})
    assert response.status_code == 200, response.text
    inventory = client.get('/api/inventory').json()
    assert next(it for it in inventory if it['Part Number']=='UX-TEST')['Stock'] == 11
    assert client.get('/api/orders').status_code == 200
    assert client.delete('/api/inventory', params={'part_number':'UX-TEST'}).status_code == 200
