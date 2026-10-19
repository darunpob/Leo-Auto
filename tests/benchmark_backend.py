"""Run from the repo root with DATA_DIR pointing at disposable benchmark data."""
import json
import statistics
import sys
import time
from pathlib import Path

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import main

with TestClient(main.app) as client:
    for route in ['/api/inventory', '/api/orders']:
        for _ in range(3):
            client.get(route)
        samples = []
        for _ in range(60):
            start = time.perf_counter()
            response = client.get(route)
            samples.append((time.perf_counter() - start) * 1000)
            response.raise_for_status()
        print(json.dumps({
            'route': route,
            'median_ms': round(statistics.median(samples), 3),
            'p95_ms': round(sorted(samples)[56], 3),
            'wire_bytes': int(response.headers['content-length']),
            'encoding': response.headers.get('content-encoding'),
            'items': len(response.json()),
        }))
