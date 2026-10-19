# Leo Auto

ระบบจัดการสต็อกอะไหล่รถบรรทุกและบิลขาย พร้อมผู้ช่วย AI สำหรับสอบถามสินค้าและค้นหาอะไหล่จากภาพ พัฒนาสำหรับวิชา CS460 มหาวิทยาลัยกรุงเทพ

## ความสามารถ

- เพิ่ม แก้ไข ลบ และค้นหาสินค้า พร้อมรูปภาพ ตำแหน่งจัดเก็บ ต้นทุน และราคาขาย
- จัดการสินค้าใหม่และมือสอง รวมถึงจำนวนอะไหล่ฝั่งซ้าย/ขวา
- รับสินค้าเข้าสต็อก
- สร้างบิลขาย คำนวณยอดรวม และตัดสต็อกเมื่อสร้างบิล
- ดูรายการบิล แก้ไขชื่อและรายละเอียด หรือลบบิล
- สอบถามข้อมูลสินค้าและระบุอะไหล่จากภาพด้วย Gemini 2.5 Flash
- หน้าเว็บภาษาไทย รองรับการใช้งานผ่านเบราว์เซอร์

## เทคโนโลยี

| ส่วน | เทคโนโลยี |
| --- | --- |
| Backend | Python, FastAPI, Uvicorn |
| Frontend | HTML, CSS, JavaScript |
| AI | Google Gen AI SDK (`google-genai`) |
| ข้อมูล | Pandas, CSV, JSON |
| รูปภาพ | Pillow, local file storage |
| Deployment | Docker / Python service และ Vercel สำหรับ frontend |

## โครงสร้างโปรเจกต์

```text
main.py               # FastAPI backend ที่ใช้กับ deployment ปัจจุบัน
frontend/index.html   # โครงหน้าจอ (app.js / dialogs.js / CSS แยกไฟล์)
frontend/config.js    # ตั้งค่า API origin เมื่อแยก frontend hosting
requirements.txt      # Python dependencies
inventory.csv         # ข้อมูลสินค้าเริ่มต้น
orders.json           # ข้อมูลบิลเริ่มต้น
picture/              # รูปสินค้า
Dockerfile            # Python 3.12 container
Procfile              # คำสั่งเริ่ม Python service
render.yaml           # การตั้งค่า Render
vercel.json           # การตั้งค่า static frontend
main.go               # Backend อีกชุด แยกจาก Python app
main_old.py           # โค้ด Python รุ่นก่อน
```

## เริ่มใช้งานในเครื่อง

ใช้ Python 3.12 เพื่อให้ตรงกับ Dockerfile เปิด terminal ในโฟลเดอร์ที่มี `main.py`

### Windows (PowerShell)

```powershell
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
$env:GEMINI_API_KEY = "your-api-key"
.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 8000
```

### macOS / Linux

```bash
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
export GEMINI_API_KEY="your-api-key"
.venv/bin/python -m uvicorn main:app --host 127.0.0.1 --port 8000
```

`GEMINI_API_KEY` ใช้สำหรับฟังก์ชัน AI เท่านั้น ตั้งผ่าน environment variable โดยไม่ต้องแก้ key ใน `main.py` หากไม่ได้ตั้งค่า ยังใช้งาน API จัดการสินค้าและบิลได้

เปิดหน้าเว็บที่ <http://127.0.0.1:8000> และเอกสาร API ที่ <http://127.0.0.1:8000/docs> ตรวจสถานะได้ที่ <http://127.0.0.1:8000/health> ซึ่งควรตอบ `{"status":"healthy"}`

### เลือก Backend ให้หน้าเว็บ

เมื่อเปิดผ่าน FastAPI หน้าเว็บใช้ API ที่ origin เดียวกันอัตโนมัติ เช่น `http://127.0.0.1:8000/api` ไม่ส่งข้อมูลไป Railway โดยอัตโนมัติ

หาก deploy frontend แยกบน Vercel ให้ตั้งค่า `frontend/config.js` ก่อน deploy:

```javascript
window.LEO_API_BASE_URL = 'https://your-backend.example';
```

ไฟล์ CSS/JavaScript แยกอยู่ใน `frontend/` และให้บริการใต้ `/assets/` ทั้ง FastAPI และ Vercel

### UX/UI และประสิทธิภาพ

