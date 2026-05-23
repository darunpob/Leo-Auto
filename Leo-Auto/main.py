import os
import io
import shutil
import pandas as pd
from fastapi import FastAPI, Form, UploadFile, File, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from google import genai
from google.genai import types
from PIL import Image

app = FastAPI()

# --- 0. Allow CORS (อนุญาตให้หน้าเว็บ index.html เข้าถึง API ได้) ---
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# --- 1. AI & Database Setup ---
GOOGLE_API_KEY = "AIzaSyA4OMdkw35WXwVUbyLahn57BRbjyng0xlQ" # ⚠️ ระวังอย่าลืมซ่อน Key ก่อนขึ้น Production นะครับ
client = genai.Client(api_key=GOOGLE_API_KEY)

DB_FILE = "inventory.csv"
LOCATION_COLUMN = "Storage Location"
COST_COLUMN = "Cost Price"

# จำลองโฟลเดอร์รูปภาพถ้ายังไม่มี และเปิดให้หน้าเว็บดึงรูปไปแสดงได้
if not os.path.exists("picture"):
    os.makedirs("picture")
app.mount("/picture", StaticFiles(directory="picture"), name="picture")

# ฟังก์ชันจัดการ CSV
def get_db():
    if not os.path.exists(DB_FILE):
        return pd.DataFrame(columns=["Part Number", "Part Name", "Brand", "Series", "Price", "Stock", "Image_URL", LOCATION_COLUMN, COST_COLUMN])

    df = pd.read_csv(DB_FILE).fillna("")
    df['Part Number'] = df['Part Number'].astype(str)

    # helper: normalize filename matching (handles extra spaces before .png)
    def _norm(s: str) -> str:
        s = (s or "").strip()
        s = " ".join(s.split())  # collapse whitespace
        s = s.replace(" .", ".")  # "xxx .png" -> "xxx.png"
        return s

    # Build a lookup of available images once
    picture_files = []
    try:
        picture_files = os.listdir("picture")
    except Exception:
        picture_files = []

    # Pre-normalize for fuzzy match
    normalized_to_file = {}
    for fn in picture_files:
        if not fn.lower().endswith(".png"):
            continue
        normalized_to_file[_norm(fn)] = fn

    def _find_best_image(part_number: str) -> str:
        # attempt 1: exact normalized part number match
        p = _norm(part_number)
        candidates = []
        # Our real filename example: "FDH02032L-Y FDH02032R-Y .png"
        # after norm => "FDH02032L-Y FDH02032R-Y.png"
        direct = normalized_to_file.get(f"{p}.png")
        if direct:
            return f"picture/{direct}"

        # attempt 2: partial contains (handles L-only vs combined L/R)
        # choose the longest filename that contains the normalized part_number tokens
        best = None
        best_len = -1
        for norm_name, raw_fn in normalized_to_file.items():
            base = norm_name[:-4]  # remove ".png"
            if p and p in base:
                if len(base) > best_len:
                    best_len = len(base)
                    best = raw_fn

        if best:
            return f"picture/{best}"

        return ""

    # Ensure cost column exists
    if COST_COLUMN not in df.columns:
        df[COST_COLUMN] = 0

    # If Image_URL is empty, try to fill from picture folder
    if "Image_URL" in df.columns:
        mask_missing = (df["Image_URL"].astype(str).str.strip() == "") | (df["Image_URL"].astype(str).str.lower() == "nan")
        if mask_missing.any():
            for idx in df.index[mask_missing]:
                pn = str(df.at[idx, "Part Number"])
                filled = _find_best_image(pn)
                if filled:
                    df.at[idx, "Image_URL"] = filled
    else:
        df["Image_URL"] = ""

    return df

def save_db(df):
    df.to_csv(DB_FILE, index=False)

# ==========================================
# 🛠️ 2. API สำหรับจัดการสต็อก (CRUD Operations)
# ==========================================

# [READ] โหลดข้อมูลสินค้าทั้งหมด
@app.get("/api/inventory")
async def get_inventory():
    df = get_db()
    return df.to_dict(orient="records")

