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


def test_response_cache_conditional_requests_and_invalidation(backend, monkeypatch):
    main, client = backend
    first = client.get('/api/inventory')
    tag = first.headers['etag']
    assert first.headers['content-encoding'] == 'gzip'
    assert first.headers['vary'] == 'Accept-Encoding'
    assert int(first.headers['content-length']) < len(first.content)
    # A cache hit must avoid both a dataframe copy and serialization.
    original = main.get_db
    def unexpected():
        raise AssertionError('Warm inventory response rebuilt the dataframe')
    monkeypatch.setattr(main, 'get_db', unexpected)
    assert client.get('/api/inventory').content == first.content
    unchanged = client.get('/api/inventory', headers={'If-None-Match':tag})
    assert unchanged.status_code == 304 and unchanged.content == b''
    assert client.get('/api/inventory', headers={'If-None-Match':'"other", '+tag[2:]}).status_code == 304
    identity = client.get('/api/inventory', headers={'Accept-Encoding':'gzip;q=0, identity;q=1'})
    assert 'content-encoding' not in identity.headers
    assert identity.content == first.content
    monkeypatch.setattr(main, 'get_db', original)
    df = original()
    part = df.loc[0, 'Part Number']
    stock = int(df.loc[0, 'Stock'])
    assert client.post('/api/inventory/receive', data={'part_number':part,'qty':1}).status_code == 200
    changed = client.get('/api/inventory', headers={'If-None-Match':tag})
    assert changed.status_code == 200 and changed.headers['etag'] != tag
    assert changed.json()[0]['Stock'] == stock + 1
    # External file replacement must also invalidate serialized response bytes.
    df.loc[0, 'Stock'] = stock + 5
    df.to_csv(main.DB_FILE, index=False)
    assert client.get('/api/inventory').json()[0]['Stock'] == stock + 5


def test_orders_response_invalidated_by_edit(backend):
    main, client = backend
    main._save_orders([{'bill_no':1,'name':'Before','items':[],'total':0}])
    first = client.get('/api/orders')
    assert client.get('/api/orders', headers={'If-None-Match':first.headers['etag']}).status_code == 304
    assert client.put('/api/orders/1', json={'name':'After'}).status_code == 200
    changed = client.get('/api/orders', headers={'If-None-Match':first.headers['etag']})
    assert changed.status_code == 200
    assert changed.json()[0]['name'] == 'After'


def test_concurrent_receipts_do_not_lose_stock(backend):
    from concurrent.futures import ThreadPoolExecutor
    main, client = backend
    df = main.get_db()
    part, stock = df.loc[0, 'Part Number'], int(df.loc[0, 'Stock'])
    with client, ThreadPoolExecutor(max_workers=8) as pool:
        responses = list(pool.map(lambda _: client.post('/api/inventory/receive', data={'part_number':part,'qty':1}), range(16)))
    assert all(response.status_code == 200 for response in responses)
    assert int(main.get_db().loc[0, 'Stock']) == stock + 16


def test_slow_inventory_read_does_not_block_health(backend, monkeypatch):
    from concurrent.futures import ThreadPoolExecutor
    from threading import Event
    main, client = backend
    started, release = Event(), Event()
    original = main._read_inventory
    def slow_read():
        started.set()
        assert release.wait(5)
        return original()
    monkeypatch.setattr(main, '_read_inventory', slow_read)
    with client, ThreadPoolExecutor(max_workers=2) as pool:
        inventory = pool.submit(client.get, '/api/inventory')
        assert started.wait(2)
        try:
            health = pool.submit(client.get, '/health')
            assert health.result(timeout=1).status_code == 200
        finally:
            release.set()
        assert inventory.result(timeout=3).status_code == 200


@pytest.mark.parametrize('item', [
    {'quantity':-2,'unit_price':100},
    {'quantity':1,'unit_price':-100},
    {'quantity':1,'unit_price':'NaN'},
    {'quantity':'Infinity','unit_price':100},
    {'quantity':1,'unit_price':100,'type':'unknown'},
])
def test_invalid_bill_does_not_modify_stock(backend, item):
    main, client = backend
    before = Path(main.DB_FILE).read_bytes()
    part = str(main.get_db().loc[0, 'Part Number']).strip()
    response = client.post('/api/orders', json={'date':'2026-10-19','items':[dict(part_number=part, **item)]})
    assert response.status_code == 422, response.text
    assert Path(main.DB_FILE).read_bytes() == before
