"""Read-only UI regression for Leo Auto; optionally set LEO_TEST_URL."""
import asyncio
import os
from pathlib import Path
from playwright.async_api import async_playwright

async def main():
    async with async_playwright() as p:
        browser = await p.chromium.launch()
        page = await browser.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        await page.goto(os.getenv('LEO_TEST_URL', 'http://127.0.0.1:8000'), wait_until='networkidle')
        await page.wait_for_function('inventoryLoaded')
        for width in [375, 390, 768, 1024, 1440]:
            await page.set_viewport_size({'width':width, 'height':1000})
            state = await page.evaluate('''() => {
                const toolbar = document.querySelector('.catalog-toolbar').getBoundingClientRect();
                const nav = document.querySelector('.nav-pills').getBoundingClientRect();
                return {
                    columns:getComputedStyle(document.querySelector('.grid')).gridTemplateColumns.split(' ').length,
                    overflow:document.documentElement.scrollWidth>innerWidth,
                    topRight:nav.top<80 && nav.right>innerWidth-50,
                    filtersFit:[...document.querySelectorAll('.filter-selects select')].every(el=>el.getBoundingClientRect().right<=toolbar.right)
                };
            }''')
            assert state['columns'] == (4 if width>760 else 2), (width,state)
            assert not state['overflow'] and state['filtersFit'], (width,state)
            if width>760: assert state['topRight'], (width,state)
        await page.locator('#inventoryBrand').select_option('HINO')
        assert await page.evaluate("visibleInventory.every(item=>item.Brand==='HINO')")
        assert await page.locator('#inventoryBrand').evaluate('el=>el===document.activeElement')
        series = await page.locator('#inventorySeries option').nth(1).get_attribute('value')
        await page.locator('#inventorySeries').select_option(series)
        assert await page.evaluate('visibleInventory.every(item=>item.Series===activeFilters.series)')
        await page.evaluate('clearSearch()')
        for value in ['available','low','out']:
            await page.evaluate('(value)=>setInventoryStockFilter(value)', value)
            assert await page.evaluate('''(value) => visibleInventory.every(item=>{
                const total=item.Stock+item.Used_Stock;
                return value==='available'?total>0:value==='low'?total>0&&total<=5:total===0;
            })''',value)
            assert await page.locator('.stock-tab.active').get_attribute('aria-pressed') == 'true'
            assert await page.locator('.stock-tab.active').evaluate('el=>el===document.activeElement')
        await page.evaluate('clearSearch()')
        assert await page.locator('.card').count() == 24
        assert await page.locator('.card img:not([alt])').count() == 0
        await page.locator('#sortDropBtn').click()
        assert await page.locator('#sortDropBtn').get_attribute('aria-expanded') == 'true'
        await page.keyboard.press('Escape')
        assert await page.locator('#sortDropBtn').get_attribute('aria-expanded') == 'false'
        await page.locator('#sortDropBtn').click()
        await page.locator('.sort-opt').filter(has_text='ราคา: น้อย').click()
        assert await page.evaluate('visibleInventory.every((item,index,rows)=>index===0||rows[index-1].Price<=item.Price)')
        await page.evaluate("setSort('newest')")
        for view in ['orders','analytics','inventory']:
            await page.locator(f'.nav-pill[data-view="{view}"]').click()
            assert await page.locator(f'.nav-pill[data-view="{view}"]').get_attribute('aria-current') == 'page'
        assert not errors, errors
        Path('test-results').mkdir(exist_ok=True)
        await page.screenshot(path='test-results/promax-desktop.png')
        await page.set_viewport_size({'width':390,'height':1000})
        await page.screenshot(path='test-results/promax-mobile.png')
        print('PASS: five viewport sizes, 4-column desktop, labelled filters, stock states, focus, sorting and navigation; no JS errors.')
        await browser.close()

asyncio.run(main())