# [CREATE] เพิ่มสินค้าใหม่
@app.post("/api/inventory")
async def add_product(
    part_number: str = Form(...),
    part_name: str = Form(...),
    brand: str = Form(...),
    series: str = Form(...),
    price: float = Form(...),
    stock: int = Form(...),
    cost_price: float = Form(0),
    location: str = Form(""),
    image: UploadFile = File(None)
):
    df = get_db()
    if part_number in df['Part Number'].values:
        raise HTTPException(status_code=400, detail="Part Number นี้มีอยู่แล้วในระบบ!")
    
    file_path = ""
    if image and image.filename:
        ext = image.filename.split(".")[-1]
        safe_filename = f"{part_number}.{ext}"
        file_path = f"picture/{safe_filename}"
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(image.file, buffer)
            
    new_data = {
        "Part Number": part_number,
        "Part Name": part_name,
        "Brand": brand,
        "Series": series,
        "Price": price,
        "Stock": stock,
        "Image_URL": file_path,
        LOCATION_COLUMN: location,
        COST_COLUMN: cost_price
    }
    df = pd.concat([df, pd.DataFrame([new_data])], ignore_index=True)
    save_db(df)
    return {"message": "✅ เพิ่มสินค้าสำเร็จ!"}

# [UPDATE] แก้ไขสินค้าเดิม
@app.put("/api/inventory/{part_number}")
async def update_product(
    part_number: str,
    part_name: str = Form(...),
    brand: str = Form(...),
    series: str = Form(...),
    price: float = Form(...),
    stock: int = Form(...),
    cost_price: float = Form(0),
    location: str = Form(""),
    image: UploadFile = File(None)
):
    df = get_db()
    if part_number not in df['Part Number'].values:
        raise HTTPException(status_code=404, detail="ไม่พบสินค้าในระบบ")
    
    idx = df[df['Part Number'] == part_number].index[0]
    
    # อัปเดตข้อมูลทั่วไป
    df.at[idx, "Part Name"] = part_name
    df.at[idx, "Brand"] = brand
    df.at[idx, "Series"] = series
    df.at[idx, "Price"] = price
    df.at[idx, "Stock"] = stock
    df.at[idx, LOCATION_COLUMN] = location
    df.at[idx, COST_COLUMN] = cost_price
    
    # ถ้ามีการอัปโหลดรูปภาพ "ใหม่" ค่อยอัปเดตไฟล์
    if image and image.filename:
        ext = image.filename.split(".")[-1]
        safe_filename = f"{part_number}.{ext}"
        file_path = f"picture/{safe_filename}"
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(image.file, buffer)
        df.at[idx, "Image_URL"] = file_path 
        
    save_db(df)
    return {"message": f"✅ อัปเดต {part_number} สำเร็จ!"}

# [DELETE] ลบสินค้า
@app.delete("/api/inventory/{part_number}")
async def delete_product(part_number: str):
    df = get_db()
    if part_number not in df['Part Number'].values:
        raise HTTPException(status_code=404, detail="ไม่พบสินค้าในระบบ")
    
    df = df[df['Part Number'] != part_number]
    save_db(df)
    return {"message": f"🗑️ ลบ {part_number} สำเร็จ!"}


# ==========================================
# 🤖 3. API สำหรับ AI (Gemini 2.5 Flash)
# ==========================================

