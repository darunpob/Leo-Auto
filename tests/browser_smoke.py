import asyncio, json
from pathlib import Path
from playwright.async_api import async_playwright

async def main():
    Path("test-results").mkdir(exist_ok=True)
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page(viewport={'width':1440,'height':1000}, device_scale_factor=1)
        errors=[]
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto('http://127.0.0.1:8000', wait_until='networkidle')
        await page.wait_for_function('inventoryLoaded === true')
        assert await page.locator('.card').count() == 24
        await page.screenshot(path='test-results/desktop.png',full_page=False)
        await page.get_by_role('button',name='ถัดไป →').click()
        assert 'หน้า 2' in await page.locator('#inventoryPagination').inner_text()
        await page.locator('#searchInput').fill('water')
        await page.wait_for_timeout(250)
        assert await page.locator('.card').count() > 0
        await page.locator('#searchInput').fill('no-part-matches-this')
        await page.wait_for_timeout(250)
        assert await page.locator('.empty-state').count() == 1
        await page.locator('#searchInput').fill('')
        await page.wait_for_timeout(250)
        await page.get_by_role('button',name='เพิ่มสินค้า',exact=False).click()
        assert await page.locator('#manageModal').evaluate("el=>el.classList.contains('open')")
        await page.keyboard.press('Escape')
        await page.get_by_role('button',name='รับสินค้าเข้า',exact=False).click()
        assert await page.locator('#receiveModal').evaluate("el=>el.classList.contains('open')")
        await page.keyboard.press('Escape')
        await page.locator('.nav-pill[data-view="orders"]').click()
        await page.wait_for_timeout(500)
        assert await page.locator('#page-orders').is_visible()
        await page.screenshot(path='test-results/orders.png',full_page=False)
        await page.locator('.nav-pill[data-view="analytics"]').click()
        await page.wait_for_timeout(300)
        assert await page.locator('#page-analytics').is_visible()
        await page.locator('.nav-pill[data-view="inventory"]').click()
        assert await page.locator('.nav-pill.active').get_attribute('data-view') == 'inventory'
        await page.set_viewport_size({'width':390,'height':844})
        await page.screenshot(path='test-results/mobile.png',full_page=False)
        assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), 'Mobile horizontal overflow'
        for view in ['orders', 'analytics', 'inventory']:
            await page.locator(f'.nav-pill[data-view="{view}"]').click()
            await page.wait_for_timeout(250)
            assert await page.evaluate('document.documentElement.scrollWidth <= innerWidth'), f'Mobile overflow: {view}'
        # A failed API request must show an error and retain only previously fetched data.
        await page.route('**/api/inventory', lambda route: route.abort())
        await page.evaluate('refreshInventoryUI()')
        assert await page.locator('.load-error').count() == 1
        print(json.dumps({'browser_errors':errors,'desktop_cards':24,'mobile_overflow':False},ensure_ascii=False))
        assert not errors, errors
        await browser.close()
asyncio.run(main())