- เมนูด้านข้างบนคอมพิวเตอร์และเมนูด้านบนบนมือถือ พร้อมปุ่มเพิ่มสินค้า รับสินค้า และสแกนรูป
- แสดงสินค้า 24 รายการต่อหน้า พร้อมค้นหาแบบหน่วง 120 ms ลดการสร้าง DOM ระหว่างพิมพ์
- ตัดหน้าบิลและ modal ที่ซ้ำกันออก และแยก HTML, CSS และ JavaScript
- แสดงข้อผิดพลาดเมื่อเชื่อมต่อไม่ได้ ไม่ใช้ข้อมูล seed แทนข้อมูลจริงอย่างเงียบ ๆ
- แคชข้อมูล CSV และการจับคู่รูป โดยตรวจการเปลี่ยนไฟล์ก่อนใช้แคช และส่งสำเนาให้แต่ละคำขอ
- บันทึก CSV/JSON ผ่านไฟล์ชั่วคราวแล้วแทนที่ไฟล์เดิม ลดความเสี่ยงไฟล์เขียนค้าง
- เรียก Gemini ผ่าน thread pool เพื่อไม่ให้ระหว่างรอ AI บล็อก event loop

ยังใช้ FastAPI และ JavaScript โดยไม่เพิ่มขั้นตอน build ส่วนข้อมูลยังเป็น CSV/JSON จึงควรเปลี่ยนเป็นฐานข้อมูลที่รองรับ transaction หากต้องใช้หลาย worker เขียนข้อมูลพร้อมกัน

### Backend response cache

`GET /api/inventory` และ `GET /api/orders` เก็บ JSON ที่ serialize แล้วและ gzip ไว้ในหน่วยความจำ ตรวจ mtime/size ของไฟล์ก่อนใช้ทุกครั้ง จึงไม่ต้องแปลง DataFrame หรือบีบอัดซ้ำบนคำขอที่ข้อมูลไม่เปลี่ยน รองรับ `ETag` / `If-None-Match` และตอบ `304` เมื่อข้อมูลเดิม โดยใช้ `Cache-Control: private, no-cache` เพื่อให้ browser ตรวจความสดใหม่ก่อนใช้ข้อมูลซ้ำ

งานอ่านและเขียนไฟล์ทำใน FastAPI thread pool ส่วนการแก้สต็อกและบิลล็อกตลอด read-modify-write เพื่อป้องกันคำขอพร้อมกันเขียนทับกันใน worker เดียว ตรวจรายการบิลก่อนเขียนสต็อกแล้ว ระบบยังต้องใช้ Uvicorn worker เดียวสำหรับ CSV/JSON; lock นี้ไม่ใช่ transaction ข้ามหลาย process

ผล benchmark ในเครื่องกับสำเนาข้อมูล production 460 รายการ (60 คำขอหลัง warm-up): inventory median 14.035 → 0.538 ms, p95 14.331 → 0.609 ms; payload 163,677 → 15,198 bytes ด้วย gzip ตัวเลขนี้เป็น TestClient ภายในเครื่อง ไม่รวม latency เครือข่ายและ cold start รันทวนได้ด้วย `DATA_DIR=/path/to/benchmark-data .venv/bin/python tests/benchmark_backend.py`

### ตรวจสอบการทำงาน

```bash
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q tests/test_workspace.py
.venv/bin/python -m playwright install chromium
# เปิด server ที่ port 8000 ก่อน แล้วรัน:
.venv/bin/python tests/browser_smoke.py
```

การทดสอบ API ใช้ข้อมูลในโฟลเดอร์ชั่วคราว ส่วน browser smoke test อ่านข้อมูลและเปิดฟอร์มโดยไม่บันทึกสินค้า/บิล

## Environment variables และข้อมูลถาวร

| ตัวแปร | การใช้งาน |
| --- | --- |
| `GEMINI_API_KEY` | API key สำหรับ Gemini |
| `DATA_DIR` | โฟลเดอร์เก็บ `inventory.csv`, `orders.json` และ `picture/` |
| `PORT` | พอร์ตสำหรับคำสั่งเริ่มใน Dockerfile และ Procfile |

หากไม่ตั้ง `DATA_DIR` โปรแกรมจะใช้ `/data` เมื่อมีโฟลเดอร์นี้อยู่ มิฉะนั้นใช้ working directory เมื่อเริ่มใช้โฟลเดอร์ข้อมูลใหม่ โปรแกรมจะคัดลอก CSV/JSON เริ่มต้นถ้าไฟล์ปลายทางยังไม่มี และคัดลอกรูปเมื่อโฟลเดอร์รูปปลายทางว่าง