# [AI CHAT] แชทบอตสอบถามสต็อก
@app.post("/api/chat")
async def ai_chat(question: str = Form(...)):
    df = get_db()
    inventory_csv = df.to_csv(index=False)
    
    prompt = f"""
    You are an expert sales representative for the 'Leo Auto' truck parts store. 
    Look at the inventory data (CSV):
    {inventory_csv}
    
    Customer question: "{question}"
    
    Conditions:
    1. Check if the item is in stock. If yes, provide the name, price, and stock quantity.
    2. Keep the answer short, concise, and friendly. Answer in Thai.
    """
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash", 
            contents=prompt
        )
        return {"reply": response.text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# [AI VISION] สแกนรูปภาพหา Part Number
@app.post("/api/vision")
async def ai_vision(file: UploadFile = File(...)):
    import re
    df = get_db()
    try:
        contents = await file.read()

        # Detect mime type
        mime = file.content_type or "image/jpeg"
        if not mime or "octet" in mime:
            ext = (file.filename or "").lower().rsplit(".", 1)[-1]
            mime = {"png": "image/png", "jpg": "image/jpeg",
                    "jpeg": "image/jpeg", "webp": "image/webp",
                    "gif": "image/gif"}.get(ext, "image/jpeg")

        part_numbers = df['Part Number'].tolist()
        part_names   = df['Part Name'].tolist()
        image_part   = types.Part.from_bytes(data=contents, mime_type=mime)

        # ── CALL 1: identify the part type from the image ──
        identify_prompt = (
            "You are a truck parts expert. Look at this image and respond with "
            "ONLY a 1-line description of what type of truck part it is. "
            "Example: 'steering wheel' or 'air filter' or 'door mirror bracket'. "
            "No extra text."
        )
        id_resp = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[identify_prompt, image_part]
        )
        part_type = id_resp.text.strip().split('\n')[0].strip()

        # ── CALL 2: match against inventory with the part type hint ──
        parts_info = "\n".join(
            f"{pn}: {name}"
            for pn, name in zip(part_numbers, part_names)
        )
        match_prompt = (
            f"The truck part in the image has been identified as: {part_type}\n\n"
            f"Below is our inventory (Part Number: Part Name):\n{parts_info}\n\n"
            f"Rules:\n"
            f"1. Pick the ONE Part Number whose name best matches '{part_type}'.\n"
            f"2. Your entire response must be EXACTLY the Part Number — nothing else.\n"
            f"3. No explanation, no sentence, no markdown, no prefix.\n"
            f"4. If no match exists, respond with exactly: None\n\n"
            f"Part Number:"
        )
        match_resp = client.models.generate_content(
            model="gemini-2.5-flash",
            contents=[match_prompt, image_part]
        )
        raw = match_resp.text.strip()

        # ── Matching: normalize whitespace for robust PN comparison ──
        def _norm(s: str) -> str:
            return ' '.join(s.strip().split()).upper()

        # Build lookup: normalized PN → original PN
        norm_pn_map = {_norm(p): p.strip() for p in part_numbers}

        result = None
        # Pass 1: exact normalized match line-by-line
        for line in raw.split('\n'):
            candidate = line.strip().strip('`').strip('*').strip()
            if _norm(candidate) in norm_pn_map:
                result = norm_pn_map[_norm(candidate)]
                break

        # Pass 2: regex tokens → normalized match
        if not result:
            tokens = re.findall(r'[A-Z0-9]{2,}(?:[-\s][A-Z0-9]+)*', raw.upper())
            for tok in tokens:
                if tok in norm_pn_map:
                    result = norm_pn_map[tok]
                    break

        # Pass 3: keyword fallback — find part names that contain words from part_type
        stop = {'a','an','the','for','is','of','in','on','at','with','and','or','to'}
        pt_words = [w for w in re.sub(r'[^\w\s]','',part_type.lower()).split()
                    if len(w) >= 4 and w not in stop]
        keyword_matches = []
        if pt_words:
            for pn, name in zip(part_numbers, part_names):
                name_l = name.lower()
                if sum(1 for w in pt_words if w in name_l) >= max(1, len(pt_words)//2):
                    keyword_matches.append(pn.strip())
            keyword_matches = keyword_matches[:6]

        if result and result.lower() != "none":
            return {"match": result, "identified_as": part_type}
        elif keyword_matches:
            return {
                "match": None,
                "identified_as": part_type,
                "candidates": keyword_matches,
                "message": f"AI ระบุว่าเป็น '{part_type}' — พบสินค้าใกล้เคียง {len(keyword_matches)} รายการ"
            }
        else:
            return {"match": None, "identified_as": part_type, "message": f"AI ระบุว่าเป็น '{part_type}' แต่ไม่พบในฐานข้อมูล"}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

# ==========================================
# 🧾 4) Orders (ขายรายวัน / บิล)
# ==========================================
ORDERS_FILE = "orders.json"

def _load_orders():
    if not os.path.exists(ORDERS_FILE):
        return []
    try:
        import json
        with open(ORDERS_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, list) else []
    except Exception:
        return []

def _save_orders(bills):
    import json
    with open(ORDERS_FILE, "w", encoding="utf-8") as f:
        json.dump(bills, f, ensure_ascii=False, indent=2)

def _compute_bill_total(items):
    total = 0.0
    for it in items:
        qty = float(it.get("quantity", 0))
        unit = float(it.get("unit_price", 0))
        total += qty * unit
    return total

# [CREATE] บันทึกบิลขายรายวัน (รับ JSON)
@app.post("/api/orders")
async def create_order(data: dict):
    date = data.get("date")
    items = data.get("items", [])
    if not date:
        raise HTTPException(status_code=422, detail="Missing field: date")
    if not isinstance(items, list) or not items:
        raise HTTPException(status_code=422, detail="items must be a non-empty array")

    # normalize items
    norm_items = []
    for it in items:
        pn = it.get("part_number")
        qty = it.get("quantity")
        unit = it.get("unit_price")
        if not pn:
            raise HTTPException(status_code=422, detail="Missing item.part_number")
        try:
            qty_f = float(qty)
        except Exception:
            raise HTTPException(status_code=422, detail="Invalid item.quantity")
        try:
            unit_f = float(unit)
        except Exception:
            raise HTTPException(status_code=422, detail="Invalid item.unit_price")
        if qty_f <= 0:
            raise HTTPException(status_code=422, detail="item.quantity must be > 0")
        if unit_f < 0:
            raise HTTPException(status_code=422, detail="item.unit_price must be >= 0")
        norm_items.append({
            "part_number": pn,
            "quantity": int(qty_f) if qty_f.is_integer() else qty_f,
            "unit_price": unit_f,
            "part_name": it.get("part_name", "")
        })

    bills = _load_orders()
    next_no = 1
    if bills:
        try:
            next_no = max(int(b.get("bill_no", 0)) for b in bills) + 1
        except Exception:
            next_no = len(bills) + 1

    bill = {
        "bill_no": next_no,
        "date": date,
        "items": norm_items,
        "total": _compute_bill_total(norm_items)
    }
    bills.append(bill)
    _save_orders(bills)
    return {"message": "✅ บันทึกบิลสำเร็จ", "bill_no": next_no}

# [READ] ดึงบิลของวันที่
@app.get("/api/orders")
async def list_orders(date: str = ""):
    if not date:
        # if no date param return empty (frontend uses date)
        return {"bills": []}
    bills = _load_orders()
    filtered = [b for b in bills if str(b.get("date", "")).strip() == str(date).strip()]
    # ensure total exists
    for b in filtered:
        if "total" not in b:
            b["total"] = _compute_bill_total(b.get("items", []))
    return {"bills": filtered}

# ==========================================
# 🤖 3. API สำหรับ AI (Gemini 2.5 Flash)
# ==========================================

# [AI SUMMARY] สรุปรายงานและแจ้งเตือน
@app.get("/api/summary")
async def ai_summary():
    df = get_db()
    inventory_csv = df.to_csv(index=False)
    
    prompt = f"""
You are the ultimate inventory manager at Leo Auto.
You will be given the current stock data (CSV format):
{inventory_csv}

IMPORTANT: You do NOT have sales history/sold quantities. You must NOT claim “ขายบ่อย” using sold metrics.
Instead, infer “ควรโฟกัส” from stock level and inventory value (Price * Stock).

Return a smart, well-structured Thai report with the following sections:

1) 🚨 ของที่ควรเติม (Low stock)
- List items where Stock < 5
- Sort by Stock ascending (lowest first)
- For each item show: Part Number, Part Name, Brand, Series, Stock, Cost Price (ถ้ามี), and a short action recommendation (เช่น “ควรสั่งเพิ่ม”)
- If there are no low stock items, say so.

2) 💎 ของที่มูลค่าสูง (Inventory value)
- Compute total inventory value approximately using Price * Stock
- Also compute top 5 items by (Price * Stock)
- For each item show: Part Number, Part Name, Price, Stock, Inventory Value

3) ⚠️ เสี่ยงขาดแต่กระทบหนัก (High value + low stock)
- Find items where Stock < 5 AND (Price * Stock) is high
- Suggest a Top 3 to prioritize
- Explain in 1 line why each is risky (value + scarcity)

4) 📌 สรุปภาพรวมแบบผู้บริหาร
- Brand with most items
- Series with most items
- Total inventory value (rough)
- Count of low-stock items

Formatting rules:
- Use Emojis
- Keep it concise but specific
- Answer in Thai
- Do not include any claims about sales frequency
"""
    try:
        response = client.models.generate_content(
            model="gemini-2.5-flash", 
            contents=prompt
        )
        return {"report": response.text}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    # สั่งรัน Server ที่พอร์ต 8000
    uvicorn.run(app, host="0.0.0.0", port=8000)