สำหรับบริการที่ filesystem ไม่ถาวร ให้เชื่อม persistent volume และตั้ง `DATA_DIR` ไปยัง volume นั้น สำรองทั้ง CSV, JSON และรูปภาพร่วมกัน

## API

ดูชื่อฟิลด์และชนิดข้อมูลฉบับเต็มที่ `/docs`

| Method | Path | การทำงาน |
| --- | --- | --- |
| GET | `/health` | ตรวจสถานะ backend |
| GET | `/api/inventory` | รายการสินค้า |
| POST | `/api/inventory` | เพิ่มสินค้า (form / multipart) |
| PUT | `/api/inventory?part_number=...` | แก้ไขสินค้า (form / multipart) |
| DELETE | `/api/inventory?part_number=...` | ลบสินค้า |
| POST | `/api/inventory/receive` | รับสินค้าเข้า (form) |
| DELETE | `/api/inventory/image?part_number=...&image_url=...` | ลบรูปสินค้า |
| POST | `/api/chat` | ถาม AI ด้วยฟิลด์ `question` |
| POST | `/api/vision` | ค้นหาจากรูปด้วยฟิลด์ `file` |
| GET | `/api/orders` | รายการบิลทั้งหมด |
| POST | `/api/orders` | สร้างบิลและตัดสต็อก (JSON) |
| PUT | `/api/orders/{bill_no}` | แก้ไขชื่อบิล (JSON) |
| PUT | `/api/orders/{bill_no}/detail` | แก้ไขชื่อ/รายการสินค้าและคำนวณยอดใหม่ (JSON) |
| DELETE | `/api/orders/{bill_no}` | ลบบิล |

ตัวอย่างข้อมูลสร้างบิล (เปลี่ยนรหัสสินค้าและจำนวนให้ตรงกับสต็อก):

```json
{
  "date": "2026-10-17",
  "name": "บิลตัวอย่าง",
  "items": [
    {
      "part_number": "FDH02032L-Y",
      "part_name": "กระจกมองข้าง",
      "quantity": 1,
      "unit_price": 1500,
      "type": "new"
    }
  ]
}
```

`type` ใช้ `new` หรือ `used` การแก้ไขรายละเอียดและลบบิลไม่ได้ปรับคืนสต็อกอัตโนมัติในโค้ดปัจจุบัน

## Deployment

- **Backend:** Dockerfile ใช้ Python 3.12 และเริ่ม Uvicorn ด้วย `PORT` (ค่าเริ่มต้น 8080) หรือใช้คำสั่งใน Procfile สำหรับ Python service
- **Frontend:** `vercel.json` ให้บริการ `frontend/index.html` เป็น static page ตั้ง `window.API_BASE_URL` ให้ตรงกับ backend ก่อน deploy
- **ข้อมูล:** ตั้ง persistent volume และ `DATA_DIR` เพื่อให้ข้อมูลคงอยู่หลัง deploy ใหม่

## ข้อจำกัดปัจจุบัน

- หน้าเว็บเรียก `/api/summary` และ `/api/edit` แต่ `main.py` ชุดนี้ยังไม่มี endpoint ทั้งสอง
- Backend ยังไม่มีระบบยืนยันตัวตน และ CORS อนุญาตทุก origin ควรเพิ่มการควบคุมการเข้าถึงก่อนเปิดให้ผู้ใช้ทั่วไปแก้ไขข้อมูล
- CSV/JSON เหมาะกับการใช้งานขนาดเล็ก การเขียนข้อมูลพร้อมกันหลายคำขอไม่มีระบบ transaction

## แก้ปัญหาเบื้องต้น

- **หน้าเว็บแสดงข้อมูลคนละชุด:** ตรวจ `window.API_BASE_URL` ว่าชี้ backend ที่ต้องการ
- **AI ใช้งานไม่ได้:** ตรวจ `GEMINI_API_KEY`, quota และข้อความผิดพลาดจาก backend
- **รูปไม่แสดง:** ตรวจไฟล์ใน `DATA_DIR/picture` และ URL ของ backend
- **ข้อมูลหายหลัง deploy:** ตรวจว่า `DATA_DIR` อยู่บน persistent volume
- **ติดตั้ง dependencies ไม่สำเร็จ:** ตรวจ Python version และใช้ Python ภายใน virtual environment
